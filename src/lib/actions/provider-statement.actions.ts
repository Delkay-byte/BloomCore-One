"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireTenantAdminMomo, type TenantContext } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import {
  STATEMENT_PROVIDER_LABELS,
  caseAgeDays,
  findStatementMatch,
  isStatementProvider,
  minorToNumber,
  parseStatement,
  statementImportSchema,
  statementCaseSchema,
  summariseStatementRows,
  canTransitionCase,
  type MatchCandidate,
  type ParsedStatement,
  type StatementProvider,
} from "@/lib/provider-statement";
import { MATCH_WINDOW_MINUTES } from "@/lib/provider-statement";
import { createHash } from "node:crypto";

export interface StatementActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface StatementImportSummaryView {
  id: string;
  provider: StatementProvider;
  providerLabel: string;
  fileName: string;
  status: string;
  periodStart: string | null;
  periodEnd: string | null;
  rowCount: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  matchedRows: number;
  unmatchedRows: number;
  note: string | null;
  importedAt: string;
  importedByName: string | null;
}

export interface StatementRowView {
  id: string;
  rowNumber: number;
  externalReference: string | null;
  transactionAt: string | null;
  direction: string | null;
  amount: number | null;
  fee: number | null;
  balanceAfter: number | null;
  description: string | null;
  status: string;
  validationError: string | null;
  matchType: string | null;
  matchedEntityId: string | null;
  matchedReference: string | null;
}

export interface StatementImportDetailView extends StatementImportSummaryView {
  rows: StatementRowView[];
  totals: {
    matchedIn: number;
    matchedOut: number;
    unmatchedIn: number;
    unmatchedOut: number;
    netUnmatched: number;
  };
}

