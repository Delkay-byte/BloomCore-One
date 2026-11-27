"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getTenantContext, type TenantContext } from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";
import {
  isBranchlessTenant,
  resolveBranchScope,
  resolveWriteBranch,
} from "@/lib/branch";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { buildCsv } from "@/lib/csv";
import {
  CSV_LIMITS,
  hashFileBytes,
  hashHeaderRow,
  parseCsv,
} from "@/lib/susu/import-csv";
import {
  allowedResolutions,
  autoDetectMapping,
  classifyRows,
  IMPORT_CLASSIFICATION_LABELS,
  IMPORT_FIELDS,
  IMPORT_RESOLUTION_LABELS,
  readCell,
  validateMapping,
  type ColumnMapping,
  type ImportClassification,
  type ImportReferenceData,
  type ImportResolution,
} from "@/lib/susu/import-validation";
import {
  commitImportBatch,
  computePlanHash,
  summariseRows,
} from "@/lib/susu/import-commit";
import { ONBOARDING_LIMITS, cleanText, emailKey } from "@/lib/susu/onboarding";

export interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

/**
 * Resolve the operator for an import action.
 *
 * Import changes customer identity in bulk, so it is an administrator
 * capability. Collectors register one person at a time through their own action
 * and never receive the bulk surface. The response is returned rather than
 * redirected so a failed import reports a reason instead of bouncing the tab.
 */
async function resolveImportActor(): Promise<
  { ok: true; ctx: TenantContext } | { ok: false; error: string }
> {
  const ctx =
    (await getTenantContext("admin", "susu")) ??
    (await getTenantContext("susu", "susu")) ??
    (await getTenantContext("momo", "susu"));
  if (!ctx) return { ok: false, error: "Please sign in again." };
  if (ctx.role !== "admin") {
    return {
      ok: false,
      error: "Only an administrator can import customers in bulk.",
    };
  }
  return { ok: true, ctx };
}

/** Branch authority for a bulk action, expressed as an explicit allow-list. */
async function resolveImportBranchScope(ctx: TenantContext): Promise<{
  allowed: Set<string> | "all";
  branchless: boolean;
}> {
  const scope = await resolveBranchScope(ctx);
  const branchless = await isBranchlessTenant(ctx);
  return {
    allowed: scope.kind === "all" ? "all" : new Set(scope.branchIds),
    branchless,
  };
}

async function rateLimit(
  ctx: TenantContext,
  scope: string
): Promise<string | null> {
  const result = await consumeRateLimit(
    scope,
    ctx.userId,
    RATE_LIMITS.adminSensitive
  );
  return result.allowed
    ? null
    : `Too many import actions. Try again in ${result.retryAfterSeconds} seconds.`;
}

// ---------------------------------------------------------------------------
// Stage 1 — upload
// ---------------------------------------------------------------------------

/**
 * Read an uploaded CSV into a new staged batch.
 *
 * The file is re-validated for size, extension and content here rather than
 * being trusted because a browser said "text/csv". A file already uploaded to
 * this business resumes its existing batch instead of creating a second one,
 * so a double-click or a retried request cannot stage the same migration twice.
 */
