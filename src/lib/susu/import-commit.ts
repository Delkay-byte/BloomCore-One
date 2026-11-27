/**
 * The commit engine for a customer migration batch.
 *
 * Everything before this module is a rehearsal: parsing, mapping, validation and
 * duplicate classification all run against a batch that has not touched a
 * customer record. This module is the only place that writes.
 *
 * Safety rules it enforces, in order:
 *
 *   1. Authorisation already happened (the caller resolved the tenant, the
 *      writable branches and the operator). Every query here is tenant-scoped
 *      anyway, so a mistake upstream cannot cross a tenant boundary.
 *   2. The operator must have confirmed THE PLAN THEY SAW. `planHash` covers the
 *      branch mode, the column mapping and every row decision; if anything
 *      changed after the preview, the commit is refused.
 *   3. The batch must be `ready`: no row may still be waiting for a decision.
 *   4. One commit at a time, via a conditional lease. A second confirmation is
 *      either an idempotent no-op or refused, never a parallel writer.
 *   5. Each row is applied inside a transaction that also records the row's
 *      outcome, so a retry after a crash can never import the same person twice.
 *   6. A retry only reprocesses rows that are still pending or previously
 *      failed, and failed rows are retried because a per-row transaction rolls
 *      back completely.
 *
 * No financial record is created here. A migration establishes identity; it
 * never invents a contribution, a withdrawal, a commission or a card-fee
 * payment, and it never touches an existing balance.
 */

import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { createAuditLogTx } from "@/lib/audit";
import {
  ONBOARDING_LIMITS,
  allocateHumanIds,
  insertAccountWithCycle,
  insertCustomer,
  isRetryableWriteConflict,
  moneyString,
  reusableAccountNumber,
} from "@/lib/susu/onboarding";
import type {
  ColumnMapping,
  ImportResolution,
} from "@/lib/susu/import-validation";

export type ImportTx = Prisma.TransactionClient;

export const IMPORT_COMMIT_LIMITS = {
  /** Rows applied per transaction on the fast path. */
  chunkSize: 25,
  /** How long a commit lease is held before another process may take over. */
  leaseMs: 3 * 60 * 1000,
} as const;

export interface PlanRow {
  rowNumber: number;
  resolution: ImportResolution | null;
  matchedCustomerId: string | null;
  branchId: string | null;
}

/**
 * Deterministic digest of the exact plan an operator is about to approve.
 *
 * Built from a canonical string, not JSON.stringify of an object, so key order
 * and number formatting cannot make two identical plans hash differently.
 */
export function computePlanHash(input: {
  branchMode: string;
  branchId: string | null;
  mapping: ColumnMapping;
  rows: PlanRow[];
}): string {
  const mappingKey = Object.entries(input.mapping)
    .filter(([, index]) => index !== undefined && index !== null)
    .map(([key, index]) => `${key}=${index}`)
    .sort()
    .join("&");

  const rowKeys = input.rows
    .map(
      (row) =>
        `${row.rowNumber}|${row.resolution ?? "-"}|${row.matchedCustomerId ?? "-"}|${row.branchId ?? "-"}`
    )
    .sort();

  return createHash("sha256")
    .update(
      [
        "maa-cash-customer-import-v1",
        `mode=${input.branchMode}`,
        `branch=${input.branchId ?? "-"}`,
        `mapping=${mappingKey}`,
        `rows=${rowKeys.length}`,
        ...rowKeys,
      ].join("\n")
    )
    .digest("hex");
}

/** Rows that a commit may still need to write. */
export function isPendingOutcome(outcome: string | null): boolean {
  return outcome === null || outcome === "failed";
}

/**
 * Recompute the batch's aggregate counters and lifecycle state from its rows.
 *
 * Always derived from the rows themselves rather than incremented in place, so
 * an interrupted commit can never leave the batch claiming a count that does
 * not match its own rows.
 */