function money(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function revalidateReconciliation() {
  revalidatePath("/admin/reconciliation");
  revalidatePath("/admin/reconciliation/exceptions");
}

/**
 * Import a provider statement.
 *
 * Guarantees:
 *  - tenant-scoped, administrator-only;
 *  - the file is hashed, and the same bytes cannot be imported twice;
 *  - every row is stored with its own verdict, including duplicates;
 *  - NO financial record is created, edited or matched by writing to it;
 *  - the batch and its row verdicts are audited in the same transaction.
 */
export async function importProviderStatement(input: {
  provider: string;
  fileName: string;
  csv: string;
  note?: string;
}): Promise<StatementActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const parsedInput = statementImportSchema.safeParse(input);
  if (!parsedInput.success) {
    return {
      success: false,
      error: parsedInput.error.issues[0]?.message ?? "Enter the statement details.",
    };
  }
  const { provider, fileName, csv, note } = parsedInput.data;
  if (!isStatementProvider(provider)) {
    return { success: false, error: "Choose a supported provider." };
  }

  const parsed = parseStatement({ provider, csv });
  if (parsed.errors.length > 0 && parsed.validRows === 0) {
    return { success: false, error: parsed.errors.join(" ") };
  }

  const fileHash = createHash("sha256").update(csv).digest("hex");

  // Matching candidates: internal records from the same provider network,
  // widened by the match window so a clock difference cannot hide a match.
  const candidates = await loadMatchCandidates(ctx, provider, parsed);

  try {
    const result = await db.$transaction(async (tx) => {
      const existing = await tx.providerStatementImport.findFirst({
        where: { tenantId: ctx.tenantId, fileHash },
        select: { id: true, importedAt: true },
      });
      if (existing) {
        throw new Error("DUPLICATE_FILE");
      }

      const batch = await tx.providerStatementImport.create({
        data: {
          tenantId: ctx.tenantId,
          provider,
          fileName,
          fileHash,
          fileSizeBytes: csv.length,
          columnMapping: JSON.stringify(parsed.mapping),
          status: parsed.invalidRows === 0 ? "validated" : "parsed",
          periodStart: parsed.periodStart,
          periodEnd: parsed.periodEnd,
          rowCount: parsed.rows.length,
          validRows: parsed.validRows,
          invalidRows: parsed.invalidRows,
          note: note ?? null,
          importedById: ctx.userId,
          currency: "GHS",
        },
        select: { id: true },
      });

      let duplicates = 0;
      let matched = 0;
      let unmatched = 0;

      for (const row of parsed.rows) {
        let status: string = row.status === "valid" ? "valid" : "invalid";
        const validationError = row.errors.length > 0 ? row.errors.join(" ") : null;
        let duplicateOfId: string | null = null;
        let matchType: string | null = null;
        let matchedEntityId: string | null = null;

        if (row.fingerprint) {
          const earlier = await tx.providerStatementRow.findFirst({
            where: { tenantId: ctx.tenantId, fingerprint: row.fingerprint },
            select: { id: true },
            orderBy: { createdAt: "asc" },
          });
          if (earlier) {
            status = "duplicate";
            duplicateOfId = earlier.id;
            duplicates += 1;
          }
        }

        if (status === "valid") {
          const match = findStatementMatch(
            {
              externalReference: row.externalReference,
              transactionAt: row.transactionAt,
              direction: row.direction,
              amountMinor: row.amountMinor,
            },
            candidates
          );
          if (match) {
            status = "matched";
            matchType = match.matchType;
            matchedEntityId = match.entityId;
            matched += 1;
          } else {
            status = "unmatched";
            unmatched += 1;
          }
        }

        await tx.providerStatementRow.create({
          data: {
            tenantId: ctx.tenantId,
            importId: batch.id,
            rowNumber: row.rowNumber,
            fingerprint: row.fingerprint ?? `unparsed:${row.rowNumber}:${fileHash.slice(0, 16)}`,
            externalReference: row.externalReference,
            transactionAt: row.transactionAt,
            direction: row.direction,
            amount: row.amountMinor === null ? null : minorToNumber(row.amountMinor),
            fee: row.feeMinor === null ? null : minorToNumber(row.feeMinor),
            balanceAfter:
              row.balanceAfterMinor === null ? null : minorToNumber(row.balanceAfterMinor),
            description: row.description,
            rawRow: row.rawRow,
            status,
            validationError,
            duplicateOfId,
            matchedEntityType: matchedEntityId ? "momoTransaction" : null,
            matchedEntityId,
            matchType,
            matchedAt: matchedEntityId ? new Date() : null,
            matchedById: matchedEntityId ? ctx.userId : null,
          },
        });
      }

      await tx.providerStatementImport.update({
        where: { id: batch.id },
        data: {
          duplicateRows: duplicates,
          matchedRows: matched,
          unmatchedRows: unmatched,
          status: "reconciled",
        },
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "provider_statement.imported",
        entityType: "providerStatementImport",
        entityId: batch.id,
        details: {
          provider,
          fileName,
          fileHash,
          rowCount: parsed.rows.length,
          validRows: parsed.validRows,
          invalidRows: parsed.invalidRows,
          duplicateRows: duplicates,
          matchedRows: matched,
          unmatchedRows: unmatched,
          financialMutation: false,
        },
      });

      return { id: batch.id, duplicates, matched, unmatched };
    });

    revalidateReconciliation();
    return {
      success: true,
      data: {
        importId: result.id,
        duplicateRows: result.duplicates,
        matchedRows: result.matched,
        unmatchedRows: result.unmatched,
        financialMutation: false,
      },
    };
  } catch (error) {
    const message =
      error instanceof Error && error.message === "DUPLICATE_FILE"
        ? "This exact statement file has already been imported. Open the existing import instead of importing it again."
        : "The statement could not be imported. Check the file and try again.";
    return { success: false, error: message };
  }
}

/**
 * Load internal MoMo records that could correspond to statement lines.
 *
 * Only the same provider network is considered, so an MTN statement can never be
 * matched to a Telecel float movement.
 */