export async function createImportBatch(
  formData: FormData
): Promise<ActionResponse> {
  const actor = await resolveImportActor();
  if (!actor.ok) return { success: false, error: actor.error };
  const { ctx } = actor;

  const limited = await rateLimit(ctx, "susu:import:create");
  if (limited) return { success: false, error: limited };

  const name = cleanText(formData.get("name"), 120);
  if (!name || name.length < 3) {
    return {
      success: false,
      error: "Give this import a name of at least 3 characters so you can find it later.",
    };
  }

  const requestedBranchId = cleanText(formData.get("branchId"), 64);
  const branchId = await resolveWriteBranch(ctx, requestedBranchId);
  if (requestedBranchId && !branchId) {
    return {
      success: false,
      error: "You are not authorised to import into that branch.",
    };
  }

  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return { success: false, error: "Choose a CSV file to import." };
  }
  const upload = file as File;
  if (upload.size === 0) {
    return { success: false, error: "The selected file is empty." };
  }
  if (upload.size > CSV_LIMITS.maxChars) {
    return {
      success: false,
      error: "The file is larger than 4 MB. Split it into smaller batches.",
    };
  }
  if (!/\.csv$/i.test(upload.name)) {
    return {
      success: false,
      error:
        "Only .csv files can be imported. Open the spreadsheet in Excel or Google Sheets and use \"Save as CSV\".",
    };
  }

  const bytes = new Uint8Array(await upload.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const parsed = parseCsv(text);
  if (!parsed.ok) {
    return { success: false, error: parsed.error };
  }
  if (parsed.data.truncatedRows > 0) {
    return {
      success: false,
      error: `This file has ${parsed.data.rows.length + parsed.data.truncatedRows} rows. The maximum per import is ${CSV_LIMITS.maxRows}. Split it into smaller files.`,
    };
  }
  if (parsed.data.rows.length === 0) {
    return {
      success: false,
      error: "The file has column headings but no customer rows.",
    };
  }

  const fileHash = await hashFileBytes(bytes);
  const existing = await db.customerImportBatch.findFirst({
    where: { tenantId: ctx.tenantId, fileHash },
    select: { id: true, status: true, name: true },
  });
  if (existing) {
    return {
      success: true,
      data: {
        batchId: existing.id,
        resumed: true,
        status: existing.status,
        message: `This exact file was already uploaded as "${existing.name}". Continuing that import instead of creating a second one.`,
      },
    };
  }

  const headerHash = await hashHeaderRow(parsed.data.headers);
  const suggestedMapping = autoDetectMapping(parsed.data.headers);
  const branchMode = suggestedMapping.branchRef !== undefined ? "row_column" : "single_branch";

  const batch = await db.customerImportBatch.create({
    data: {
      tenantId: ctx.tenantId,
      branchId: branchMode === "single_branch" ? branchId : branchId,
      branchMode,
      name,
      sourceFormat: "csv",
      fileName: cleanText(upload.name, 200) ?? "upload.csv",
      fileHash,
      fileSizeBytes: upload.size,
      sourceText: text,
      headerHash,
      headers: JSON.stringify(parsed.data.headers),
      columnMapping: JSON.stringify(suggestedMapping),
      status: "staged",
      totalRows: parsed.data.rows.length,
      initiatedById: ctx.userId,
    },
  });

  await createAuditLog({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    branchId,
    action: "susu.customer_import_batch_created",
    entityType: "customer_import_batch",
    entityId: batch.id,
    details: {
      name,
      fileName: batch.fileName,
      totalRows: parsed.data.rows.length,
      branchMode,
      branchId,
      fileHash,
    },
  });

  revalidatePath("/susu/admin/imports");

  return {
    success: true,
    data: {
      batchId: batch.id,
      resumed: false,
      headers: parsed.data.headers,
      mapping: suggestedMapping,
      branchMode,
      totalRows: parsed.data.rows.length,
      delimiter: parsed.data.delimiter,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 2/3 — mapping and validation
// ---------------------------------------------------------------------------

/**
 * Validate a batch: apply a column mapping, classify every row and store the
 * decisions. Re-running is safe and replaces the staged rows, but only while
 * nothing has been committed.
 */
export async function validateImportBatch(params: {
  batchId: string;
  mapping?: ColumnMapping;
}): Promise<ActionResponse> {
  const actor = await resolveImportActor();
  if (!actor.ok) return { success: false, error: actor.error };
  const { ctx } = actor;

  const limited = await rateLimit(ctx, "susu:import:validate");
  if (limited) return { success: false, error: limited };

  const batch = await db.customerImportBatch.findFirst({
    where: { id: params.batchId, tenantId: ctx.tenantId },
  });
  if (!batch) return { success: false, error: "Import batch not found." };
  if (batch.status === "committing" || batch.status === "committed") {
    return {
      success: false,
      error: "This import has already been committed and can no longer be re-validated.",
    };
  }
  if (batch.status === "partially_committed") {
    return {
      success: false,
      error:
        "This import has already written some records. Review the failed rows and commit again instead of re-validating.",
    };
  }
  if (!batch.sourceText) {
    return {
      success: false,
      error: "The original file is no longer available for this import.",
    };
  }

  const parsed = parseCsv(batch.sourceText);
  if (!parsed.ok) return { success: false, error: parsed.error };

  const headerCheck = await hashHeaderRow(parsed.data.headers);
  if (headerCheck !== batch.headerHash) {
    return {
      success: false,
      error: "The stored file could not be read consistently. Upload it again.",
    };
  }

  const submitted = params.mapping
    ? validateMapping(params.mapping, parsed.data.headers.length)
    : validateMapping(
        JSON.parse(batch.columnMapping ?? "{}") as ColumnMapping,
        parsed.data.headers.length
      );
  if (!submitted.ok) return { success: false, error: submitted.error };
  const mapping = submitted.mapping;

  // The branch source decides the mode. If a branch column is mapped it must be
  // authoritative; otherwise the batch's chosen branch applies to every row.
  const branchMode = mapping.branchRef !== undefined ? "row_column" : "single_branch";
  if (branchMode === "single_branch") {
    const branchOk = await resolveWriteBranch(ctx, batch.branchId);
    if (!branchOk) {
      const branchless = await isBranchlessTenant(ctx);
      if (!branchless) {
        return {
          success: false,
          error:
            "Choose a destination branch for this import, or map a branch column so each row can name its own branch.",
        };
      }
    }
  }

  const scope = await resolveImportBranchScope(ctx);

  // Reference data is loaded once per batch, not once per row: a 5,000 row file
  // must not become 20,000 queries.
  const branches = await db.location.findMany({
    where: { tenantId: ctx.tenantId },
    select: { id: true, code: true, name: true, status: true },
  });
  const collectorRows = await db.collector.findMany({
    where: { tenantId: ctx.tenantId },
    select: {
      id: true,
      branchId: true,
      status: true,
      user: { select: { fullName: true, email: true } },
    },
  });
  const customers = await db.customer.findMany({
    where: { tenantId: ctx.tenantId },
    select: {
      id: true,
      customerId: true,
      fullName: true,
      phone: true,
      email: true,
      externalReference: true,
    },
  });
  const accounts = await db.susuAccount.findMany({
    where: { tenantId: ctx.tenantId },
    select: {
      id: true,
      accountId: true,
      externalAccountReference: true,
      customerId: true,
    },
  });

  // E-mail is globally unique in MaaCash. Only the addresses that actually
  // appear in this file are checked, so the query stays bounded.
  const fileEmails = new Set<string>();
  for (const row of parsed.data.rows) {
    const email = emailKey(readCell(row, mapping, "email"));
    if (email) fileEmails.add(email);
  }
  const emailVariants = new Set<string>();
  for (const email of fileEmails) {
    emailVariants.add(email);
    emailVariants.add(email.toUpperCase());
  }
  const emailHolders = fileEmails.size
    ? await db.customer.findMany({
        where: { email: { in: [...emailVariants] } },
        select: { email: true },
      })
    : [];
  const emailsInUse = new Set(
    emailHolders
      .map((customer) => emailKey(customer.email))
      .filter((value): value is string => Boolean(value))
  );

  const reference: ImportReferenceData = {
    branches,
    collectors: collectorRows
      .filter(
        (collector) =>
          scope.allowed === "all" ||
          !collector.branchId ||
          scope.allowed.has(collector.branchId)
      )
      .map((collector) => ({
        id: collector.id,
        fullName: collector.user.fullName,
        email: collector.user.email,
        branchId: collector.branchId,
        status: collector.status,
      })),
    customers,
    accounts,
  };

  const { rows, counts } = classifyRows(
    parsed.data,
    {
      branchMode,
      defaultBranchId: branchMode === "single_branch" ? batch.branchId : null,
      mapping,
      allowedBranchIds: scope.allowed,
      branchlessTenant: scope.branchless,
    },
    reference,
    emailsInUse
  );

  await db.$transaction(async (tx) => {
    // Re-validation replaces the staging rows. Only rows, never committed
    // records: nothing outside the batch is touched.
    await tx.customerImportRowEvent.deleteMany({ where: { batchId: batch.id } });
    await tx.customerImportRow.deleteMany({ where: { batchId: batch.id } });

    // Insert in bounded slices so a 5,000 row file does not build one enormous
    // statement that exceeds a parameter limit.
    const sliceSize = 200;
    for (let start = 0; start < rows.length; start += sliceSize) {
      const slice = rows.slice(start, start + sliceSize);
      await tx.customerImportRow.createMany({
        data: slice.map((row) => ({
          tenantId: ctx.tenantId,
          batchId: batch.id,
          rowNumber: row.rowNumber,
          rawRow: row.rawRow,
          customerName: row.customerName,
          phone: row.phone,
          phoneNormalized: row.phoneNormalized,
          email: row.email,
          externalReference: row.externalReference,
          address: row.address,
          notes: row.notes,
          accountNumber: row.accountNumber,
          dailyContribution: row.dailyContribution,
          openingDate: row.openingDate,
          branchRef: row.branchRef,
          collectorRef: row.collectorRef,
          classification: row.classification,
          issues: row.issues.length ? JSON.stringify(row.issues) : null,
          matchReasons: row.matchReasons.length
            ? JSON.stringify(row.matchReasons)
            : null,
          matchedCustomerId: row.matchedCustomerId,
          matchedAccountId: row.matchedAccountId,
          branchId: row.branchId,
          collectorId: row.collectorId,
          resolution: row.resolution,
          resolvedAt: row.resolution ? new Date() : null,
          resolvedById: row.resolution ? ctx.userId : null,
        })),
      });
    }

    const summary = summariseRows(
      rows.map((row) => ({
        classification: row.classification,
        resolution: row.resolution,
        outcome: null,
      }))
    );

    await tx.customerImportBatch.update({
      where: { id: batch.id },
      data: {
        branchMode,
        columnMapping: JSON.stringify(mapping),
        status: summary.ready ? "ready" : "validated",
        validatedAt: new Date(),
        confirmedAt: null,
        confirmedById: null,
        commitToken: null,
        failureReason: null,
        ...summary.summary,
      },
    });
  });

  await createAuditLog({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    branchId: batch.branchId,
    action: "susu.customer_import_validated",
    entityType: "customer_import_batch",
    entityId: batch.id,
    details: {
      totalRows: rows.length,
      branchMode,
      mapping,
      counts,
    },
  });

  revalidatePath("/susu/admin/imports");
  revalidatePath(`/susu/admin/imports/${batch.id}`);

  return {
    success: true,
    data: { batchId: batch.id, counts, totalRows: rows.length, branchMode },
  };
}

// ---------------------------------------------------------------------------
// Stage 4 — decisions
// ---------------------------------------------------------------------------

/**
 * Record the operator's decisions for rows that needed one.
 *
 * Every accepted decision appends an event, so re-deciding a row never erases
 * the earlier one — that history is the evidence of who decided what.
 */
export async function resolveImportRows(params: {
  batchId: string;
  resolutions: { rowNumber: number; resolution: ImportResolution; note?: string }[];
}): Promise<ActionResponse> {
  const actor = await resolveImportActor();
  if (!actor.ok) return { success: false, error: actor.error };
  const { ctx } = actor;

  const limited = await rateLimit(ctx, "susu:import:resolve");
  if (limited) return { success: false, error: limited };

  if (!Array.isArray(params.resolutions) || params.resolutions.length === 0) {
    return { success: false, error: "No decisions were submitted." };
  }
  if (params.resolutions.length > 1_000) {
    return {
      success: false,
      error: "Submit at most 1,000 decisions at a time.",
    };
  }

  const batch = await db.customerImportBatch.findFirst({
    where: { id: params.batchId, tenantId: ctx.tenantId },
    select: { id: true, status: true, branchId: true },
  });
  if (!batch) return { success: false, error: "Import batch not found." };
  if (
    batch.status === "committing" ||
    batch.status === "committed" ||
    batch.status === "cancelled"
  ) {
    return {
      success: false,
      error: "This import can no longer be changed.",
    };
  }

  const rows = await db.customerImportRow.findMany({
    where: { batchId: batch.id, tenantId: ctx.tenantId },
    select: {
      id: true,
      rowNumber: true,
      classification: true,
      resolution: true,
      matchedCustomerId: true,
    },
  });
  const byNumber = new Map(rows.map((row) => [row.rowNumber, row]));

  const updates: {
    row: (typeof rows)[number];
    resolution: ImportResolution;
    note: string | null;
  }[] = [];

  for (const submitted of params.resolutions) {
    const row = byNumber.get(submitted.rowNumber);
    if (!row) {
      return {
        success: false,
        error: `Row ${submitted.rowNumber} is not part of this import.`,
      };
    }
    const allowed = allowedResolutions(
      row.classification as ImportClassification
    );
    if (!allowed.includes(submitted.resolution)) {
      return {
        success: false,
        error: `Row ${row.rowNumber}: "${submitted.resolution}" is not a valid decision for ${IMPORT_CLASSIFICATION_LABELS[row.classification as ImportClassification]}.`,
      };
    }
    if (
      submitted.resolution === "link_existing" &&
      !row.matchedCustomerId
    ) {
      return {
        success: false,
        error: `Row ${row.rowNumber} has no matched customer to link to.`,
      };
    }
    updates.push({
      row,
      resolution: submitted.resolution,
      note: cleanText(submitted.note, 240),
    });
  }

  await db.$transaction(async (tx) => {
    for (const update of updates) {
      await tx.customerImportRow.update({
        where: { id: update.row.id },
        data: {
          resolution: update.resolution,
          resolvedById: ctx.userId,
          resolvedAt: new Date(),
          resolutionNote: update.note,
        },
      });
      await tx.customerImportRowEvent.create({
        data: {
          tenantId: ctx.tenantId,
          batchId: batch.id,
          rowId: update.row.id,
          kind: "resolved",
          actorId: ctx.userId,
          fromResolution: update.row.resolution,
          toResolution: update.resolution,
          note: update.note,
        },
      });
    }

    const refreshed = await tx.customerImportRow.findMany({
      where: { batchId: batch.id },
      select: { classification: true, resolution: true, outcome: true },
    });
    const summary = summariseRows(refreshed);
    await tx.customerImportBatch.update({
      where: { id: batch.id },
      data: {
        status: summary.ready ? "ready" : "validated",
        ...summary.summary,
      },
    });
  });

  await createAuditLog({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    branchId: batch.branchId,
    action: "susu.customer_import_rows_resolved",
    entityType: "customer_import_batch",
    entityId: batch.id,
    details: {
      decisions: updates.map((update) => ({
        rowNumber: update.row.rowNumber,
        from: update.row.resolution,
        to: update.resolution,
      })),
    },
  });

  revalidatePath(`/susu/admin/imports/${batch.id}`);
  return { success: true, data: { updated: updates.length } };
}

// ---------------------------------------------------------------------------
// Stage 5 — preview
// ---------------------------------------------------------------------------

export interface ImportPreviewRow {
  rowNumber: number;
  customerName: string | null;
  phone: string | null;
  externalReference: string | null;
  accountNumber: string | null;
  dailyContribution: number | null;
  openingDate: string | null;
  branchId: string | null;
  branchLabel: string | null;
  classification: ImportClassification;
  classificationLabel: string;
  resolution: ImportResolution | null;
  resolutionLabel: string | null;
  issues: { code: string; message: string; severity: string }[];
  matchReasons: string[];
  matchedCustomerName: string | null;
  outcome: string | null;
  outcomeMessage: string | null;
}

/**
 * The review payload: the plan, its digest and the rows, so the operator sees
 * exactly what will be written before they confirm it.
 */
export async function getImportPreview(params: {
  batchId: string;
  filter?: "all" | "review" | "invalid" | "duplicate";
  limit?: number;
}): Promise<ActionResponse> {
  const actor = await resolveImportActor();
  if (!actor.ok) return { success: false, error: actor.error };
  const { ctx } = actor;

  const batch = await db.customerImportBatch.findFirst({
    where: { id: params.batchId, tenantId: ctx.tenantId },
  });
  if (!batch) return { success: false, error: "Import batch not found." };

  const mapping = (batch.columnMapping
    ? JSON.parse(batch.columnMapping)
    : {}) as ColumnMapping;

  const allRows = await db.customerImportRow.findMany({
    where: { batchId: batch.id, tenantId: ctx.tenantId },
    select: {
      rowNumber: true,
      resolution: true,
      matchedCustomerId: true,
      branchId: true,
      classification: true,
      outcome: true,
    },
  });

  const planHash = computePlanHash({
    branchMode: batch.branchMode,
    branchId: batch.branchId,
    mapping,
    rows: allRows.map((row) => ({
      rowNumber: row.rowNumber,
      resolution: (row.resolution as ImportResolution | null) ?? null,
      matchedCustomerId: row.matchedCustomerId,
      branchId: row.branchId,
    })),
  });

  const { summary, ready } = summariseRows(allRows);

  const branches = await db.location.findMany({
    where: { tenantId: ctx.tenantId },
    select: { id: true, name: true, code: true },
  });
  const branchNames = new Map(branches.map((branch) => [branch.id, branch.name]));

  const filter = params.filter ?? "all";
  const where = {
    batchId: batch.id,
    tenantId: ctx.tenantId,
    ...(filter === "review"
      ? { classification: { not: "invalid" }, resolution: null }
      : {}),
    ...(filter === "invalid" ? { classification: "invalid" } : {}),
    ...(filter === "duplicate"
      ? {
          classification: {
            in: [
              "exact_duplicate",
              "possible_customer_duplicate",
              "account_conflict",
              "customer_conflict",
            ],
          },
        }
      : {}),
  };

  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const rows = await db.customerImportRow.findMany({
    where,
    orderBy: { rowNumber: "asc" },
    take: limit,
  });
  const filteredTotal = await db.customerImportRow.count({ where });

  const matchedIds = [
    ...new Set(
      rows
        .map((row) => row.matchedCustomerId)
        .filter((value): value is string => Boolean(value))
    ),
  ];
  const matchedCustomers = matchedIds.length
    ? await db.customer.findMany({
        where: { id: { in: matchedIds }, tenantId: ctx.tenantId },
        select: { id: true, fullName: true, customerId: true },
      })
    : [];
  const matchedNames = new Map(
    matchedCustomers.map((customer) => [
      customer.id,
      `${customer.fullName} (${customer.customerId})`,
    ])
  );

  const previewRows: ImportPreviewRow[] = rows.map((row) => ({
    rowNumber: row.rowNumber,
    customerName: row.customerName,
    phone: row.phone,
    externalReference: row.externalReference,
    accountNumber: row.accountNumber,
    dailyContribution: row.dailyContribution === null ? null : Number(row.dailyContribution),
    openingDate: row.openingDate ? row.openingDate.toISOString().slice(0, 10) : null,
    branchId: row.branchId,
    branchLabel: row.branchId ? branchNames.get(row.branchId) ?? null : "Unassigned",
    classification: row.classification as ImportClassification,
    classificationLabel:
      IMPORT_CLASSIFICATION_LABELS[row.classification as ImportClassification] ??
      row.classification,
    resolution: (row.resolution as ImportResolution | null) ?? null,
    resolutionLabel: row.resolution
      ? IMPORT_RESOLUTION_LABELS[row.resolution as ImportResolution] ?? row.resolution
      : null,
    issues: row.issues
      ? (JSON.parse(row.issues) as { code: string; message: string; severity: string }[])
      : [],
    matchReasons: row.matchReasons ? (JSON.parse(row.matchReasons) as string[]) : [],
    matchedCustomerName: row.matchedCustomerId
      ? matchedNames.get(row.matchedCustomerId) ?? null
      : null,
    outcome: row.outcome,
    outcomeMessage: row.outcomeMessage,
  }));

  return {
    success: true,
    data: {
      batch: {
        id: batch.id,
        name: batch.name,
        fileName: batch.fileName,
        status: batch.status,
        branchMode: batch.branchMode,
        branchId: batch.branchId,
        branchName: batch.branchId ? branchNames.get(batch.branchId) ?? null : null,
        headers: JSON.parse(batch.headers) as string[],
        mapping,
        totalRows: batch.totalRows,
        validatedAt: batch.validatedAt,
        confirmedAt: batch.confirmedAt,
        committedAt: batch.committedAt,
        failureReason: batch.failureReason,
      },
      planHash,
      ready: ready && batch.status !== "committed",
      summary,
      rows: previewRows,
      filteredTotal,
      limit,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 6 — confirmation and commit
// ---------------------------------------------------------------------------

/**
 * Commit a batch.
 *
 * `planHash` must be the digest the operator saw. If anything changed after
 * they looked, the commit is refused rather than applying a plan nobody
 * approved.
 */
export async function confirmImportBatch(params: {
  batchId: string;
  planHash: string;
  confirmText: string;
}): Promise<ActionResponse> {
  const actor = await resolveImportActor();
  if (!actor.ok) return { success: false, error: actor.error };
  const { ctx } = actor;

  const limited = await rateLimit(ctx, "susu:import:commit");
  if (limited) return { success: false, error: limited };

  if ((params.confirmText ?? "").trim().toUpperCase() !== "IMPORT") {
    return {
      success: false,
      error: `Type IMPORT to confirm that you have reviewed this migration.`,
    };
  }
  if (!params.planHash) {
    return {
      success: false,
      error: "The import plan digest is missing. Reload the preview and try again.",
    };
  }

  const batch = await db.customerImportBatch.findFirst({
    where: { id: params.batchId, tenantId: ctx.tenantId },
    select: { id: true, status: true, branchId: true, commitToken: true },
  });
  if (!batch) return { success: false, error: "Import batch not found." };
  if (batch.status === "committed") {
    return {
      success: true,
      data: { status: "committed", alreadyCommitted: true },
    };
  }
  if (batch.status === "committing") {
    return {
      success: false,
      error:
        "This import is already running. Wait for it to finish before trying again.",
    };
  }
  if (batch.status === "cancelled") {
    return { success: false, error: "This import was cancelled." };
  }
  if (
    batch.status !== "ready" &&
    batch.status !== "validated" &&
    batch.status !== "partially_committed" &&
    batch.status !== "failed"
  ) {
    return {
      success: false,
      error:
        "Validate this import and resolve every flagged row before committing.",
    };
  }

  const scope = await resolveImportBranchScope(ctx);

  await db.customerImportBatch.update({
    where: { id: batch.id },
    data: {
      confirmedAt: new Date(),
      confirmedById: ctx.userId,
    },
  });

  const result = await commitImportBatch({
    tenantId: ctx.tenantId,
    batchId: batch.id,
    actorId: ctx.userId,
    planHash: params.planHash,
    allowedBranchIds: scope.allowed,
    allowUnassignedBranch: scope.branchless,
  });

  revalidatePath("/susu/admin/imports");
  revalidatePath(`/susu/admin/imports/${batch.id}`);
  revalidatePath("/susu/admin/customers");

  if (!result.ok) {
    return { success: false, error: result.error };
  }

  return {
    success: true,
    data: {
      status: result.status,
      importedCustomers: result.importedCustomers,
      importedAccounts: result.importedAccounts,
      linkedRows: result.linkedRows,
      skippedRows: result.skippedRows,
      failedRows: result.failedRows,
      idempotent: result.idempotent ?? false,
    },
  };
}

// ---------------------------------------------------------------------------
// History, detail and reporting
// ---------------------------------------------------------------------------

export async function getImportBatches(): Promise<ActionResponse> {
  const actor = await resolveImportActor();
  if (!actor.ok) return { success: false, error: actor.error };
  const { ctx } = actor;

  const scope = await resolveImportBranchScope(ctx);

  const batches = await db.customerImportBatch.findMany({
    where: {
      tenantId: ctx.tenantId,
      ...(scope.allowed === "all" || scope.branchless
        ? {}
        : { OR: [{ branchId: { in: [...scope.allowed] } }, { branchId: null }] }),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      name: true,
      fileName: true,
      status: true,
      branchId: true,
      branchMode: true,
      totalRows: true,
      importedCustomers: true,
      importedAccounts: true,
      linkedRows: true,
      skippedRows: true,
      failedRows: true,
      reviewRows: true,
      createdAt: true,
      committedAt: true,
      initiatedById: true,
      failureReason: true,
    },
  });

  return { success: true, data: { batches } };
}

/**
 * Row-level report for one batch.
 *
 * Exported as CSV rather than JSON so it opens in the operator's spreadsheet and
 * can be corrected and re-imported.
 */
export async function getImportErrorReport(params: {
  batchId: string;
}): Promise<ActionResponse> {
  const actor = await resolveImportActor();
  if (!actor.ok) return { success: false, error: actor.error };
  const { ctx } = actor;

  const batch = await db.customerImportBatch.findFirst({
    where: { id: params.batchId, tenantId: ctx.tenantId },
    select: { id: true, name: true },
  });
  if (!batch) return { success: false, error: "Import batch not found." };

  const rows = await db.customerImportRow.findMany({
    where: {
      batchId: batch.id,
      tenantId: ctx.tenantId,
      // A row belongs in the report when it cannot be imported, when it already
      // failed or was skipped, or when it is ambiguous and nobody has decided yet.
      // Once a human has decided and the row imported cleanly it is history, not
      // an error, so a finished import reports nothing.
      OR: [
        { classification: "invalid" },
        { outcome: { in: ["failed", "skipped"] } },
        {
          classification: {
            in: ["account_conflict", "customer_conflict", "possible_customer_duplicate"],
          },
          resolution: null,
        },
      ],
    },
    orderBy: { rowNumber: "asc" },
  });

  const csv = buildCsv([
    [
      "Row",
      "Customer name",
      "Phone",
      "Your reference",
      "Account number",
      "Daily contribution",
      "Opening date",
      "Result",
      "Decision",
      "Problem",
      "Match details",
      "Outcome detail",
    ],
    ...rows.map((row) => [
      row.rowNumber,
      row.customerName ?? "",
      row.phone ?? "",
      row.externalReference ?? "",
      row.accountNumber ?? "",
      row.dailyContribution === null ? "" : Number(row.dailyContribution),
      row.openingDate ? row.openingDate.toISOString().slice(0, 10) : "",
      IMPORT_CLASSIFICATION_LABELS[row.classification as ImportClassification] ??
        row.classification,
      row.resolution
        ? IMPORT_RESOLUTION_LABELS[row.resolution as ImportResolution] ?? row.resolution
        : "",
      row.issues
        ? (JSON.parse(row.issues) as { message: string }[])
            .map((issue) => issue.message)
            .join(" ")
        : "",
      row.matchReasons ? (JSON.parse(row.matchReasons) as string[]).join(" ") : "",
      row.outcomeMessage ?? "",
    ]),
  ]);

  return {
    success: true,
    data: {
      fileName: `import-errors-${batch.id}.csv`,
      csv,
      rowCount: rows.length,
    },
  };
}

/**
 * Discard a batch.
 *
 * Only possible while nothing has been imported: once a customer exists, the
 * batch is part of their provenance and deleting it would erase evidence.
 */
export async function discardImportBatch(params: {
  batchId: string;
}): Promise<ActionResponse> {
  const actor = await resolveImportActor();
  if (!actor.ok) return { success: false, error: actor.error };
  const { ctx } = actor;

  const batch = await db.customerImportBatch.findFirst({
    where: { id: params.batchId, tenantId: ctx.tenantId },
    select: { id: true, status: true, importedCustomers: true, importedAccounts: true },
  });
  if (!batch) return { success: false, error: "Import batch not found." };

  if (batch.importedCustomers > 0 || batch.importedAccounts > 0) {
    return {
      success: false,
      error:
        "This import already created records. It cannot be discarded, because it is part of those customers' history.",
    };
  }
  if (batch.status === "committing") {
    return { success: false, error: "This import is running and cannot be discarded." };
  }

  await db.$transaction(async (tx) => {
    await tx.customerImportRowEvent.deleteMany({ where: { batchId: batch.id } });
    await tx.customerImportRow.deleteMany({ where: { batchId: batch.id } });
    await tx.customerImportBatch.update({
      where: { id: batch.id },
      data: {
        status: "cancelled",
        sourceText: null,
        commitLeaseUntil: null,
        failureReason: "Discarded by an administrator before anything was imported.",
      },
    });
  });

  await createAuditLog({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    action: "susu.customer_import_discarded",
    entityType: "customer_import_batch",
    entityId: batch.id,
    details: { previousStatus: batch.status },
  });

  revalidatePath("/susu/admin/imports");
  return { success: true, data: { status: "cancelled" } };
}

/** Field catalogue for the mapping step, so the UI never hardcodes labels. */
export async function getImportFieldCatalogue(): Promise<ActionResponse> {
  const actor = await resolveImportActor();
  if (!actor.ok) return { success: false, error: actor.error };
  return {
    success: true,
    data: {
      fields: IMPORT_FIELDS.map((field) => ({
        key: field.key,
        label: field.label,
        hint: field.hint,
        required: field.required,
      })),
      limits: {
        maxRows: CSV_LIMITS.maxRows,
        maxBytes: CSV_LIMITS.maxChars,
        maxNameLength: ONBOARDING_LIMITS.nameMax,
      },
    },
  };
}