export function summariseRows(
  rows: {
    classification: string;
    resolution: string | null;
    outcome: string | null;
  }[]
) {
  const summary = {
    totalRows: rows.length,
    validRows: 0,
    invalidRows: 0,
    newCustomerRows: 0,
    existingCustomerRows: 0,
    duplicateRows: 0,
    reviewRows: 0,
    importedCustomers: 0,
    importedAccounts: 0,
    linkedRows: 0,
    skippedRows: 0,
    failedRows: 0,
  };

  for (const row of rows) {
    if (row.classification === "invalid") summary.invalidRows += 1;
    else summary.validRows += 1;

    if (row.classification === "new_customer") summary.newCustomerRows += 1;
    else if (row.classification === "new_account_existing_customer") {
      summary.existingCustomerRows += 1;
    } else if (row.classification === "exact_duplicate") summary.duplicateRows += 1;
    else if (
      row.classification === "possible_customer_duplicate" ||
      row.classification === "account_conflict" ||
      row.classification === "customer_conflict"
    ) {
      summary.duplicateRows += 1;
    }

    if (row.classification !== "invalid" && row.resolution === null) {
      summary.reviewRows += 1;
    }

    switch (row.outcome) {
      case "imported":
        summary.importedCustomers += 1;
        summary.importedAccounts += 1;
        break;
      case "linked":
        summary.importedAccounts += 1;
        summary.linkedRows += 1;
        break;
      case "skipped":
        summary.skippedRows += 1;
        break;
      case "failed":
        summary.failedRows += 1;
        break;
      default:
        break;
    }
  }

  /** `ready` means a commit may start: nothing still needs a human decision. */
  const ready = summary.reviewRows === 0;
  /** `done` means no row is left pending or failed. */
  const done = rows.every((row) => !isPendingOutcome(row.outcome));

  return { summary, ready, done };
}

export interface CommitOutcome {
  ok: boolean;
  error?: string;
  status?: string;
  importedCustomers?: number;
  importedAccounts?: number;
  linkedRows?: number;
  skippedRows?: number;
  failedRows?: number;
  /** True when this call was a repeat of an already-finished commit. */
  idempotent?: boolean;
}

/**
 * Apply one row inside the caller's transaction.
 *
 * Returns the outcome to persist. Throws only for an unexpected failure, which
 * rolls the row (or the whole chunk) back so the batch stays honest.
 */