async function loadMatchCandidates(
  ctx: TenantContext,
  provider: StatementProvider,
  parsed: ParsedStatement
): Promise<MatchCandidate[]> {
  if (!parsed.periodStart || !parsed.periodEnd) return [];
  const from = new Date(parsed.periodStart.getTime() - MATCH_WINDOW_MINUTES * 60 * 1000);
  const to = new Date(parsed.periodEnd.getTime() + MATCH_WINDOW_MINUTES * 60 * 1000);
  const rows = await db.momoTransaction.findMany({
    where: {
      tenantId: ctx.tenantId,
      network: provider,
      occurredAt: { gte: from, lte: to },
      status: { in: ["recorded", "corrected", "reversal"] },
    },
    select: {
      id: true,
      reference: true,
      externalReference: true,
      occurredAt: true,
      direction: true,
      amount: true,
    },
    take: 5000,
  });
  return rows.map((row) => {
    const amount = Number(row.amount);
    return {
      id: row.id,
      // The provider reference is preferred; the internal reference is the
      // fallback so an operator who typed the provider ID as the reference still
      // matches.
      reference: row.externalReference ?? row.reference,
      transactionAt: row.occurredAt,
      direction: row.direction === "inflow" || row.direction === "reversal" ? "in" : "out",
      amountMinor: Math.round(Math.abs(amount) * 100),
    } satisfies MatchCandidate;
  });
}

export async function getStatementImports(): Promise<StatementImportSummaryView[]> {
  const ctx = await requireTenantAdminMomo();
  const rows = await db.providerStatementImport.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { importedAt: "desc" },
    take: 100,
    include: { _count: { select: { rows: true } } },
  });
  const names = await userNames(
    ctx.tenantId,
    rows.map((row) => row.importedById)
  );
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider as StatementProvider,
    providerLabel: STATEMENT_PROVIDER_LABELS[row.provider as StatementProvider] ?? row.provider,
    fileName: row.fileName,
    status: row.status,
    periodStart: row.periodStart?.toISOString() ?? null,
    periodEnd: row.periodEnd?.toISOString() ?? null,
    rowCount: row._count.rows,
    validRows: row.validRows,
    invalidRows: row.invalidRows,
    duplicateRows: row.duplicateRows,
    matchedRows: row.matchedRows,
    unmatchedRows: row.unmatchedRows,
    note: row.note,
    importedAt: row.importedAt.toISOString(),
    importedByName: names.get(row.importedById) ?? null,
  }));
}

export async function getStatementImportDetail(
  importId: string
): Promise<StatementImportDetailView | null> {
  const ctx = await requireTenantAdminMomo();
  const batch = await db.providerStatementImport.findFirst({
    where: { id: importId, tenantId: ctx.tenantId },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  if (!batch) return null;

  const names = await userNames(ctx.tenantId, [batch.importedById]);
  const matchedIds = batch.rows
    .map((row) => row.matchedEntityId)
    .filter((value): value is string => typeof value === "string");
  const matched = matchedIds.length
    ? await db.momoTransaction.findMany({
        where: { tenantId: ctx.tenantId, id: { in: matchedIds } },
        select: { id: true, reference: true, externalReference: true },
      })
    : [];
  const referenceById = new Map(
    matched.map((row) => [row.id, row.externalReference ?? row.reference])
  );

  const summary = summariseStatementRows(
    batch.rows.map((row) => ({
      status: row.status,
      direction: row.direction,
      amountMinor: row.amount === null ? null : Math.round(Number(row.amount) * 100),
      matchType: row.matchType,
    }))
  );

  return {
    id: batch.id,
    provider: batch.provider as StatementProvider,
    providerLabel:
      STATEMENT_PROVIDER_LABELS[batch.provider as StatementProvider] ?? batch.provider,
    fileName: batch.fileName,
    status: batch.status,
    periodStart: batch.periodStart?.toISOString() ?? null,
    periodEnd: batch.periodEnd?.toISOString() ?? null,
    rowCount: batch.rows.length,
    validRows: batch.validRows,
    invalidRows: batch.invalidRows,
    duplicateRows: batch.duplicateRows,
    matchedRows: batch.matchedRows,
    unmatchedRows: batch.unmatchedRows,
    note: batch.note,
    importedAt: batch.importedAt.toISOString(),
    importedByName: names.get(batch.importedById) ?? null,
    rows: batch.rows.map((row) => ({
      id: row.id,
      rowNumber: row.rowNumber,
      externalReference: row.externalReference,
      transactionAt: row.transactionAt?.toISOString() ?? null,
      direction: row.direction,
      amount: row.amount === null ? null : money(row.amount),
      fee: row.fee === null ? null : money(row.fee),
      balanceAfter: row.balanceAfter === null ? null : money(row.balanceAfter),
      description: row.description,
      status: row.status,
      validationError: row.validationError,
      matchType: row.matchType,
      matchedEntityId: row.matchedEntityId,
      matchedReference: row.matchedEntityId
        ? (referenceById.get(row.matchedEntityId) ?? null)
        : null,
    })),
    totals: {
      matchedIn: minorToNumber(summary.matchedInMinor),
      matchedOut: minorToNumber(summary.matchedOutMinor),
      unmatchedIn: minorToNumber(summary.unmatchedInMinor),
      unmatchedOut: minorToNumber(summary.unmatchedOutMinor),
      netUnmatched: minorToNumber(summary.netUnmatchedMinor),
    },
  };
}

/**
 * Record a manual match between a statement line and an internal record.
 *
 * Matching is a comparison judgement only. `matchedEntityId` is provenance: the
 * internal record is not updated, and `verificationStatus` of the transaction is
 * NOT changed to `provider_confirmed`, because a human pairing two records is
 * not a provider confirmation.
 */
export async function manuallyMatchStatementRow(input: {
  rowId: string;
  momoTransactionId: string;
}): Promise<StatementActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const row = await db.providerStatementRow.findFirst({
    where: { id: input.rowId, tenantId: ctx.tenantId },
  });
  if (!row) return { success: false, error: "That statement line was not found." };
  if (row.status === "duplicate") {
    return { success: false, error: "Duplicate statement lines stay unlinked." };
  }
  const transaction = await db.momoTransaction.findFirst({
    where: { id: input.momoTransactionId, tenantId: ctx.tenantId },
    select: { id: true, reference: true },
  });
  if (!transaction) return { success: false, error: "That internal record was not found." };

  try {
    await db.$transaction(async (tx) => {
      await tx.providerStatementRow.update({
        where: { id: row.id },
        data: {
          status: "matched",
          matchedEntityType: "momoTransaction",
          matchedEntityId: transaction.id,
          matchType: "manual",
          matchedAt: new Date(),
          matchedById: ctx.userId,
        },
      });
      await recalculateImportCounts(tx, ctx.tenantId, row.importId);
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "provider_statement.row_matched",
        entityType: "providerStatementRow",
        entityId: row.id,
        details: {
          importId: row.importId,
          momoTransactionId: transaction.id,
          momoReference: transaction.reference,
          matchType: "manual",
          financialMutation: false,
          providerConfirmation: false,
        },
      });
    });
  } catch {
    return { success: false, error: "The line could not be matched." };
  }

  revalidateReconciliation();
  return { success: true };
}

export async function unmatchStatementRow(rowId: string): Promise<StatementActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const row = await db.providerStatementRow.findFirst({
    where: { id: rowId, tenantId: ctx.tenantId },
  });
  if (!row) return { success: false, error: "That statement line was not found." };
  if (row.matchType !== "manual") {
    return {
      success: false,
      error: "Only a manual match can be removed. An automatic match is documentary evidence.",
    };
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.providerStatementRow.update({
        where: { id: row.id },
        data: {
          status: "unmatched",
          matchedEntityType: null,
          matchedEntityId: null,
          matchType: null,
          matchedAt: null,
          matchedById: null,
        },
      });
      await recalculateImportCounts(tx, ctx.tenantId, row.importId);
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "provider_statement.row_unmatched",
        entityType: "providerStatementRow",
        entityId: row.id,
        details: { importId: row.importId, financialMutation: false },
      });
    });
  } catch {
    return { success: false, error: "The match could not be removed." };
  }

  revalidateReconciliation();
  return { success: true };
}