async function applyRow(
  tx: ImportTx,
  params: {
    tenantId: string;
    batchId: string;
    actorId: string;
    allowedBranchIds: Set<string> | "all";
    /** True for a legacy tenant with no configured branch. */
    allowUnassignedBranch: boolean;
    row: {
      id: string;
      rowNumber: number;
      customerName: string | null;
      phone: string | null;
      email: string | null;
      externalReference: string | null;
      address: string | null;
      notes: string | null;
      accountNumber: string | null;
      dailyContribution: Prisma.Decimal | null;
      openingDate: Date | null;
      classification: string;
      resolution: string | null;
      matchedCustomerId: string | null;
      branchId: string | null;
      collectorId: string | null;
      outcomeMessage: string | null;
    };
  }
): Promise<{
  outcome: "imported" | "linked" | "skipped" | "failed";
  message: string | null;
  customerId: string | null;
  accountId: string | null;
}> {
  const {
    tenantId,
    row,
    actorId,
    allowedBranchIds,
    allowUnassignedBranch,
    batchId,
  } = params;

  // A row that failed validation is reported, never imported.
  if (row.classification === "invalid") {
    return {
      outcome: "skipped",
      message: row.outcomeMessage ?? "Not imported: the row did not pass validation.",
      customerId: null,
      accountId: null,
    };
  }

  if (row.resolution === "exclude" || row.resolution === null) {
    return {
      outcome: "skipped",
      message: row.outcomeMessage ?? "Not imported: excluded by the operator.",
      customerId: null,
      accountId: null,
    };
  }

  if (!row.customerName) {
    return {
      outcome: "failed",
      message: "The customer's name is missing.",
      customerId: null,
      accountId: null,
    };
  }
  if (row.dailyContribution === null) {
    return {
      outcome: "failed",
      message: "The daily contribution is missing.",
      customerId: null,
      accountId: null,
    };
  }

  // Branch must be explicit and inside the operator's writable scope. A row
  // that lost its branch between validation and commit fails closed, except for
  // a legacy tenant that has no branch at all (Phase 1 keeps those working).
  if (!row.branchId && !allowUnassignedBranch) {
    return {
      outcome: "failed",
      message: "No branch is attributed to this row.",
      customerId: null,
      accountId: null,
    };
  }
  if (
    row.branchId &&
    allowedBranchIds !== "all" &&
    !allowedBranchIds.has(row.branchId)
  ) {
    return {
      outcome: "failed",
      message: "You are not authorised to import into the branch on this row.",
      customerId: null,
      accountId: null,
    };
  }

  const dailyContribution = Number(row.dailyContribution);
  if (!Number.isFinite(dailyContribution) || dailyContribution <= 0) {
    return {
      outcome: "failed",
      message: "The daily contribution is not a valid amount.",
      customerId: null,
      accountId: null,
    };
  }

  // Reuse the business's own account number only when it is safe and still
  // free. Otherwise a canonical number is issued and the original is preserved.
  const requestedAccountNumber = reusableAccountNumber(row.accountNumber)
    ? row.accountNumber!.trim()
    : null;
  let canonicalAccountNumber: string | null = null;
  if (requestedAccountNumber) {
    const clash = await tx.susuAccount.findFirst({
      where: {
        OR: [
          { accountId: requestedAccountNumber },
          {
            tenantId,
            externalAccountReference: requestedAccountNumber,
          },
        ],
      },
      select: { id: true },
    });
    if (clash) {
      // Someone else claimed the number after validation. Issuing a different
      // number silently would break the customer's card, so the row stops here
      // and the operator decides.
      return {
        outcome: "failed",
        message: `Account number "${requestedAccountNumber}" was claimed by another account after validation. Re-run validation and choose how to resolve it.`,
        customerId: null,
        accountId: null,
      };
    }
    canonicalAccountNumber = requestedAccountNumber;
  }

  let customerId: string | null = null;
  let createdCustomer: { id: string; customerId: string } | null = null;

  if (row.resolution === "link_existing") {
    if (!row.matchedCustomerId) {
      return {
        outcome: "failed",
        message: "This row links to an existing customer but no match is recorded.",
        customerId: null,
        accountId: null,
      };
    }
    const customer = await tx.customer.findFirst({
      where: { id: row.matchedCustomerId, tenantId },
      select: { id: true, customerId: true, fullName: true },
    });
    if (!customer) {
      return {
        outcome: "failed",
        message: "The matched customer no longer exists in this business.",
        customerId: null,
        accountId: null,
      };
    }
    customerId = customer.id;
  } else if (row.resolution === "create_new") {
    const [allocatedCustomerId] = await allocateHumanIds(tx, "customer", 1);
    const customer = await insertCustomer(tx, {
      tenantId,
      customerId: allocatedCustomerId,
      fullName: row.customerName,
      phone: row.phone,
      email: row.email,
      address: row.address,
      notes: row.notes,
      externalReference: row.externalReference,
      registeredVia: "import",
      registeredById: actorId,
      registeredBranchId: row.branchId,
      registeredAt: row.openingDate,
    });
    customerId = customer.id;
    createdCustomer = { id: customer.id, customerId: customer.customerId };
  } else {
    return {
      outcome: "failed",
      message: "This row has an unrecognised decision.",
      customerId: null,
      accountId: null,
    };
  }

  const [allocatedAccountId] = await allocateHumanIds(tx, "account", 1);
  const account = await insertAccountWithCycle(tx, {
    tenantId,
    accountId: canonicalAccountNumber ?? allocatedAccountId,
    customerId: customerId!,
    dailyContribution,
    branchId: row.branchId,
    openingDate: row.openingDate,
    openedVia: "import",
    openedById: actorId,
    externalAccountReference: row.accountNumber,
    importBatchId: batchId,
  });

  // An explicit collector on the row is an instruction, not a guess. The
  // collector is re-verified here so a record deactivated mid-import cannot
  // receive new work.
  if (row.collectorId) {
    const collector = await tx.collector.findFirst({
      where: { id: row.collectorId, tenantId, status: "active" },
      select: { id: true },
    });
    if (collector) {
      await tx.collectorCustomerAssignment.create({
        data: {
          tenantId,
          collectorId: collector.id,
          customerId: customerId!,
          accountId: account.id,
          active: true,
          activeAccountKey: account.id,
          assignedById: actorId,
        },
      });
    }
  }

  await createAuditLogTx(tx, {
    userId: actorId,
    tenantId,
    action:
      row.resolution === "link_existing"
        ? "susu.customer_import_account_linked"
        : "susu.customer_import_customer_created",
    entityType: "customer",
    entityId: customerId!,
    details: {
      source: "import",
      batchId,
      rowNumber: row.rowNumber,
      customerId: createdCustomer?.customerId ?? null,
      accountId: account.accountId,
      dailyContribution: moneyString(dailyContribution),
      branchId: row.branchId,
      openingDate: row.openingDate ? row.openingDate.toISOString().slice(0, 10) : null,
      externalAccountReference: row.accountNumber,
    },
  });

  return {
    outcome: row.resolution === "link_existing" ? "linked" : "imported",
    message:
      row.resolution === "link_existing"
        ? "Added an account to the existing customer."
        : "Customer and account created.",
    customerId: customerId!,
    accountId: account.id,
  };
}