async function recalculateImportCounts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  importId: string
) {
  const [matched, unmatched, duplicates] = await Promise.all([
    tx.providerStatementRow.count({ where: { tenantId, importId, status: "matched" } }),
    tx.providerStatementRow.count({ where: { tenantId, importId, status: "unmatched" } }),
    tx.providerStatementRow.count({ where: { tenantId, importId, status: "duplicate" } }),
  ]);
  await tx.providerStatementImport.update({
    where: { id: importId },
    data: { matchedRows: matched, unmatchedRows: unmatched, duplicateRows: duplicates },
  });
}

// ---------------------------------------------------------------------------
// Exception cases
// ---------------------------------------------------------------------------

export interface ExceptionCaseView {
  id: string;
  caseNumber: string;
  category: string;
  severity: string;
  status: string;
  title: string;
  description: string | null;
  ownerId: string | null;
  ownerName: string | null;
  ageDays: number;
  dueAt: string | null;
  overdue: boolean;
  evidence: string | null;
  resolutionType: string | null;
  resolutionNote: string | null;
  openedAt: string;
  lastActivityAt: string;
  resolvedAt: string | null;
  linkCount: number;
  links: Array<{ entityType: string; entityId: string; note: string | null }>;
  events: Array<{
    id: string;
    type: string;
    actorId: string;
    actorName: string | null;
    note: string | null;
    createdAt: string;
  }>;
}

export async function openExceptionCase(input: unknown): Promise<StatementActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const parsed = statementCaseSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Enter the case details." };
  }
  const data = parsed.data;

  if (data.ownerId) {
    const owner = await db.user.findFirst({
      where: { id: data.ownerId, tenantId: ctx.tenantId, role: "admin" },
      select: { id: true },
    });
    if (!owner) return { success: false, error: "Choose an administrator at this business." };
  }

  const caseNumber = await nextCaseNumber(ctx.tenantId);
  try {
    const id = await db.$transaction(async (tx) => {
      const created = await tx.reconciliationExceptionCase.create({
        data: {
          tenantId: ctx.tenantId,
          caseNumber,
          category: data.category,
          severity: data.severity,
          title: data.title,
          description: data.description ?? null,
          ownerId: data.ownerId ?? null,
          assignedAt: data.ownerId ? new Date() : null,
          dueAt: data.dueAt ? new Date(data.dueAt) : null,
          evidence: data.evidence ?? null,
          openedById: ctx.userId,
        },
        select: { id: true },
      });
      for (const link of data.links ?? []) {
        await tx.reconciliationExceptionLink.create({
          data: {
            tenantId: ctx.tenantId,
            caseId: created.id,
            entityType: link.entityType,
            entityId: link.entityId,
            note: link.note ?? null,
            createdById: ctx.userId,
          },
        });
      }
      await tx.reconciliationExceptionEvent.create({
        data: {
          tenantId: ctx.tenantId,
          caseId: created.id,
          type: "opened",
          actorId: ctx.userId,
          actorRole: ctx.role,
          note: data.description ?? null,
        },
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "reconciliation.case_opened",
        entityType: "reconciliationExceptionCase",
        entityId: created.id,
        details: {
          caseNumber,
          category: data.category,
          severity: data.severity,
          linkedRecords: data.links?.length ?? 0,
          financialMutation: false,
        },
      });
      return created.id;
    });
    revalidateReconciliation();
    return { success: true, data: { id, caseNumber } };
  } catch {
    return { success: false, error: "The exception case could not be opened." };
  }
}

export async function updateExceptionCase(input: {
  id: string;
  status?: string;
  severity?: string;
  ownerId?: string | null;
  note?: string;
  evidence?: string;
  resolutionType?: string;
  resolutionNote?: string;
}): Promise<StatementActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const existing = await db.reconciliationExceptionCase.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
  });
  if (!existing) return { success: false, error: "That case was not found." };

  if (input.status && !canTransitionCase(existing.status, input.status)) {
    return {
      success: false,
      error: `A case cannot move from ${existing.status} to ${input.status}.`,
    };
  }
  if ((input.status === "resolved" || input.status === "dismissed") && !input.resolutionNote?.trim()) {
    return { success: false, error: "Record the resolution before closing the case." };
  }
  if (input.ownerId) {
    const owner = await db.user.findFirst({
      where: { id: input.ownerId, tenantId: ctx.tenantId, role: "admin" },
      select: { id: true },
    });
    if (!owner) return { success: false, error: "Choose an administrator at this business." };
  }

  const now = new Date();
  try {
    await db.$transaction(async (tx) => {
      await tx.reconciliationExceptionCase.update({
        where: { id: existing.id },
        data: {
          status: input.status ?? existing.status,
          severity: input.severity ?? existing.severity,
          ownerId: input.ownerId === undefined ? existing.ownerId : input.ownerId,
          assignedAt:
            input.ownerId === undefined
              ? existing.assignedAt
              : input.ownerId
                ? now
                : null,
          evidence: input.evidence ?? existing.evidence,
          resolutionType:
            input.status === "resolved" || input.status === "dismissed"
              ? (input.resolutionType ?? existing.resolutionType)
              : existing.resolutionType,
          resolutionNote: input.resolutionNote ?? existing.resolutionNote,
          resolvedById:
            input.status === "resolved" || input.status === "dismissed"
              ? ctx.userId
              : input.status === "open"
                ? null
                : existing.resolvedById,
          resolvedAt:
            input.status === "resolved" || input.status === "dismissed"
              ? now
              : input.status === "open"
                ? null
                : existing.resolvedAt,
          lastActivityAt: now,
        },
      });

      const events: Array<{ type: string; note: string | null; payload?: string }> = [];
      if (input.status && input.status !== existing.status) {
        events.push({
          type: existing.status === "resolved" || existing.status === "dismissed" ? "reopened" : "status_changed",
          note: input.note?.trim() || null,
          payload: JSON.stringify({ from: existing.status, to: input.status }),
        });
      }
      if (input.ownerId !== undefined && input.ownerId !== existing.ownerId) {
        events.push({ type: "assigned", note: null, payload: JSON.stringify({ ownerId: input.ownerId }) });
      }
      if (input.evidence !== undefined) {
        events.push({ type: "evidence", note: input.evidence.slice(0, 500) });
      }
      if (input.note?.trim() && !input.status) {
        events.push({ type: "note", note: input.note.trim() });
      }
      if (input.resolutionNote && (input.status === "resolved" || input.status === "dismissed")) {
        events.push({ type: "resolved", note: input.resolutionNote });
      }
      for (const event of events) {
        await tx.reconciliationExceptionEvent.create({
          data: {
            tenantId: ctx.tenantId,
            caseId: existing.id,
            type: event.type,
            actorId: ctx.userId,
            actorRole: ctx.role,
            note: event.note ?? null,
            payload: event.payload ?? null,
          },
        });
      }

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "reconciliation.case_updated",
        entityType: "reconciliationExceptionCase",
        entityId: existing.id,
        details: {
          caseNumber: existing.caseNumber,
          fromStatus: existing.status,
          toStatus: input.status ?? existing.status,
          ownerChanged: input.ownerId !== undefined && input.ownerId !== existing.ownerId,
          resolutionType: input.resolutionType ?? null,
          financialMutation: false,
        },
      });
    });
  } catch {
    return { success: false, error: "The case could not be updated." };
  }

  revalidateReconciliation();
  return { success: true };
}