/** Persist one row's outcome and its append-only event. */
async function persistOutcome(
  tx: ImportTx,
  params: {
    tenantId: string;
    batchId: string;
    actorId: string;
    rowId: string;
    result: Awaited<ReturnType<typeof applyRow>>;
  }
) {
  const { tenantId, batchId, actorId, rowId, result } = params;
  await tx.customerImportRow.update({
    where: { id: rowId },
    data: {
      outcome: result.outcome,
      outcomeMessage: result.message,
      createdCustomerId: result.customerId,
      createdAccountId: result.accountId,
      committedAt: new Date(),
    },
  });
  await tx.customerImportRowEvent.create({
    data: {
      tenantId,
      batchId,
      rowId,
      kind: result.outcome,
      actorId,
      note: result.message,
    },
  });
}

/**
 * Run the commit for a batch that the caller has already authorised.
 *
 * The caller passes `allowedBranchIds` because branch authority is a session
 * concern; this engine only enforces it per row.
 */
export async function commitImportBatch(params: {
  tenantId: string;
  batchId: string;
  actorId: string;
  planHash: string;
  allowedBranchIds: Set<string> | "all";
  /** True for a legacy tenant with no configured branch. */
  allowUnassignedBranch?: boolean;
}): Promise<CommitOutcome> {
  const {
    tenantId,
    batchId,
    actorId,
    planHash,
    allowedBranchIds,
    allowUnassignedBranch = false,
  } = params;

  const batch = await db.customerImportBatch.findFirst({
    where: { id: batchId, tenantId },
    include: {
      rows: {
        orderBy: { rowNumber: "asc" },
      },
    },
  });
  if (!batch) return { ok: false, error: "Import batch not found." };

  if (batch.status === "cancelled") {
    return { ok: false, error: "This import was cancelled and cannot be committed." };
  }
  if (batch.status === "committed") {
    // A repeat confirmation is a no-op, not an error and never a second import.
    return {
      ok: true,
      idempotent: true,
      status: batch.status,
      importedCustomers: batch.importedCustomers,
      importedAccounts: batch.importedAccounts,
      linkedRows: batch.linkedRows,
      skippedRows: batch.skippedRows,
      failedRows: batch.failedRows,
    };
  }

  const mapping = (batch.columnMapping
    ? (JSON.parse(batch.columnMapping) as ColumnMapping)
    : {}) satisfies ColumnMapping;

  const expectedHash = computePlanHash({
    branchMode: batch.branchMode,
    branchId: batch.branchId,
    mapping,
    rows: batch.rows.map((row) => ({
      rowNumber: row.rowNumber,
      resolution: (row.resolution as ImportResolution | null) ?? null,
      matchedCustomerId: row.matchedCustomerId,
      branchId: row.branchId,
    })),
  });

  if (expectedHash !== planHash) {
    return {
      ok: false,
      error:
        "The plan changed since you reviewed it. Re-open the preview and confirm again.",
    };
  }

  const { summary, ready } = summariseRows(batch.rows);
  if (!ready) {
    return {
      ok: false,
      error: `${summary.reviewRows} row(s) still need a decision before this import can run.`,
    };
  }

  // Conditional lease acquisition: only one caller can move the batch out of a
  // committable state, and an expired lease may be reclaimed after a crash.
  const now = new Date();
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const leaseUntil = new Date(now.getTime() + IMPORT_COMMIT_LIMITS.leaseMs);

  const acquired = await db.customerImportBatch.updateMany({
    where: {
      id: batchId,
      tenantId,
      status: { in: ["ready", "validated", "partially_committed", "failed"] },
      OR: [{ commitLeaseUntil: null }, { commitLeaseUntil: { lt: now } }],
    },
    data: {
      status: "committing",
      commitToken: token,
      commitStartedAt: now,
      commitLeaseUntil: leaseUntil,
      confirmedAt: batch.confirmedAt ?? now,
      confirmedById: batch.confirmedById ?? actorId,
      committedById: actorId,
      failureReason: null,
    },
  });

  if (acquired.count === 0) {
    const current = await db.customerImportBatch.findFirst({
      where: { id: batchId, tenantId },
      select: { status: true, commitLeaseUntil: true },
    });
    if (current?.status === "committing") {
      return {
        ok: false,
        error:
          "This import is already running. Wait for it to finish before trying again.",
      };
    }
    return {
      ok: false,
      error: "This import is no longer ready to be committed. Reload and review it again.",
    };
  }

  const pending = batch.rows.filter((row) => isPendingOutcome(row.outcome));
  let imported = 0;

  try {
    for (let start = 0; start < pending.length; start += IMPORT_COMMIT_LIMITS.chunkSize) {
      const chunk = pending.slice(start, start + IMPORT_COMMIT_LIMITS.chunkSize);

      // Fast path: the whole chunk in one transaction.
      try {
        await db.$transaction(
          async (tx) => {
            for (const row of chunk) {
              const result = await applyRow(tx, {
                tenantId,
                batchId,
                actorId,
                allowedBranchIds,
                allowUnassignedBranch,
                row,
              });
              await persistOutcome(tx, {
                tenantId,
                batchId,
                actorId,
                rowId: row.id,
                result,
              });
            }
          },
          { timeout: 60_000, maxWait: 15_000 }
        );
      } catch (chunkError) {
        // Slow path: one bad row must not hide the fate of its neighbours.
        for (const row of chunk) {
          let applied = false;
          for (let attempt = 0; attempt < 2 && !applied; attempt++) {
            try {
              await db.$transaction(
                async (tx) => {
                  const result = await applyRow(tx, {
                    tenantId,
                    batchId,
                    actorId,
                    allowedBranchIds,
                    allowUnassignedBranch,
                    row,
                  });
                  await persistOutcome(tx, {
                    tenantId,
                    batchId,
                    actorId,
                    rowId: row.id,
                    result,
                  });
                },
                { timeout: 30_000, maxWait: 15_000 }
              );
              applied = true;
            } catch (rowError) {
              if (attempt === 0 && isRetryableWriteConflict(rowError)) continue;
              await db.$transaction(async (tx) => {
                await persistOutcome(tx, {
                  tenantId,
                  batchId,
                  actorId,
                  rowId: row.id,
                  result: {
                    outcome: "failed",
                    message:
                      "This row could not be written. Nothing was created for it; correct the row and retry.",
                    customerId: null,
                    accountId: null,
                  },
                });
              });
              applied = true;
            }
          }
        }
        // Keep the reason for the operator without leaking a driver message.
        if (process.env.NODE_ENV !== "production") {
          console.error(
            "[customer-import] chunk fell back to per-row writes:",
            chunkError instanceof Error ? chunkError.message.slice(0, 200) : chunkError
          );
        }
      }

      // Refresh counters and extend the lease after every chunk so a long
      // import does not lose its lease halfway through.
      const rows = await db.customerImportRow.findMany({
        where: { batchId },
        select: { classification: true, resolution: true, outcome: true },
      });
      const after = summariseRows(rows);
      imported = after.summary.importedCustomers;
      await db.customerImportBatch.update({
        where: { id: batchId },
        data: {
          ...after.summary,
          commitLeaseUntil: new Date(Date.now() + IMPORT_COMMIT_LIMITS.leaseMs),
        },
      });
    }

    const finalRows = await db.customerImportRow.findMany({
      where: { batchId },
      select: { classification: true, resolution: true, outcome: true },
    });
    const finalSummary = summariseRows(finalRows);
    const finalStatus =
      finalSummary.summary.failedRows > 0
        ? imported > 0
          ? "partially_committed"
          : "failed"
        : "committed";

    const finishedAt = new Date();
    await db.customerImportBatch.update({
      where: { id: batchId },
      data: {
        ...finalSummary.summary,
        status: finalStatus,
        committedAt: finalStatus === "committed" ? finishedAt : null,
        commitLeaseUntil: null,
        // A finished import no longer needs the original spreadsheet text. The
        // parsed rows keep the evidence; dropping the raw file reduces the
        // personal data kept after the migration is done.
        sourceText: finalStatus === "committed" ? null : undefined,
        failureReason:
          finalStatus === "committed"
            ? null
            : `${finalSummary.summary.failedRows} row(s) could not be written. Correct them and commit again.`,
      },
    });

    await createAuditLogEntry({
      tenantId,
      actorId,
      batchId,
      rows: finalSummary.summary,
      status: finalStatus,
    });

    return {
      ok: true,
      status: finalStatus,
      importedCustomers: finalSummary.summary.importedCustomers,
      importedAccounts: finalSummary.summary.importedAccounts,
      linkedRows: finalSummary.summary.linkedRows,
      skippedRows: finalSummary.summary.skippedRows,
      failedRows: finalSummary.summary.failedRows,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 200) : "unknown error";
    if (process.env.NODE_ENV !== "production") {
      console.error("[customer-import] commit aborted:", message);
    }
    await db.customerImportBatch.update({
      where: { id: batchId },
      data: {
        status: imported > 0 ? "partially_committed" : "failed",
        commitLeaseUntil: null,
        failureReason:
          "The import stopped unexpectedly. Rows already written are kept; run the import again to continue.",
      },
    });
    return {
      ok: false,
      error:
        "The import stopped unexpectedly. Rows already written are kept; run the import again to continue.",
    };
  }
}

/** Batch-level audit entry, written outside the row transactions. */
async function createAuditLogEntry(params: {
  tenantId: string;
  actorId: string;
  batchId: string;
  rows: Record<string, number>;
  status: string;
}) {
  const { createAuditLog } = await import("@/lib/audit");
  await createAuditLog({
    userId: params.actorId,
    tenantId: params.tenantId,
    action: "susu.customer_import_committed",
    entityType: "customer_import_batch",
    entityId: params.batchId,
    details: { status: params.status, ...params.rows },
  });
}

/** Row limits are re-exported so callers do not import two modules for one value. */
export const IMPORT_ROW_LIMITS = {
  maxRows: 5_000,
  maxNameLength: ONBOARDING_LIMITS.nameMax,
} as const;