export async function linkCaseRecord(input: {
  caseId: string;
  entityType: string;
  entityId: string;
  note?: string;
}): Promise<StatementActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const existing = await db.reconciliationExceptionCase.findFirst({
    where: { id: input.caseId, tenantId: ctx.tenantId },
    select: { id: true, caseNumber: true },
  });
  if (!existing) return { success: false, error: "That case was not found." };
  if (!input.entityType.trim() || !input.entityId.trim()) {
    return { success: false, error: "Choose the record to link." };
  }
  try {
    await db.$transaction(async (tx) => {
      const already = await tx.reconciliationExceptionLink.findFirst({
        where: {
          tenantId: ctx.tenantId,
          caseId: existing.id,
          entityType: input.entityType,
          entityId: input.entityId,
        },
        select: { id: true },
      });
      if (already) throw new Error("ALREADY_LINKED");
      await tx.reconciliationExceptionLink.create({
        data: {
          tenantId: ctx.tenantId,
          caseId: existing.id,
          entityType: input.entityType,
          entityId: input.entityId,
          note: input.note?.trim() || null,
          createdById: ctx.userId,
        },
      });
      await tx.reconciliationExceptionEvent.create({
        data: {
          tenantId: ctx.tenantId,
          caseId: existing.id,
          type: "link_added",
          actorId: ctx.userId,
          actorRole: ctx.role,
          note: `${input.entityType}:${input.entityId}`,
          payload: JSON.stringify({ entityType: input.entityType, entityId: input.entityId }),
        },
      });
      await tx.reconciliationExceptionCase.update({
        where: { id: existing.id },
        data: { lastActivityAt: new Date() },
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "reconciliation.case_linked",
        entityType: "reconciliationExceptionCase",
        entityId: existing.id,
        details: {
          caseNumber: existing.caseNumber,
          entityType: input.entityType,
          entityId: input.entityId,
          financialMutation: false,
        },
      });
    });
  } catch (error) {
    const duplicate = error instanceof Error && error.message === "ALREADY_LINKED";
    return {
      success: false,
      error: duplicate ? "That record is already linked to this case." : "The record could not be linked.",
    };
  }
  revalidateReconciliation();
  return { success: true };
}

export async function getExceptionCases(): Promise<ExceptionCaseView[]> {
  const ctx = await requireTenantAdminMomo();
  const rows = await db.reconciliationExceptionCase.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: [{ status: "asc" }, { openedAt: "asc" }],
    take: 200,
    include: {
      links: true,
      events: { orderBy: { createdAt: "asc" }, take: 100 },
    },
  });
  const names = await userNames(ctx.tenantId, [
    ...rows.map((row) => row.ownerId),
    ...rows.flatMap((row) => row.events.map((event) => event.actorId)),
  ]);
  const now = new Date();
  return rows.map((row) => ({
    id: row.id,
    caseNumber: row.caseNumber,
    category: row.category,
    severity: row.severity,
    status: row.status,
    title: row.title,
    description: row.description,
    ownerId: row.ownerId,
    ownerName: row.ownerId ? (names.get(row.ownerId) ?? null) : null,
    ageDays: caseAgeDays(row.openedAt, now),
    dueAt: row.dueAt?.toISOString() ?? null,
    overdue: row.dueAt ? row.dueAt.getTime() < now.getTime() && row.status !== "resolved" && row.status !== "dismissed" : false,
    evidence: row.evidence,
    resolutionType: row.resolutionType,
    resolutionNote: row.resolutionNote,
    openedAt: row.openedAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    linkCount: row.links.length,
    links: row.links.map((link) => ({
      entityType: link.entityType,
      entityId: link.entityId,
      note: link.note,
    })),
    events: row.events.map((event) => ({
      id: event.id,
      type: event.type,
      actorId: event.actorId,
      actorName: names.get(event.actorId) ?? null,
      note: event.note,
      createdAt: event.createdAt.toISOString(),
    })),
  }));
}

export async function getExceptionOwnerOptions(): Promise<
  Array<{ id: string; name: string }>
> {
  const ctx = await requireTenantAdminMomo();
  const users = await db.user.findMany({
    where: { tenantId: ctx.tenantId, role: "admin", status: "active" },
    select: { id: true, fullName: true },
    orderBy: { fullName: "asc" },
    take: 100,
  });
  return users.map((user) => ({ id: user.id, name: user.fullName }));
}

async function nextCaseNumber(tenantId: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const count = await db.reconciliationExceptionCase.count({
    where: { tenantId, caseNumber: { startsWith: `REC-${year}-` } },
  });
  return `REC-${year}-${String(count + 1).padStart(4, "0")}`;
}

async function userNames(
  tenantId: string,
  ids: Array<string | null | undefined>
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  if (unique.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { tenantId, id: { in: unique } },
    select: { id: true, fullName: true },
  });
  return new Map(users.map((user) => [user.id, user.fullName]));
}
