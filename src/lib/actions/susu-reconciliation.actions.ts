"use server";

/**
 * Phase 5 — Susu reconciliation sessions, daily collector closing and
 * difference detection.
 *
 * Invariants:
 *   * detection observes existing server records; it never posts, reverses or
 *     edits a contribution, remittance, withdrawal or daily account;
 *   * an unreviewed observation is refreshed in place, a reviewed or
 *     case-linked observation is preserved and a new revision is appended;
 *   * daily collector closing is operational handover evidence, distinct from
 *     a formal Phase 3 remittance and from Phase 4 withdrawal approval;
 *   * every read and write is scoped by tenant + branch + collector on the
 *     server. Client ids are re-validated against the database.
 */

import { db } from "@/lib/db";
import { createAuditLogTx } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import {
  applyFindings,
  detectDifferences,
  summarizeLines,
  type ReconciliationSummary,
} from "@/lib/finance/reconciliation-detection";
import {
  caseCategoryForFinding,
  createExceptionCaseTx,
  highestSeverity,
} from "@/lib/finance/reconciliation-cases";
import {
  ReconciliationError,
  actorAllowsBranch,
  assertActorBranchWrite,
  assertCanManageCase,
  requireReconciliationAdmin,
  resolveReconciliationActor,
  type ReconciliationActor,
} from "@/lib/finance/reconciliation-access";
import {
  CASE_CATEGORY_LABELS,
  LINE_STATUS_LABELS,
  RECONCILIATION_DEFINITION_VERSION,
  RECONCILIATION_TYPES,
  SESSION_STATUS_LABELS,
  addDaysUtc,
  formatBusinessDay,
  isUnresolvedLineStatus,
  money,
  normalizeBusinessDay,
} from "@/lib/reconciliation-policy";
import { lockAccountForUpdate } from "@/lib/db-lock";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";

interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface ReconciliationLineView {
  id: string;
  sessionId: string;
  fingerprint: string;
  revision: number;
  branchId: string | null;
  collectorId: string | null;
  entityType: string;
  entityId: string;
  expectedAmount: number | null;
  declaredAmount: number | null;
  physicalAmount: number | null;
  receivedAmount: number | null;
  verifiedAmount: number | null;
  variance: number;
  status: string;
  statusLabel: string;
  severity: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  reviewedAt: Date | null;
  reviewedById: string | null;
  exceptionCaseId: string | null;
  lastSeenAt: Date;
  createdAt: Date;
}

export interface SusuReconciliationView {
  id: string;
  tenantId: string;
  branchId: string | null;
  branchName: string | null;
  collectorId: string | null;
  collectorName: string | null;
  type: string;
  status: string;
  statusLabel: string;
  periodStart: Date;
  periodEnd: Date;
  summary: ReconciliationSummary | null;
  summaryJson: string;
  definitionVersion: number;
  runCount: number;
  lastRunAt: Date | null;
  lastRunById: string | null;
  openedById: string;
  openedByName: string | null;
  openedAt: Date;
  closedAt: Date | null;
  closedById: string | null;
  closeReason: string | null;
  lineCount: number;
  unresolvedLines: number;
}

export interface ReconciliationSessionDetail extends SusuReconciliationView {
  lines: ReconciliationLineView[];
  adjustments: ReconciliationAdjustmentView[];
  closings: DailyClosingView[];
  cases: Array<{
    id: string;
    caseNumber: string;
    status: string;
    severity: string;
    title: string;
    amountAtStake: number | null;
    ownerId: string | null;
  }>;
}

export interface ReconciliationAdjustmentView {
  id: string;
  sessionId: string;
  adjustmentType: string;
  referenceType: string;
  referenceId: string;
  declaredAmount: number | null;
  correctedAmount: number | null;
  variance: number;
  status: string;
  reason: string | null;
  evidenceRef: string | null;
  caseId: string | null;
  proposedById: string;
  proposedAt: Date;
  linkedById: string | null;
  linkedAt: Date | null;
}

export interface DailyClosingView {
  id: string;
  tenantId: string;
  branchId: string | null;
  branchName: string | null;
  collectorId: string;
  collectorName: string | null;
  closingDate: Date;
  closingDay: string;
  status: string;
  expectedCash: number;
  contributionsRecorded: number;
  contributionsSynced: number;
  contributionsPending: number;
  pendingSyncCount: number;
  failedSyncCount: number;
  declaredCash: number | null;
  declaredAt: Date | null;
  declaredById: string | null;
  declarationNote: string | null;
  declarationEvidenceRef: string | null;
  handoverAmount: number | null;
  handedOverAt: Date | null;
  handedOverById: string | null;
  handoverEvidenceRef: string | null;
  receivedAmount: number | null;
  receivedAt: Date | null;
  receivedById: string | null;
  receiptNote: string | null;
  receiptEvidenceRef: string | null;
  varianceExpectedVsDeclared: number;
  varianceDeclaredVsReceived: number;
  varianceExpectedVsReceived: number;
  outstandingAmount: number;
  sessionId: string | null;
  exceptionCaseId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionOpenedResponse extends ActionResponse {
  data?: SusuReconciliationView;
}

export interface SessionReconciledResponse extends ActionResponse {
  data?: {
    lines: number;
    created: number;
    updated: number;
    revisions: number;
    unchanged: number;
    summary: ReconciliationSummary;
  };
}

export interface SessionViewResponse extends ActionResponse {
  data?: ReconciliationSessionDetail;
}

export interface DailyClosingResponse extends ActionResponse {
  data?: DailyClosingView;
}

export interface AdjustmentResponse extends ActionResponse {
  data?: ReconciliationAdjustmentView;
}

const ADJUSTMENT_TYPES = new Set([
  "remittance_reversal",
  "daily_account_correction",
  "contribution_reversal",
  "withdrawal_adjustment",
  "other",
]);

function parseDay(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return normalizeBusinessDay(parsed);
}

function dateFilters(from?: string | null, to?: string | null) {
  const start = from ? parseDay(from) : null;
  const end = to ? parseDay(to) : null;
  if (from && !start) return { error: "Invalid start date" as const };
  if (to && !end) return { error: "Invalid end date" as const };
  if (start && end && start > end) {
    return { error: "The start date must be on or before the end date" as const };
  }
  return { start, end };
}

async function writeLimit(actor: ReconciliationActor, scope: string): Promise<void> {
  const rate = await consumeRateLimit(
    scope,
    `${actor.ctx.tenantId}:${actor.ctx.userId}`,
    RATE_LIMITS.financeMutation
  );
  if (!rate.allowed) {
    throw new ReconciliationError(
      "Too many financial actions. Please wait and try again."
    );
  }
}

function fail(error: unknown): { success: false; error: string } {
  if (error instanceof ReconciliationError) {
    return { success: false, error: error.message };
  }
  // Never leak database or stack detail to the browser.
  return { success: false, error: "The reconciliation action could not be completed." };
}

function toAdjustmentView(row: {
  id: string;
  sessionId: string;
  adjustmentType: string;
  referenceType: string;
  referenceId: string;
  declaredAmount: Prisma.Decimal | null;
  correctedAmount: Prisma.Decimal | null;
  variance: Prisma.Decimal;
  status: string;
  reason: string | null;
  evidenceRef: string | null;
  caseId: string | null;
  proposedById: string;
  proposedAt: Date;
  linkedById: string | null;
  linkedAt: Date | null;
}): ReconciliationAdjustmentView {
  return {
    id: row.id,
    sessionId: row.sessionId,
    adjustmentType: row.adjustmentType,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    declaredAmount: row.declaredAmount == null ? null : Number(row.declaredAmount),
    correctedAmount: row.correctedAmount == null ? null : Number(row.correctedAmount),
    variance: Number(row.variance),
    status: row.status,
    reason: row.reason ?? null,
    evidenceRef: row.evidenceRef ?? null,
    caseId: row.caseId ?? null,
    proposedById: row.proposedById,
    proposedAt: row.proposedAt,
    linkedById: row.linkedById ?? null,
    linkedAt: row.linkedAt ?? null,
  };
}

function toLineView(row: {
  id: string;
  sessionId: string;
  fingerprint: string;
  revision: number;
  branchId: string | null;
  collectorId: string | null;
  entityType: string;
  entityId: string;
  expectedAmount: Prisma.Decimal | null;
  declaredAmount: Prisma.Decimal | null;
  physicalAmount: Prisma.Decimal | null;
  receivedAmount: Prisma.Decimal | null;
  verifiedAmount: Prisma.Decimal | null;
  variance: Prisma.Decimal;
  status: string;
  severity: string | null;
  reason: string | null;
  metadataJson: string | null;
  reviewedAt: Date | null;
  reviewedById: string | null;
  exceptionCaseId: string | null;
  lastSeenAt: Date;
  createdAt: Date;
}): ReconciliationLineView {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadataJson) {
    try {
      metadata = JSON.parse(row.metadataJson) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    fingerprint: row.fingerprint,
    revision: row.revision,
    branchId: row.branchId ?? null,
    collectorId: row.collectorId ?? null,
    entityType: row.entityType,
    entityId: row.entityId,
    expectedAmount: row.expectedAmount == null ? null : Number(row.expectedAmount),
    declaredAmount: row.declaredAmount == null ? null : Number(row.declaredAmount),
    physicalAmount: row.physicalAmount == null ? null : Number(row.physicalAmount),
    receivedAmount: row.receivedAmount == null ? null : Number(row.receivedAmount),
    verifiedAmount: row.verifiedAmount == null ? null : Number(row.verifiedAmount),
    variance: Number(row.variance),
    status: row.status,
    statusLabel: LINE_STATUS_LABELS[row.status] ?? row.status,
    severity: row.severity ?? null,
    reason: row.reason ?? null,
    metadata,
    reviewedAt: row.reviewedAt ?? null,
    reviewedById: row.reviewedById ?? null,
    exceptionCaseId: row.exceptionCaseId ?? null,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

function toClosingView(
  row: {
    id: string;
    tenantId: string | null;
    branchId: string | null;
    collectorId: string;
    closingDate: Date;
    status: string;
    expectedCash: Prisma.Decimal;
    contributionsRecorded: Prisma.Decimal;
    contributionsSynced: Prisma.Decimal;
    contributionsPending: Prisma.Decimal;
    pendingSyncCount: number;
    failedSyncCount: number;
    declaredCash: Prisma.Decimal | null;
    declaredAt: Date | null;
    declaredById: string | null;
    declarationNote: string | null;
    declarationEvidenceRef: string | null;
    handoverAmount: Prisma.Decimal | null;
    handedOverAt: Date | null;
    handedOverById: string | null;
    handoverEvidenceRef: string | null;
    receivedAmount: Prisma.Decimal | null;
    receivedAt: Date | null;
    receivedById: string | null;
    receiptNote: string | null;
    receiptEvidenceRef: string | null;
    varianceExpectedVsDeclared: Prisma.Decimal;
    varianceDeclaredVsReceived: Prisma.Decimal;
    varianceExpectedVsReceived: Prisma.Decimal;
    outstandingAmount: Prisma.Decimal;
    sessionId: string | null;
    exceptionCaseId: string | null;
    createdAt: Date;
    updatedAt: Date;
    collector?: { user?: { fullName: string | null } | null } | null;
    branch?: { name: string } | null;
  }
): DailyClosingView {
  return {
    id: row.id,
    tenantId: row.tenantId as string,
    branchId: row.branchId ?? null,
    branchName: row.branch?.name ?? null,
    collectorId: row.collectorId,
    collectorName: row.collector?.user?.fullName ?? null,
    closingDate: row.closingDate,
    closingDay: formatBusinessDay(row.closingDate),
    status: row.status,
    expectedCash: Number(row.expectedCash),
    contributionsRecorded: Number(row.contributionsRecorded),
    contributionsSynced: Number(row.contributionsSynced),
    contributionsPending: Number(row.contributionsPending),
    pendingSyncCount: row.pendingSyncCount,
    failedSyncCount: row.failedSyncCount,
    declaredCash: row.declaredCash == null ? null : Number(row.declaredCash),
    declaredAt: row.declaredAt ?? null,
    declaredById: row.declaredById ?? null,
    declarationNote: row.declarationNote ?? null,
    declarationEvidenceRef: row.declarationEvidenceRef ?? null,
    handoverAmount: row.handoverAmount == null ? null : Number(row.handoverAmount),
    handedOverAt: row.handedOverAt ?? null,
    handedOverById: row.handedOverById ?? null,
    handoverEvidenceRef: row.handoverEvidenceRef ?? null,
    receivedAmount: row.receivedAmount == null ? null : Number(row.receivedAmount),
    receivedAt: row.receivedAt ?? null,
    receivedById: row.receivedById ?? null,
    receiptNote: row.receiptNote ?? null,
    receiptEvidenceRef: row.receiptEvidenceRef ?? null,
    varianceExpectedVsDeclared: Number(row.varianceExpectedVsDeclared),
    varianceDeclaredVsReceived: Number(row.varianceDeclaredVsReceived),
    varianceExpectedVsReceived: Number(row.varianceExpectedVsReceived),
    outstandingAmount: Number(row.outstandingAmount),
    sessionId: row.sessionId ?? null,
    exceptionCaseId: row.exceptionCaseId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function sessionView(
  row: {
    id: string;
    tenantId: string | null;
    branchId: string | null;
    collectorId: string | null;
    type: string;
    status: string;
    periodStart: Date;
    periodEnd: Date;
    summaryJson: string;
    definitionVersion: number;
    runCount: number;
    lastRunAt: Date | null;
    lastRunById: string | null;
    openedById: string;
    openedAt: Date;
    closedAt: Date | null;
    closedById: string | null;
    closeReason: string | null;
    branch?: { name: string } | null;
    collector?: { user?: { fullName: string | null } | null } | null;
  },
  counts: { lineCount: number; unresolvedLines: number }
): Promise<SusuReconciliationView> {
  let summary: ReconciliationSummary | null = null;
  if (row.summaryJson) {
    try {
      summary = JSON.parse(row.summaryJson) as ReconciliationSummary;
    } catch {
      summary = null;
    }
  }
  const opener = await db.user.findFirst({
    where: { id: row.openedById, tenantId: row.tenantId ?? undefined },
    select: { fullName: true },
  });
  return {
    id: row.id,
    tenantId: row.tenantId as string,
    branchId: row.branchId ?? null,
    branchName: row.branch?.name ?? null,
    collectorId: row.collectorId ?? null,
    collectorName: row.collector?.user?.fullName ?? null,
    type: row.type,
    status: row.status,
    statusLabel: SESSION_STATUS_LABELS[row.status] ?? row.status,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    summary,
    summaryJson: row.summaryJson,
    definitionVersion: row.definitionVersion,
    runCount: row.runCount,
    lastRunAt: row.lastRunAt ?? null,
    lastRunById: row.lastRunById ?? null,
    openedById: row.openedById,
    openedByName: opener?.fullName ?? null,
    openedAt: row.openedAt,
    closedAt: row.closedAt ?? null,
    closedById: row.closedById ?? null,
    closeReason: row.closeReason ?? null,
    lineCount: counts.lineCount,
    unresolvedLines: counts.unresolvedLines,
  };
}

async function latestLineCounts(sessionIds: string[]) {
  const result = new Map<string, { lineCount: number; unresolvedLines: number }>();
  if (sessionIds.length === 0) return result;
  const lines = await db.reconciliationLine.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { sessionId: true, fingerprint: true, revision: true, status: true },
  });
  const latest = new Map<string, { status: string; revision: number }>();
  for (const line of lines) {
    const key = `${line.sessionId}:${line.fingerprint}`;
    const current = latest.get(key);
    if (!current || line.revision > current.revision) {
      latest.set(key, { status: line.status, revision: line.revision });
    }
  }
  for (const [key, value] of latest.entries()) {
    const sessionId = key.slice(0, key.indexOf(":"));
    const bucket = result.get(sessionId) ?? { lineCount: 0, unresolvedLines: 0 };
    bucket.lineCount += 1;
    if (isUnresolvedLineStatus(value.status)) bucket.unresolvedLines += 1;
    result.set(sessionId, bucket);
  }
  return result;
}

function assertSessionAccess(actor: ReconciliationActor, row: {
  tenantId: string | null;
  branchId: string | null;
  collectorId: string | null;
}) {
  if (actor.kind === "collector") {
    if (!actor.collectorId || row.collectorId !== actor.collectorId) {
      throw new ReconciliationError("That reconciliation session was not found.");
    }
    return;
  }
  if (!actorAllowsBranch(actor, row.branchId)) {
    throw new ReconciliationError("That reconciliation session was not found.");
  }
}

/**
 * Open a reconciliation session. Re-opening the same tenant/branch/collector/
 * type/period while a non-closed session exists returns the existing session,
 * so a double-click cannot create a duplicate run.
 */
export async function openReconciliationSession(params: {
  type: string;
  branchId?: string | null;
  collectorId?: string | null;
  periodStart: string | Date;
  periodEnd: string | Date;
}): Promise<SessionOpenedResponse> {
  const actor = await resolveReconciliationActor();

  const start = parseDay(params.periodStart);
  const end = parseDay(params.periodEnd);
  if (!start || !end) return { success: false, error: "Invalid period dates" };
  if (start > end) {
    return { success: false, error: "The period start must be on or before the period end" };
  }
  if ((end.getTime() - start.getTime()) / 86_400_000 > 366) {
    return { success: false, error: "A reconciliation period cannot exceed one year" };
  }
  if (!(RECONCILIATION_TYPES as readonly string[]).includes(params.type)) {
    return { success: false, error: "Unsupported reconciliation session type" };
  }
  if (actor.kind === "collector" && params.type !== "daily_close") {
    return { success: false, error: "Collectors can only open a daily closing review" };
  }
  if (params.type === "daily_close" && !params.collectorId && actor.kind !== "collector") {
    return { success: false, error: "Choose the collector for a daily closing review" };
  }

  try {
    await writeLimit(actor, "finance:reconciliation_session_open");

    let branchId = params.branchId ?? null;
    const collectorId = actor.kind === "collector" ? actor.collectorId : (params.collectorId ?? null);

    if (collectorId) {
      const collector = await db.collector.findFirst({
        where: { id: collectorId, tenantId: actor.ctx.tenantId },
        select: { id: true, branchId: true, status: true },
      });
      if (!collector) return { success: false, error: "That collector was not found." };
      if (actor.kind === "collector" && collector.id !== actor.collectorId) {
        return { success: false, error: "You can only review your own collections" };
      }
      if (!branchId) branchId = collector.branchId ?? null;
      if (collector.branchId && branchId && collector.branchId !== branchId) {
        return { success: false, error: "The collector does not belong to that branch" };
      }
    }

    if (actor.kind === "collector") {
      if (!collectorId) {
        return { success: false, error: "Your collector profile is not active" };
      }
      if (actor.collectorStatus !== "active") {
        return { success: false, error: "Your collector profile is not active" };
      }
      if (!branchId) {
        return { success: false, error: "Your collector profile has no branch" };
      }
    } else if (!branchId) {
      if (!actor.isCompanyWide) {
        return { success: false, error: "Select a branch inside your scope" };
      }
    } else {
      await assertActorBranchWrite(actor, branchId);
    }

    const existing = await db.susuReconciliation.findFirst({
      where: {
        tenantId: actor.ctx.tenantId,
        branchId: branchId ?? null,
        collectorId: collectorId ?? null,
        type: params.type,
        periodStart: start,
        periodEnd: end,
        status: { not: "closed" },
      },
      include: { branch: { select: { name: true } }, collector: { select: { user: { select: { fullName: true } } } } },
      orderBy: { openedAt: "desc" },
    });
    if (existing) {
      const counts = (await latestLineCounts([existing.id])).get(existing.id) ?? {
        lineCount: 0,
        unresolvedLines: 0,
      };
      return { success: true, data: await sessionView(existing, counts) };
    }

    const created = await db.$transaction(async (tx) => {
      await lockAccountForUpdate(
        tx,
        `recon:session:${actor.ctx.tenantId}:${branchId ?? "all"}:${collectorId ?? "all"}:${params.type}:${start.toISOString()}:${end.toISOString()}`
      );
      const row = await tx.susuReconciliation.create({
        data: {
          tenantId: actor.ctx.tenantId,
          branchId: branchId ?? null,
          collectorId: collectorId ?? null,
          type: params.type,
          status: "open",
          periodStart: start,
          periodEnd: end,
          summaryJson: JSON.stringify({}),
          definitionVersion: RECONCILIATION_DEFINITION_VERSION,
          openedById: actor.ctx.userId,
        },
        include: { branch: { select: { name: true } }, collector: { select: { user: { select: { fullName: true } } } } },
      });
      await createAuditLogTx(tx, {
        userId: actor.ctx.userId,
        tenantId: actor.ctx.tenantId,
        branchId: branchId ?? null,
        action: "susu.reconciliation_session_opened",
        entityType: "susuReconciliation",
        entityId: row.id,
        details: {
          type: params.type,
          branchId,
          collectorId,
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
          financialMutation: false,
        },
      });
      return row;
    });

    revalidatePath("/susu/admin/reconciliation");
    revalidatePath("/collector/reconciliation");
    return {
      success: true,
      data: await sessionView(created, { lineCount: 0, unresolvedLines: 0 }),
    };
  } catch (error) {
    return fail(error);
  }
}

/** List sessions with tenant/branch/collector scope and filters. */
export async function listReconciliationSessions(params?: {
  branchId?: string | null;
  collectorId?: string | null;
  type?: string | null;
  status?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
}): Promise<{ success: boolean; error?: string; data?: { sessions: SusuReconciliationView[]; total: number } }> {
  const actor = await resolveReconciliationActor();
  try {
    const where: Prisma.SusuReconciliationWhereInput = {
      tenantId: actor.ctx.tenantId,
    };
    if (actor.kind === "collector") {
      if (!actor.collectorId) return { success: true, data: { sessions: [], total: 0 } };
      if (params?.collectorId && params.collectorId !== actor.collectorId) {
        return { success: false, error: "You can only see your own reconciliation sessions." };
      }
      where.collectorId = actor.collectorId;
    } else {
      if (params?.branchId !== undefined && params.branchId !== null) {
        if (!actorAllowsBranch(actor, params.branchId)) {
          return { success: false, error: "That branch is outside your scope" };
        }
        where.branchId = params.branchId;
      } else if (!actor.isCompanyWide) {
        where.branchId = { in: actor.branchIds };
      }
      if (params?.collectorId) where.collectorId = params.collectorId;
    }
    if (params?.type) where.type = params.type;
    if (params?.status) where.status = params.status;
    if (params?.from || params?.to) {
      const filters = dateFilters(params.from, params.to);
      if ("error" in filters && filters.error) {
        return { success: false, error: filters.error };
      }
      where.periodStart = filters.start ? { gte: filters.start } : undefined;
      where.periodEnd = filters.end ? { lte: filters.end } : undefined;
    }

    const limit = Math.min(100, Math.max(1, params?.limit ?? 50));
    const [rows, total] = await Promise.all([
      db.susuReconciliation.findMany({
        where,
        include: { branch: { select: { name: true } }, collector: { select: { user: { select: { fullName: true } } } } },
        orderBy: [{ openedAt: "desc" }],
        take: limit,
      }),
      db.susuReconciliation.count({ where }),
    ]);
    const counts = await latestLineCounts(rows.map((row) => row.id));
    const sessions = await Promise.all(
      rows.map((row) =>
        sessionView(row, counts.get(row.id) ?? { lineCount: 0, unresolvedLines: 0 })
      )
    );
    return { success: true, data: { sessions, total } };
  } catch (error) {
    return fail(error);
  }
}

/** One session with every revision, adjustments, closings and raised cases. */
export async function getReconciliationSession(
  sessionId: string
): Promise<SessionViewResponse | null> {
  const actor = await resolveReconciliationActor();
  const row = await db.susuReconciliation.findFirst({
    where: { id: sessionId, tenantId: actor.ctx.tenantId },
    include: {
      branch: { select: { name: true } },
      collector: { select: { user: { select: { fullName: true } } } },
      lines: { orderBy: [{ fingerprint: "asc" }, { revision: "asc" }] },
      adjustments: { orderBy: { proposedAt: "desc" } },
      dailyClosings: {
        include: {
          collector: { select: { user: { select: { fullName: true } } } },
          branch: { select: { name: true } },
        },
        orderBy: { closingDate: "desc" },
      },
      cases: {
        select: {
          id: true,
          caseNumber: true,
          status: true,
          severity: true,
          title: true,
          amountAtStake: true,
          ownerId: true,
        },
        orderBy: { openedAt: "desc" },
      },
    },
  });
  if (!row) return null;
  try {
    assertSessionAccess(actor, row);
  } catch {
    return null;
  }

  const latest = new Map<string, (typeof row.lines)[number]>();
  for (const line of row.lines) {
    const current = latest.get(line.fingerprint);
    if (!current || line.revision > current.revision) latest.set(line.fingerprint, line);
  }
  const latestLines = [...latest.values()].sort(
    (a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime()
  );
  const unresolved = latestLines.filter((line) =>
    isUnresolvedLineStatus(line.status)
  ).length;
  const view = await sessionView(row, {
    lineCount: latestLines.length,
    unresolvedLines: unresolved,
  });

  return {
    success: true,
    data: {
      ...view,
      lines: latestLines.map(toLineView),
      adjustments: row.adjustments.map(toAdjustmentView),
      closings: row.dailyClosings.map(toClosingView),
      cases: row.cases.map((c) => ({
        id: c.id,
        caseNumber: c.caseNumber,
        status: c.status,
        severity: c.severity,
        title: c.title,
        amountAtStake: c.amountAtStake == null ? null : Number(c.amountAtStake),
        ownerId: c.ownerId ?? null,
      })),
    },
  };
}

/**
 * Run detection. Two concurrent calls cannot claim the same session: the
 * status update is the guard, and the advisory lock serialises case/number
 * allocation on PostgreSQL. SQLite serialises writers itself.
 */
export async function reconcileSession(
  sessionId: string
): Promise<SessionReconciledResponse> {
  const actor = await requireReconciliationAdmin();

  try {
    await writeLimit(actor, "finance:reconciliation_run");
    const result = await db.$transaction(async (tx) => {
      await lockAccountForUpdate(tx, `recon:run:${actor.ctx.tenantId}:${sessionId}`);
      const claimed = await tx.susuReconciliation.updateMany({
        where: {
          id: sessionId,
          tenantId: actor.ctx.tenantId,
          status: { in: ["open", "matched", "case_created"] },
        },
        data: { status: "matching", lastRunById: actor.ctx.userId },
      });
      if (claimed.count === 0) {
        const current = await tx.susuReconciliation.findFirst({
          where: { id: sessionId, tenantId: actor.ctx.tenantId },
          select: { status: true },
        });
        if (!current) throw new ReconciliationError("That session was not found.");
        if (current.status === "matching") {
          throw new ReconciliationError("A reconciliation run is already in progress.");
        }
        if (current.status === "closed") {
          throw new ReconciliationError("This session is closed.");
        }
        throw new ReconciliationError("This session cannot be matched in its current state.");
      }

      const session = await tx.susuReconciliation.findFirst({
        where: { id: sessionId, tenantId: actor.ctx.tenantId },
      });
      if (!session) throw new ReconciliationError("That session was not found.");
      if (!actorAllowsBranch(actor, session.branchId)) {
        throw new ReconciliationError("This session is outside your branch scope");
      }

      const findings = await detectDifferences(tx, {
        id: session.id,
        tenantId: session.tenantId,
        branchId: session.branchId,
        collectorId: session.collectorId,
        type: session.type,
        periodStart: session.periodStart,
        periodEnd: session.periodEnd,
      });
      const applied = await applyFindings(tx, session, findings);

      const allLines = await tx.reconciliationLine.findMany({
        where: { sessionId },
        select: {
          fingerprint: true,
          revision: true,
          status: true,
          expectedAmount: true,
          declaredAmount: true,
          physicalAmount: true,
          receivedAmount: true,
          verifiedAmount: true,
          variance: true,
          exceptionCaseId: true,
        },
      });
      const summary = summarizeLines(allLines, new Date());
      const now = new Date();
      await tx.susuReconciliation.update({
        where: { id: sessionId },
        data: {
          status: "matched",
          summaryJson: JSON.stringify(summary),
          definitionVersion: RECONCILIATION_DEFINITION_VERSION,
          runCount: { increment: 1 },
          lastRunAt: now,
          lastRunById: actor.ctx.userId,
        },
      });
      await createAuditLogTx(tx, {
        userId: actor.ctx.userId,
        tenantId: actor.ctx.tenantId,
        branchId: session.branchId,
        action: "susu.reconciliation_session_matched",
        entityType: "susuReconciliation",
        entityId: session.id,
        details: {
          type: session.type,
          created: applied.created,
          updated: applied.updated,
          revisions: applied.revisions,
          unchanged: applied.unchanged,
          summary,
          financialMutation: false,
        },
      });
      return { ...applied, summary };
    });

    revalidatePath("/susu/admin/reconciliation");
    revalidatePath("/collector/reconciliation");
    return {
      success: true,
      data: {
        lines: result.findings.length,
        created: result.created,
        updated: result.updated,
        revisions: result.revisions,
        unchanged: result.unchanged,
        summary: result.summary,
      },
    };
  } catch (error) {
    return fail(error);
  }
}

/** Acknowledge a reviewed session without deleting its observations. */
export async function reviewReconciliationSession(params: {
  sessionId: string;
  note?: string;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_review");
    const row = await db.susuReconciliation.findFirst({
      where: { id: params.sessionId, tenantId: actor.ctx.tenantId },
    });
    if (!row) return { success: false, error: "That session was not found." };
    if (!actorAllowsBranch(actor, row.branchId)) {
      return { success: false, error: "This session is outside your branch scope" };
    }
    if (!["matched", "case_created"].includes(row.status)) {
      return { success: false, error: "Run matching before reviewing this session." };
    }
    await db.$transaction(async (tx) => {
      await tx.susuReconciliation.update({
        where: { id: row.id },
        data: { status: "reviewed" },
      });
      await createAuditLogTx(tx, {
        userId: actor.ctx.userId,
        tenantId: actor.ctx.tenantId,
        branchId: row.branchId,
        action: "susu.reconciliation_session_reviewed",
        entityType: "susuReconciliation",
        entityId: row.id,
        details: { note: params.note?.trim() ?? null, financialMutation: false },
      });
    });
    revalidatePath("/susu/admin/reconciliation");
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

/** Close a reviewed session. Closed sessions are immutable. */
export async function closeReconciliationSession(params: {
  sessionId: string;
  reason: string;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  const reason = params.reason?.trim() ?? "";
  if (reason.length < 5) {
    return { success: false, error: "Record a close reason of at least 5 characters." };
  }
  try {
    await writeLimit(actor, "finance:reconciliation_close");
    const row = await db.susuReconciliation.findFirst({
      where: { id: params.sessionId, tenantId: actor.ctx.tenantId },
    });
    if (!row) return { success: false, error: "That session was not found." };
    if (!actorAllowsBranch(actor, row.branchId)) {
      return { success: false, error: "This session is outside your branch scope" };
    }
    if (!["matched", "reviewed", "case_created"].includes(row.status)) {
      return { success: false, error: "Only a matched session can be closed." };
    }
    await db.$transaction(async (tx) => {
      const now = new Date();
      await tx.susuReconciliation.update({
        where: { id: row.id },
        data: {
          status: "closed",
          closedAt: now,
          closedById: actor.ctx.userId,
          closeReason: reason,
        },
      });
      await createAuditLogTx(tx, {
        userId: actor.ctx.userId,
        tenantId: actor.ctx.tenantId,
        branchId: row.branchId,
        action: "susu.reconciliation_session_closed",
        entityType: "susuReconciliation",
        entityId: row.id,
        details: { reason, financialMutation: false },
      });
    });
    revalidatePath("/susu/admin/reconciliation");
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

function caseTitleForGroup(
  category: string,
  collectorName: string | null,
  branchName: string | null,
  periodStart: Date,
  periodEnd: Date
): string {
  const label = CASE_CATEGORY_LABELS[category] ?? "Reconciliation";
  const who = collectorName ?? branchName ?? "Company-wide";
  const day =
    periodStart.getTime() === periodEnd.getTime()
      ? formatBusinessDay(periodStart)
      : `${formatBusinessDay(periodStart)} to ${formatBusinessDay(periodEnd)}`;
  return `${label} — ${who} — ${day}`;
}

/**
 * Raise one case per branch/collector/category for unresolved lines that are
 * not already linked. Idempotent: rerunning only sees case-free lines.
 */
export async function raiseCasesForSession(
  sessionId: string
): Promise<{ success: boolean; error?: string; data?: { created: number; cases: Array<{ id: string; caseNumber: string }> } }> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_raise_cases");
    const created = await db.$transaction(async (tx) => {
      await lockAccountForUpdate(tx, `recon:cases:${actor.ctx.tenantId}:${sessionId}`);
      const session = await tx.susuReconciliation.findFirst({
        where: { id: sessionId, tenantId: actor.ctx.tenantId },
        include: {
          branch: { select: { name: true } },
          collector: { select: { user: { select: { fullName: true } } } },
        },
      });
      if (!session) throw new ReconciliationError("That session was not found.");
      if (!actorAllowsBranch(actor, session.branchId)) {
        throw new ReconciliationError("This session is outside your branch scope");
      }
      if (session.status === "closed") {
        throw new ReconciliationError("This session is closed.");
      }
      if (session.status === "matching") {
        throw new ReconciliationError("Wait for the current matching run to finish.");
      }

      const lines = await tx.reconciliationLine.findMany({
        where: { sessionId },
      });
      const latest = new Map<string, (typeof lines)[number]>();
      for (const line of lines) {
        const current = latest.get(line.fingerprint);
        if (!current || line.revision > current.revision) latest.set(line.fingerprint, line);
      }
      const candidates = [...latest.values()].filter(
        (line) => isUnresolvedLineStatus(line.status) && !line.exceptionCaseId
      );

      const groups = new Map<string, typeof candidates>();
      for (const line of candidates) {
        const category = caseCategoryForFinding(line.entityType);
        const key = `${line.branchId ?? "none"}|${line.collectorId ?? "none"}|${category}`;
        const group = groups.get(key) ?? [];
        group.push(line);
        groups.set(key, group);
      }

      const collectorIds = [
        ...new Set(
          candidates
            .map((line) => line.collectorId)
            .filter((id): id is string => Boolean(id))
        ),
      ];
      const collectors = collectorIds.length
        ? await tx.collector.findMany({
            where: { tenantId: actor.ctx.tenantId, id: { in: collectorIds } },
            select: { id: true, user: { select: { fullName: true } } },
          })
        : [];
      const collectorName = new Map(collectors.map((c) => [c.id, c.user.fullName]));

      const results: Array<{ id: string; caseNumber: string }> = [];
      for (const group of groups.values()) {
        const first = group[0];
        const category = caseCategoryForFinding(first.entityType);
        const amountAtStake = money(
          group.reduce((sum, line) => sum + Math.abs(Number(line.variance)), 0)
        );
        const severity = highestSeverity(group.map((line) => line.severity ?? "low"));
        const links = group.map((line) => ({
          entityType: line.entityType,
          entityId: line.entityId,
          note: `${LINE_STATUS_LABELS[line.status] ?? line.status}: ${line.reason ?? ""}`.slice(0, 240),
        }));
        const createdCase = await createExceptionCaseTx(tx, {
          tenantId: actor.ctx.tenantId,
          branchId: first.branchId,
          collectorId: first.collectorId,
          sourceSessionId: session.id,
          category,
          severity,
          title: caseTitleForGroup(
            category,
            first.collectorId ? (collectorName.get(first.collectorId) ?? null) : null,
            session.branch?.name ?? null,
            session.periodStart,
            session.periodEnd
          ),
          description: `${group.length} reconciliation line(s) require review. ${group
            .map((line) => line.reason)
            .filter(Boolean)
            .slice(0, 3)
            .join(" ")}`,
          amountAtStake,
          links,
          actorId: actor.ctx.userId,
          actorRole: actor.ctx.role,
        });
        await tx.reconciliationLine.updateMany({
          where: { id: { in: group.map((line) => line.id) } },
          data: { exceptionCaseId: createdCase.id },
        });
        results.push({ id: createdCase.id, caseNumber: createdCase.caseNumber });
      }

      await tx.susuReconciliation.update({
        where: { id: session.id },
        data: { status: "case_created" },
      });
      await createAuditLogTx(tx, {
        userId: actor.ctx.userId,
        tenantId: actor.ctx.tenantId,
        branchId: session.branchId,
        action: "susu.reconciliation_cases_raised",
        entityType: "susuReconciliation",
        entityId: session.id,
        details: {
          cases: results.map((c) => c.caseNumber),
          count: results.length,
          financialMutation: false,
        },
      });
      return results;
    });

    revalidatePath("/susu/admin/reconciliation");
    revalidatePath("/susu/admin/reconciliation/exceptions");
    return { success: true, data: { created: created.length, cases: created } };
  } catch (error) {
    return fail(error);
  }
}

/** Propose an adjustment: a reference to an authorised correction, not a post. */
export async function proposeReconciliationAdjustment(params: {
  sessionId: string;
  adjustmentType: string;
  referenceType: string;
  referenceId: string;
  declaredAmount?: number | null;
  correctedAmount?: number | null;
  reason?: string;
  evidenceRef?: string | null;
  caseId?: string | null;
}): Promise<AdjustmentResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_adjustment_propose");
    if (!ADJUSTMENT_TYPES.has(params.adjustmentType)) {
      return { success: false, error: "Unsupported adjustment type" };
    }
    const referenceType = params.referenceType?.trim();
    const referenceId = params.referenceId?.trim();
    if (!referenceType || !referenceId) {
      return { success: false, error: "Choose the correction workflow and record it" };
    }
    const reason = params.reason?.trim() ?? "";
    if (reason.length < 5) {
      return { success: false, error: "Record a reason of at least 5 characters." };
    }
    const session = await db.susuReconciliation.findFirst({
      where: { id: params.sessionId, tenantId: actor.ctx.tenantId },
    });
    if (!session) return { success: false, error: "Session not found" };
    if (session.status === "closed") {
      return { success: false, error: "This session is closed" };
    }
    if (!actorAllowsBranch(actor, session.branchId)) {
      return { success: false, error: "This session is outside your branch scope" };
    }
    if (params.caseId) {
      const linkedCase = await db.reconciliationExceptionCase.findFirst({
        where: { id: params.caseId, tenantId: actor.ctx.tenantId },
        select: {
          id: true,
          tenantId: true,
          branchId: true,
          collectorId: true,
          ownerId: true,
          status: true,
        },
      });
      if (!linkedCase) return { success: false, error: "That case was not found." };
      assertCanManageCase(actor, linkedCase);
    }

    const declared = params.declaredAmount == null ? null : money(params.declaredAmount);
    const corrected = params.correctedAmount == null ? null : money(params.correctedAmount);
    if (
      (params.declaredAmount != null && !Number.isFinite(Number(params.declaredAmount))) ||
      (params.correctedAmount != null && !Number.isFinite(Number(params.correctedAmount)))
    ) {
      return { success: false, error: "Enter valid amounts" };
    }
    const variance = money((corrected ?? 0) - (declared ?? 0));

    const existing = await db.reconciliationAdjustment.findFirst({
      where: {
        tenantId: actor.ctx.tenantId,
        sessionId: session.id,
        adjustmentType: params.adjustmentType,
        referenceType,
        referenceId,
        status: "proposed",
      },
    });
    if (existing) return { success: true, data: toAdjustmentView(existing) };

    const adjustment = await db.$transaction(async (tx) => {
      const created = await tx.reconciliationAdjustment.create({
        data: {
          tenantId: actor.ctx.tenantId,
          sessionId: session.id,
          adjustmentType: params.adjustmentType,
          referenceType,
          referenceId,
          declaredAmount: declared,
          correctedAmount: corrected,
          variance,
          status: "proposed",
          reason,
          evidenceRef: params.evidenceRef?.trim() || null,
          caseId: params.caseId ?? null,
          proposedById: actor.ctx.userId,
        },
      });
      await createAuditLogTx(tx, {
        userId: actor.ctx.userId,
        tenantId: actor.ctx.tenantId,
        branchId: session.branchId,
        action: "susu.reconciliation_adjustment_proposed",
        entityType: "reconciliationAdjustment",
        entityId: created.id,
        details: {
          adjustmentType: params.adjustmentType,
          referenceType,
          referenceId,
          variance,
          caseId: params.caseId ?? null,
          financialMutation: false,
        },
      });
      return created;
    });
    revalidatePath("/susu/admin/reconciliation");
    return { success: true, data: toAdjustmentView(adjustment) };
  } catch (error) {
    return fail(error);
  }
}

/** Link a proposed adjustment to the authorised correction that was posted. */
export async function linkReconciliationAdjustment(params: {
  adjustmentId: string;
  referenceType: string;
  referenceId: string;
}): Promise<AdjustmentResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_adjustment_link");
    const adjustment = await db.reconciliationAdjustment.findFirst({
      where: { id: params.adjustmentId, tenantId: actor.ctx.tenantId },
      include: { session: true },
    });
    if (!adjustment) return { success: false, error: "Adjustment not found" };
    if (adjustment.status !== "proposed") {
      return { success: false, error: "Only a proposed adjustment can be linked" };
    }
    if (!actorAllowsBranch(actor, adjustment.session.branchId)) {
      return { success: false, error: "This adjustment is outside your branch scope" };
    }
    if (!params.referenceType?.trim() || !params.referenceId?.trim()) {
      return { success: false, error: "Choose the correction that was posted." };
    }

    const updated = await db.$transaction(async (tx) => {
      const row = await tx.reconciliationAdjustment.update({
        where: { id: adjustment.id },
        data: {
          status: "linked",
          referenceType: params.referenceType.trim(),
          referenceId: params.referenceId.trim(),
          linkedById: actor.ctx.userId,
          linkedAt: new Date(),
        },
      });
      await createAuditLogTx(tx, {
        userId: actor.ctx.userId,
        tenantId: actor.ctx.tenantId,
        branchId: adjustment.session.branchId,
        action: "susu.reconciliation_adjustment_linked",
        entityType: "reconciliationAdjustment",
        entityId: adjustment.id,
        details: {
          referenceType: params.referenceType.trim(),
          referenceId: params.referenceId.trim(),
          financialMutation: false,
        },
      });
      return row;
    });
    revalidatePath("/susu/admin/reconciliation");
    return { success: true, data: toAdjustmentView(updated) };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Daily collector closing
// ---------------------------------------------------------------------------

async function computeClosingTotals(
  tx: Prisma.TransactionClient,
  params: { tenantId: string; collectorId: string; day: Date }
) {
  const dayEnd = addDaysUtc(params.day, 1);
  const contributions = await tx.contribution.findMany({
    where: {
      tenantId: params.tenantId,
      collectorId: params.collectorId,
      channel: "collector",
      reversedAt: null,
      collectionDate: { gte: params.day, lt: dayEnd },
    },
    select: { amount: true, recordedDeviceId: true },
  });
  const recorded = money(
    contributions.reduce((sum, c) => sum + Number(c.amount), 0)
  );
  const synced = money(
    contributions
      .filter((c) => c.recordedDeviceId)
      .reduce((sum, c) => sum + Number(c.amount), 0)
  );
  const pendingTransactions = await tx.offlineTransaction.findMany({
    where: {
      tenantId: params.tenantId,
      status: { in: ["pending_sync", "syncing", "failed"] },
      localTimestamp: { gte: params.day, lt: dayEnd },
    },
    select: { userId: true, status: true },
  });
  const collector = await tx.collector.findFirst({
    where: { id: params.collectorId, tenantId: params.tenantId },
    select: { userId: true },
  });
  const relevant = pendingTransactions.filter(
    (row) => row.userId === collector?.userId
  );
  const failedAttempts = await tx.offlineSyncAttempt.findMany({
    where: {
      tenantId: params.tenantId,
      collectorId: params.collectorId,
      outcome: { in: ["rejected", "failed"] },
      createdAt: { gte: params.day, lt: dayEnd },
    },
    select: { amount: true },
  });
  const failedAmount = money(
    failedAttempts.reduce((sum, attempt) => sum + Number(attempt.amount ?? 0), 0)
  );
  return {
    recorded,
    synced,
    pendingAmount: failedAmount,
    pendingCount: relevant.filter((r) => r.status !== "failed").length,
    failedCount:
      relevant.filter((r) => r.status === "failed").length + failedAttempts.length,
  };
}

function assertClosingAccess(actor: ReconciliationActor, row: {
  tenantId: string | null;
  branchId: string | null;
  collectorId: string;
}) {
  if (row.tenantId !== actor.ctx.tenantId) {
    throw new ReconciliationError("That daily closing was not found.");
  }
  if (actor.kind === "collector") {
    if (!actor.collectorId || row.collectorId !== actor.collectorId) {
      throw new ReconciliationError("That daily closing was not found.");
    }
    return;
  }
  if (!actorAllowsBranch(actor, row.branchId)) {
    throw new ReconciliationError("That daily closing was not found.");
  }
}

/**
 * Open (or return) the collector's closing for one business day. Contributions
 * are counted from server records only; a client cannot supply expected cash.
 */
export async function openDailyCollectorClosing(params: {
  collectorId?: string | null;
  closingDate?: string | Date;
}): Promise<DailyClosingResponse> {
  const actor = await resolveReconciliationActor();
  try {
    const day = parseDay(params.closingDate ?? new Date());
    if (!day) return { success: false, error: "Choose a valid business day" };
    if (day.getTime() > normalizeBusinessDay(new Date()).getTime()) {
      return { success: false, error: "A future business day cannot be closed" };
    }
    await writeLimit(actor, "finance:daily_closing_open");

    const collectorId =
      actor.kind === "collector" ? actor.collectorId : (params.collectorId ?? null);
    if (!collectorId) return { success: false, error: "Choose the collector" };
    const collector = await db.collector.findFirst({
      where: { id: collectorId, tenantId: actor.ctx.tenantId },
      select: { id: true, branchId: true, status: true },
    });
    if (!collector) return { success: false, error: "That collector was not found." };
    if (actor.kind === "collector" && collector.id !== actor.collectorId) {
      return { success: false, error: "You can only close your own collections" };
    }
    if (actor.kind === "collector" && collector.status !== "active") {
      return { success: false, error: "Your collector profile is not active" };
    }
    if (actor.kind === "admin") {
      await assertActorBranchWrite(actor, collector.branchId);
    }

    const existing = await db.dailyCollectorClosing.findFirst({
      where: {
        tenantId: actor.ctx.tenantId,
        collectorId: collector.id,
        closingDate: day,
      },
      include: {
        collector: { select: { user: { select: { fullName: true } } } },
        branch: { select: { name: true } },
      },
    });
    if (existing) return { success: true, data: toClosingView(existing) };

    const created = await db.$transaction(async (tx) => {
      await lockAccountForUpdate(
        tx,
        `recon:daily-closing-open:${actor.ctx.tenantId}:${collector.id}:${day.toISOString()}`
      );
      // Another request may have created the same collector/day while this one
      // waited for the lock. Re-read inside the lock so opening is idempotent.
      const raced = await tx.dailyCollectorClosing.findFirst({
        where: {
          tenantId: actor.ctx.tenantId,
          collectorId: collector.id,
          closingDate: day,
        },
        include: {
          collector: { select: { user: { select: { fullName: true } } } },
          branch: { select: { name: true } },
        },
      });
      if (raced) return raced;

      const totals = await computeClosingTotals(tx, {
        tenantId: actor.ctx.tenantId,
        collectorId: collector.id,
        day,
      });
      const row = await tx.dailyCollectorClosing.create({
        data: {
          tenantId: actor.ctx.tenantId,
          branchId: collector.branchId,
          collectorId: collector.id,
          closingDate: day,
          status: "open",
          expectedCash: totals.recorded,
          contributionsRecorded: totals.recorded,
          contributionsSynced: totals.synced,
          contributionsPending: totals.pendingAmount,
          pendingSyncCount: totals.pendingCount,
          failedSyncCount: totals.failedCount,
          createdById: actor.ctx.userId,
        },
        include: {
          collector: { select: { user: { select: { fullName: true } } } },
          branch: { select: { name: true } },
        },
      });
      await createAuditLogTx(tx, {
        userId: actor.ctx.userId,
        tenantId: actor.ctx.tenantId,
        branchId: collector.branchId,
        action: "susu.daily_closing_opened",
        entityType: "dailyCollectorClosing",
        entityId: row.id,
        details: {
          collectorId: collector.id,
          closingDate: formatBusinessDay(day),
          expectedCash: totals.recorded,
          pendingSyncCount: totals.pendingCount,
          financialMutation: false,
        },
      });
      return row;
    });

    revalidatePath("/susu/admin/reconciliation");
    revalidatePath("/collector/reconciliation");
    return { success: true, data: toClosingView(created) };
  } catch (error) {
    return fail(error);
  }
}

async function loadClosingForActor(closingId: string, actor: ReconciliationActor) {
  const row = await db.dailyCollectorClosing.findFirst({
    where: { id: closingId, tenantId: actor.ctx.tenantId },
    include: {
      collector: { select: { user: { select: { fullName: true } } } },
      branch: { select: { name: true } },
    },
  });
  if (!row) throw new ReconciliationError("That daily closing was not found.");
  assertClosingAccess(actor, row);
  return row;
}

/** Collector (or an authorised administrator) declares the physical cash. */
export async function declareDailyClosing(params: {
  closingId: string;
  declaredCash: number;
  note?: string;
  evidenceRef?: string;
}): Promise<DailyClosingResponse> {
  const actor = await resolveReconciliationActor();
  try {
    await writeLimit(actor, "finance:daily_closing_declare");
    const row = await loadClosingForActor(params.closingId, actor);
    if (row.status !== "open") {
      return { success: false, error: "This closing has already been declared." };
    }
    const declared = money(params.declaredCash);
    if (!Number.isFinite(Number(params.declaredCash)) || declared < 0) {
      return { success: false, error: "Enter a valid declared cash amount" };
    }
    const expected = Number(row.expectedCash);
    const difference = money(expected - declared);
    const evidenceRef = params.evidenceRef?.trim() || null;
    if (Math.abs(difference) > 0.005 && !evidenceRef) {
      return {
        success: false,
        error: "A difference from recorded contributions requires an evidence reference.",
      };
    }

    const updated = await db.$transaction(async (tx) => {
      const claimed = await tx.dailyCollectorClosing.updateMany({
        where: { id: row.id, status: "open" },
        data: {
          status: "declared",
          declaredCash: declared,
          declaredAt: new Date(),
          declaredById: actor.ctx.userId,
          declarationNote: params.note?.trim().slice(0, 1000) ?? null,
          declarationEvidenceRef: evidenceRef,
          varianceExpectedVsDeclared: difference,
          outstandingAmount: Math.max(0, difference),
        },
      });
      if (claimed.count === 0) {
        throw new ReconciliationError("This closing has already been declared.");
      }
      await createAuditLogTx(tx, {
        userId: actor.ctx.userId,
        tenantId: actor.ctx.tenantId,
        branchId: row.branchId,
        action: "susu.daily_closing_declared",
        entityType: "dailyCollectorClosing",
        entityId: row.id,
        details: {
          expectedCash: expected,
          declaredCash: declared,
          variance: difference,
          evidenceRef,
          financialMutation: false,
        },
      });
      return tx.dailyCollectorClosing.findUniqueOrThrow({
        where: { id: row.id },
        include: {
          collector: { select: { user: { select: { fullName: true } } } },
          branch: { select: { name: true } },
        },
      });
    });
    revalidatePath("/susu/admin/reconciliation");
    revalidatePath("/collector/reconciliation");
    return { success: true, data: toClosingView(updated) };
  } catch (error) {
    return fail(error);
  }
}

/** Record the physical handover from the collector to the office. */
export async function recordDailyClosingHandover(params: {
  closingId: string;
  handoverAmount: number;
  note?: string;
  evidenceRef?: string;
}): Promise<DailyClosingResponse> {
  const actor = await resolveReconciliationActor();
  try {
    await writeLimit(actor, "finance:daily_closing_handover");
    const row = await loadClosingForActor(params.closingId, actor);
    if (row.status !== "declared") {
      return { success: false, error: "Declare the cash before recording a handover." };
    }
    const handover = money(params.handoverAmount);
    if (!Number.isFinite(Number(params.handoverAmount)) || handover < 0) {
      return { success: false, error: "Enter a valid handover amount" };
    }
    const declared = Number(row.declaredCash ?? 0);
    const expected = Number(row.expectedCash);
    const difference = money(declared - handover);
    const evidenceRef = params.evidenceRef?.trim() || null;
    if (Math.abs(difference) > 0.005 && !evidenceRef) {
      return {
        success: false,
        error: "A handover different from the declaration requires an evidence reference.",
      };
    }
    if (actor.kind === "admin" && row.declaredById === actor.ctx.userId) {
      return {
        success: false,
        error: "The person who declared the cash cannot also record its handover.",
      };
    }

    const updated = await db.$transaction(async (tx) => {
      const claimed = await tx.dailyCollectorClosing.updateMany({
        where: { id: row.id, status: "declared" },
        data: {
          status: "handed_over",
          handoverAmount: handover,
          handedOverAt: new Date(),
          handedOverById: actor.ctx.userId,
          handoverEvidenceRef: evidenceRef,
          varianceDeclaredVsReceived: difference,
          varianceExpectedVsReceived: money(expected - handover),
          outstandingAmount: Math.max(0, money(expected - handover)),
        },
      });
      if (claimed.count === 0) {
        throw new ReconciliationError("This closing is no longer awaiting handover.");
      }
      await createAuditLogTx(tx, {
        userId: actor.ctx.userId,
        tenantId: actor.ctx.tenantId,
        branchId: row.branchId,
        action: "susu.daily_closing_handed_over",
        entityType: "dailyCollectorClosing",
        entityId: row.id,
        details: {
          declaredCash: declared,
          handoverAmount: handover,
          variance: difference,
          evidenceRef,
          financialMutation: false,
        },
      });
      return tx.dailyCollectorClosing.findUniqueOrThrow({
        where: { id: row.id },
        include: {
          collector: { select: { user: { select: { fullName: true } } } },
          branch: { select: { name: true } },
        },
      });
    });
    revalidatePath("/susu/admin/reconciliation");
    revalidatePath("/collector/reconciliation");
    return { success: true, data: toClosingView(updated) };
  } catch (error) {
    return fail(error);
  }
}

/** Office staff count and receive the cash. They cannot be the declarer. */
export async function receiveDailyClosing(params: {
  closingId: string;
  receivedAmount: number;
  note?: string;
  evidenceRef?: string;
}): Promise<DailyClosingResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:daily_closing_receive");
    const row = await loadClosingForActor(params.closingId, actor);
    if (row.status !== "handed_over") {
      return { success: false, error: "Record the collector's handover before receiving cash." };
    }
    const received = money(params.receivedAmount);
    if (!Number.isFinite(Number(params.receivedAmount)) || received < 0) {
      return { success: false, error: "Enter a valid received cash amount" };
    }
    if (
      row.declaredById === actor.ctx.userId ||
      row.handedOverById === actor.ctx.userId
    ) {
      return {
        success: false,
        error: "The person who declared or handed over the cash cannot receive it.",
      };
    }
    const expected = Number(row.expectedCash);
    const declared = Number(row.declaredCash ?? 0);
    const handover = Number(row.handoverAmount ?? 0);
    const variance = money(expected - received);
    const evidenceRef = params.evidenceRef?.trim() || null;
    if (Math.abs(variance) > 0.005 && !evidenceRef) {
      return {
        success: false,
        error: "A cash difference requires a receipt evidence reference.",
      };
    }

    const updated = await db.$transaction(async (tx) => {
      const claimed = await tx.dailyCollectorClosing.updateMany({
        where: { id: row.id, status: "handed_over" },
        data: {
          status: "received",
          receivedAmount: received,
          receivedAt: new Date(),
          receivedById: actor.ctx.userId,
          receiptNote: params.note?.trim().slice(0, 1000) ?? null,
          receiptEvidenceRef: evidenceRef,
          varianceExpectedVsDeclared: money(expected - declared),
          varianceDeclaredVsReceived: money(declared - received),
          varianceExpectedVsReceived: variance,
          outstandingAmount: Math.max(0, variance),
        },
      });
      if (claimed.count === 0) {
        throw new ReconciliationError("This closing is no longer awaiting receipt.");
      }
      await createAuditLogTx(tx, {
        userId: actor.ctx.userId,
        tenantId: actor.ctx.tenantId,
        branchId: row.branchId,
        action: "susu.daily_closing_received",
        entityType: "dailyCollectorClosing",
        entityId: row.id,
        details: {
          expectedCash: expected,
          declaredCash: declared,
          handoverAmount: handover,
          receivedAmount: received,
          variance,
          evidenceRef,
          financialMutation: false,
        },
      });
      return tx.dailyCollectorClosing.findUniqueOrThrow({
        where: { id: row.id },
        include: {
          collector: { select: { user: { select: { fullName: true } } } },
          branch: { select: { name: true } },
        },
      });
    });
    revalidatePath("/susu/admin/reconciliation");
    return { success: true, data: toClosingView(updated) };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Close the received closing. Balanced requires zero variance and no pending
 * sync. Any difference raises exactly one linked exception case.
 */
export async function closeDailyClosing(params: {
  closingId: string;
  note?: string;
}): Promise<DailyClosingResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:daily_closing_close");
    const row = await loadClosingForActor(params.closingId, actor);
    if (row.status === "balanced" || row.status === "exception") {
      return { success: true, data: toClosingView(row) };
    }
    if (row.status !== "received") {
      return {
        success: false,
        error: "Receive and count the cash before closing this day.",
      };
    }
    const expected = Number(row.expectedCash);
    const declared = Number(row.declaredCash ?? 0);
    const received = Number(row.receivedAmount ?? 0);
    const variance = money(expected - received);
    const pendingCount = row.pendingSyncCount;
    const balanced = Math.abs(variance) <= 0.005 && pendingCount === 0;

    const updated = await db.$transaction(async (tx) => {
      await lockAccountForUpdate(
        tx,
        `recon:daily-close:${actor.ctx.tenantId}:${row.collectorId}:${row.closingDate.toISOString()}`
      );
      // Re-read after the lock. A concurrent close may already have moved the
      // row and created the single exception case; returning that row keeps a
      // retry idempotent instead of creating a second case.
      const current = await tx.dailyCollectorClosing.findUniqueOrThrow({
        where: { id: row.id },
        include: {
          collector: { select: { user: { select: { fullName: true } } } },
          branch: { select: { name: true } },
        },
      });
      if (current.status !== "received") return current;
      let exceptionCaseId = current.exceptionCaseId;
      if (!balanced && !exceptionCaseId) {
        const collector = await tx.collector.findFirst({
          where: { id: row.collectorId, tenantId: actor.ctx.tenantId },
          select: { user: { select: { fullName: true } } },
        });
        const createdCase = await createExceptionCaseTx(tx, {
          tenantId: actor.ctx.tenantId,
          branchId: row.branchId,
          collectorId: row.collectorId,
          category: "daily_close",
          severity: highestSeverity([
            Math.abs(variance) >= 500 ? "high" : Math.abs(variance) >= 100 ? "medium" : "low",
          ]),
          title: `Daily close difference — ${collector?.user.fullName ?? "Collector"} — ${formatBusinessDay(
            row.closingDate
          )}`,
          description:
            variance > 0
              ? "Cash received is less than the contributions recorded for this collector."
              : variance < 0
                ? "Cash received is more than the contributions recorded for this collector."
                : "Field contributions are still awaiting synchronization.",
          amountAtStake: Math.max(Math.abs(variance), Number(row.contributionsPending)),
          evidence: params.note?.trim() || null,
          evidenceRef:
            row.receiptEvidenceRef ??
            row.handoverEvidenceRef ??
            row.declarationEvidenceRef ??
            null,
          links: [
            { entityType: "daily_closing", entityId: row.id },
            { entityType: "collector", entityId: row.collectorId },
          ],
          actorId: actor.ctx.userId,
          actorRole: actor.ctx.role,
        });
        exceptionCaseId = createdCase.id;
      }

      const claimed = await tx.dailyCollectorClosing.updateMany({
        where: { id: row.id, status: "received" },
        data: {
          status: balanced ? "balanced" : "exception",
          varianceExpectedVsDeclared: money(expected - declared),
          varianceDeclaredVsReceived: money(declared - received),
          varianceExpectedVsReceived: variance,
          outstandingAmount: balanced ? 0 : Math.max(0, variance),
          exceptionCaseId,
        },
      });
      if (claimed.count === 0) {
        throw new ReconciliationError("This closing was already closed by another action.");
      }
      await createAuditLogTx(tx, {
        userId: actor.ctx.userId,
        tenantId: actor.ctx.tenantId,
        branchId: row.branchId,
        action: "susu.daily_closing_closed",
        entityType: "dailyCollectorClosing",
        entityId: row.id,
        details: {
          status: balanced ? "balanced" : "exception",
          expectedCash: expected,
          receivedAmount: received,
          variance,
          pendingSyncCount: pendingCount,
          exceptionCaseId,
          note: params.note?.trim() ?? null,
          financialMutation: false,
        },
      });
      return tx.dailyCollectorClosing.findUniqueOrThrow({
        where: { id: row.id },
        include: {
          collector: { select: { user: { select: { fullName: true } } } },
          branch: { select: { name: true } },
        },
      });
    });

    revalidatePath("/susu/admin/reconciliation");
    revalidatePath("/susu/admin/reconciliation/exceptions");
    revalidatePath("/collector/reconciliation");
    return { success: true, data: toClosingView(updated) };
  } catch (error) {
    return fail(error);
  }
}

/** Read one closing, scoped to the actor. */
export async function getDailyClosing(
  closingId: string
): Promise<DailyClosingResponse | null> {
  const actor = await resolveReconciliationActor();
  const row = await db.dailyCollectorClosing.findFirst({
    where: { id: closingId, tenantId: actor.ctx.tenantId },
    include: {
      collector: { select: { user: { select: { fullName: true } } } },
      branch: { select: { name: true } },
    },
  });
  if (!row) return null;
  try {
    assertClosingAccess(actor, row);
  } catch {
    return null;
  }
  return { success: true, data: toClosingView(row) };
}

/** List daily closings with branch/collector/period filters. */
export async function listDailyClosings(params?: {
  branchId?: string | null;
  collectorId?: string | null;
  status?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
}): Promise<{ success: boolean; error?: string; data?: { closings: DailyClosingView[]; total: number } }> {
  const actor = await resolveReconciliationActor();
  try {
    const filters = dateFilters(params?.from, params?.to);
    if ("error" in filters && filters.error) {
      return { success: false, error: filters.error };
    }
    const where: Prisma.DailyCollectorClosingWhereInput = {
      tenantId: actor.ctx.tenantId,
    };
    if (actor.kind === "collector") {
      if (!actor.collectorId) return { success: true, data: { closings: [], total: 0 } };
      if (params?.collectorId && params.collectorId !== actor.collectorId) {
        return { success: false, error: "You can only see your own daily closings." };
      }
      where.collectorId = actor.collectorId;
    } else {
      if (params?.branchId) {
        if (!actorAllowsBranch(actor, params.branchId)) {
          return { success: false, error: "That branch is outside your scope" };
        }
        where.branchId = params.branchId;
      } else if (!actor.isCompanyWide) {
        where.branchId = { in: actor.branchIds };
      }
      if (params?.collectorId) where.collectorId = params.collectorId;
    }
    if (params?.status) where.status = params.status;
    if (filters.start || filters.end) {
      where.closingDate = {
        ...(filters.start ? { gte: filters.start } : {}),
        ...(filters.end ? { lte: filters.end } : {}),
      };
    }
    const limit = Math.min(200, Math.max(1, params?.limit ?? 100));
    const [rows, total] = await Promise.all([
      db.dailyCollectorClosing.findMany({
        where,
        include: {
          collector: { select: { user: { select: { fullName: true } } } },
          branch: { select: { name: true } },
        },
        orderBy: [{ closingDate: "desc" }, { collectorId: "asc" }],
        take: limit,
      }),
      db.dailyCollectorClosing.count({ where }),
    ]);
    return {
      success: true,
      data: { closings: rows.map(toClosingView), total },
    };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Overview and reporting
// ---------------------------------------------------------------------------

export interface ReconciliationOverview {
  generatedAt: string;
  scope: {
    branchId: string | null;
    collectorId: string | null;
    from: string | null;
    to: string | null;
  };
  sessions: {
    total: number;
    open: number;
    matching: number;
    matched: number;
    reviewed: number;
    caseCreated: number;
    closed: number;
    lastRunAt: Date | null;
  };
  cases: {
    total: number;
    open: number;
    assigned: number;
    underReview: number;
    awaitingEvidence: number;
    escalated: number;
    resolutionProposed: number;
    resolved: number;
    rejected: number;
    reopened: number;
    overdue: number;
    unassigned: number;
    amountsAtStake: number;
  };
  cash: {
    expected: number;
    declared: number;
    handedOver: number;
    received: number;
    outstanding: number;
    pendingSyncAmount: number;
  };
  pendingSync: {
    queuedTransactions: number;
    failedAttempts: number;
  };
  branches: Array<{
    branchId: string | null;
    branchName: string;
    openCases: number;
    overdueCases: number;
    unassignedCases: number;
    outstandingAmount: number;
  }>;
  collectors: Array<{
    collectorId: string;
    collectorName: string;
    branchId: string | null;
    openCases: number;
    overdueCases: number;
    outstandingAmount: number;
    pendingSyncCount: number;
    lastClosingDay: string | null;
  }>;
  patterns: Array<{
    category: string;
    categoryLabel: string;
    count: number;
    amountAtStake: number;
  }>;
}

async function buildOverview(
  actor: ReconciliationActor,
  params?: { branchId?: string | null; collectorId?: string | null; from?: string | null; to?: string | null }
): Promise<ReconciliationOverview> {
  const filters = dateFilters(params?.from, params?.to);
  if ("error" in filters && filters.error) {
    throw new ReconciliationError(filters.error);
  }
  const branchId = params?.branchId ?? null;
  if (branchId && !actorAllowsBranch(actor, branchId)) {
    throw new ReconciliationError("That branch is outside your scope");
  }
  const collectorId =
    actor.kind === "collector" ? actor.collectorId : (params?.collectorId ?? null);
  if (params?.collectorId && actor.kind === "collector" && params.collectorId !== actor.collectorId) {
    throw new ReconciliationError("You can only see your own reconciliation summary");
  }

  const scopeBranchIds = branchId
    ? [branchId]
    : actor.isCompanyWide
      ? null
      : actor.branchIds;

  const sessionWhere: Prisma.SusuReconciliationWhereInput = {
    tenantId: actor.ctx.tenantId,
    ...(scopeBranchIds ? { branchId: { in: scopeBranchIds } } : {}),
    ...(collectorId ? { collectorId } : {}),
  };
  if (filters.start || filters.end) {
    sessionWhere.periodStart = filters.start ? { gte: filters.start } : undefined;
    sessionWhere.periodEnd = filters.end ? { lte: filters.end } : undefined;
  }

  const caseWhere: Prisma.ReconciliationExceptionCaseWhereInput = {
    tenantId: actor.ctx.tenantId,
    ...(scopeBranchIds ? { branchId: { in: scopeBranchIds } } : {}),
    ...(collectorId ? { collectorId } : {}),
  };

  const closingWhere: Prisma.DailyCollectorClosingWhereInput = {
    tenantId: actor.ctx.tenantId,
    ...(scopeBranchIds ? { branchId: { in: scopeBranchIds } } : {}),
    ...(collectorId ? { collectorId } : {}),
  };
  if (filters.start || filters.end) {
    closingWhere.closingDate = {
      ...(filters.start ? { gte: filters.start } : {}),
      ...(filters.end ? { lte: filters.end } : {}),
    };
  }

  const [sessions, cases, closings, queues, failures, sessionAgg, caseAgg] =
    await Promise.all([
      db.susuReconciliation.findMany({
        where: sessionWhere,
        select: { status: true, lastRunAt: true },
        take: 1000,
      }),
      db.reconciliationExceptionCase.findMany({
        where: caseWhere,
        select: {
          status: true,
          severity: true,
          amountAtStake: true,
          ownerId: true,
          dueAt: true,
          branchId: true,
          collectorId: true,
          category: true,
        },
        take: 5000,
      }),
      db.dailyCollectorClosing.findMany({
        where: closingWhere,
        select: {
          collectorId: true,
          branchId: true,
          status: true,
          outstandingAmount: true,
          pendingSyncCount: true,
          failedSyncCount: true,
          closingDate: true,
          expectedCash: true,
          declaredCash: true,
          handoverAmount: true,
          receivedAmount: true,
          contributionsPending: true,
        },
        take: 5000,
      }),
      db.offlineTransaction.count({
        where: {
          tenantId: actor.ctx.tenantId,
          ...(scopeBranchIds ? { branchId: { in: scopeBranchIds } } : {}),
          status: { in: ["pending_sync", "syncing"] },
          ...(collectorId
            ? { userId: { in: await collectorUserIds(actor.ctx.tenantId, collectorId) } }
            : {}),
        },
      }),
      db.offlineSyncAttempt.count({
        where: {
          tenantId: actor.ctx.tenantId,
          outcome: { in: ["rejected", "failed"] },
          resolvedAt: null,
          ...(collectorId ? { collectorId } : {}),
        },
      }),
      db.susuReconciliation.aggregate({
        where: sessionWhere,
        _max: { lastRunAt: true },
      }),
      db.reconciliationExceptionCase.aggregate({
        where: caseWhere,
        _sum: { amountAtStake: true },
      }),
    ]);

  const sessionCounts = {
    total: sessions.length,
    open: 0,
    matching: 0,
    matched: 0,
    reviewed: 0,
    caseCreated: 0,
    closed: 0,
    lastRunAt: sessionAgg._max.lastRunAt ?? null,
  };
  for (const session of sessions) {
    if (session.status === "open") sessionCounts.open += 1;
    else if (session.status === "matching") sessionCounts.matching += 1;
    else if (session.status === "matched") sessionCounts.matched += 1;
    else if (session.status === "reviewed") sessionCounts.reviewed += 1;
    else if (session.status === "case_created") sessionCounts.caseCreated += 1;
    else if (session.status === "closed") sessionCounts.closed += 1;
  }

  const now = Date.now();
  const terminal = new Set(["resolved", "rejected", "dismissed"]);
  const caseCounts = {
    total: cases.length,
    open: 0,
    assigned: 0,
    underReview: 0,
    awaitingEvidence: 0,
    escalated: 0,
    resolutionProposed: 0,
    resolved: 0,
    rejected: 0,
    reopened: 0,
    overdue: 0,
    unassigned: 0,
    amountsAtStake: money(Number(caseAgg._sum.amountAtStake ?? 0)),
  };
  const openCasesByBranchMap = new Map<string, number>();
  const overdueByBranchMap = new Map<string, number>();
  const unassignedByBranchMap = new Map<string, number>();
  const openCasesByCollector = new Map<string, number>();
  const overdueByCollector = new Map<string, number>();
  const patterns = new Map<string, { count: number; amountAtStake: number }>();
  const repeatedHint = new Map<string, number>();

  for (const item of cases) {
    if (item.status === "open") caseCounts.open += 1;
    else if (item.status === "assigned") caseCounts.assigned += 1;
    else if (item.status === "under_review" || item.status === "investigating") caseCounts.underReview += 1;
    else if (item.status === "awaiting_evidence") caseCounts.awaitingEvidence += 1;
    else if (item.status === "escalated") caseCounts.escalated += 1;
    else if (item.status === "resolution_proposed") caseCounts.resolutionProposed += 1;
    else if (item.status === "resolved") caseCounts.resolved += 1;
    else if (item.status === "rejected") caseCounts.rejected += 1;
    else if (item.status === "reopened") caseCounts.reopened += 1;

    const isOpen = !terminal.has(item.status);
    if (!isOpen) continue;
    const branchKey = item.branchId ?? "none";
    openCasesByBranchMap.set(branchKey, (openCasesByBranchMap.get(branchKey) ?? 0) + 1);
    if (!item.ownerId) {
      caseCounts.unassigned += 1;
      unassignedByBranchMap.set(branchKey, (unassignedByBranchMap.get(branchKey) ?? 0) + 1);
    }
    if (item.collectorId) {
      openCasesByCollector.set(
        item.collectorId,
        (openCasesByCollector.get(item.collectorId) ?? 0) + 1
      );
    }
    if (item.dueAt && item.dueAt.getTime() < now) {
      caseCounts.overdue += 1;
      overdueByBranchMap.set(branchKey, (overdueByBranchMap.get(branchKey) ?? 0) + 1);
      if (item.collectorId) {
        overdueByCollector.set(
          item.collectorId,
          (overdueByCollector.get(item.collectorId) ?? 0) + 1
        );
      }
    }
    const patternKey = `${item.category}|${item.branchId ?? "none"}`;
    const previous = patterns.get(patternKey) ?? { count: 0, amountAtStake: 0 };
    previous.count += 1;
    previous.amountAtStake = money(
      previous.amountAtStake + Number(item.amountAtStake ?? 0)
    );
    patterns.set(patternKey, previous);
    if (item.collectorId) {
      const ckey = `${item.collectorId}|${item.category}`;
      repeatedHint.set(ckey, (repeatedHint.get(ckey) ?? 0) + 1);
    }
  }

  const cash = {
    expected: 0,
    declared: 0,
    handedOver: 0,
    received: 0,
    outstanding: 0,
    pendingSyncAmount: 0,
  };
  const collectorClosingMap = new Map<
    string,
    { outstanding: number; pending: number; lastDay: Date | null }
  >();
  for (const closing of closings) {
    cash.expected = money(cash.expected + Number(closing.expectedCash));
    cash.declared = money(cash.declared + Number(closing.declaredCash ?? 0));
    cash.handedOver = money(cash.handedOver + Number(closing.handoverAmount ?? 0));
    cash.received = money(cash.received + Number(closing.receivedAmount ?? 0));
    if (!["balanced"].includes(closing.status)) {
      cash.outstanding = money(cash.outstanding + Math.max(0, Number(closing.outstandingAmount)));
    }
    cash.pendingSyncAmount = money(
      cash.pendingSyncAmount + Number(closing.contributionsPending)
    );
    const existing = collectorClosingMap.get(closing.collectorId) ?? {
      outstanding: 0,
      pending: 0,
      lastDay: null,
    };
    existing.outstanding = money(
      existing.outstanding + Math.max(0, Number(closing.outstandingAmount))
    );
    existing.pending += closing.pendingSyncCount;
    if (!existing.lastDay || closing.closingDate > existing.lastDay) {
      existing.lastDay = closing.closingDate;
    }
    collectorClosingMap.set(closing.collectorId, existing);
  }

  const collectorIds = [
    ...new Set([
      ...collectorClosingMap.keys(),
      ...openCasesByCollector.keys(),
    ]),
  ];
  const collectorRows = collectorIds.length
    ? await db.collector.findMany({
        where: { tenantId: actor.ctx.tenantId, id: { in: collectorIds } },
        select: { id: true, user: { select: { fullName: true } }, branchId: true },
      })
    : [];
  const collectors = collectorRows.map((collector) => ({
    collectorId: collector.id,
    collectorName: collector.user.fullName,
    branchId: collector.branchId ?? null,
    openCases: openCasesByCollector.get(collector.id) ?? 0,
    overdueCases: overdueByCollector.get(collector.id) ?? 0,
    outstandingAmount: money(collectorClosingMap.get(collector.id)?.outstanding ?? 0),
    pendingSyncCount: collectorClosingMap.get(collector.id)?.pending ?? 0,
    lastClosingDay: collectorClosingMap.get(collector.id)?.lastDay
      ? formatBusinessDay(collectorClosingMap.get(collector.id)!.lastDay as Date)
      : null,
  }));

  const branchIds = [
    ...new Set([
      ...openCasesByBranchMap.keys(),
      ...(scopeBranchIds ?? []),
    ]),
  ].filter((id) => id !== "none");
  const branchRows = branchIds.length
    ? await db.location.findMany({
        where: { tenantId: actor.ctx.tenantId, id: { in: branchIds } },
        select: { id: true, name: true },
      })
    : [];
  const branchNames = new Map(branchRows.map((b) => [b.id, b.name]));
  const branches = [...openCasesByBranchMap.keys()].map((key) => {
    const outstanding = closings
      .filter((closing) => (closing.branchId ?? "none") === key)
      .reduce(
        (sum, closing) =>
          sum + Math.max(0, Number(closing.outstandingAmount)),
        0
      );
    return {
      branchId: key === "none" ? null : key,
      branchName: key === "none" ? "Legacy / unassigned" : (branchNames.get(key) ?? "Branch"),
      openCases: openCasesByBranchMap.get(key) ?? 0,
      overdueCases: overdueByBranchMap.get(key) ?? 0,
      unassignedCases: unassignedByBranchMap.get(key) ?? 0,
      outstandingAmount: money(outstanding),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    scope: {
      branchId,
      collectorId,
      from: filters.start ? formatBusinessDay(filters.start) : null,
      to: filters.end ? formatBusinessDay(filters.end) : null,
    },
    sessions: sessionCounts,
    cases: caseCounts,
    cash,
    pendingSync: { queuedTransactions: queues, failedAttempts: failures },
    branches,
    collectors,
    patterns: [...patterns.entries()]
      .map(([key, value]) => {
        const category = key.slice(0, key.indexOf("|"));
        return {
          category,
          categoryLabel: CASE_CATEGORY_LABELS[category] ?? category,
          count: value.count,
          amountAtStake: value.amountAtStake,
        };
      })
      .sort((a, b) => b.count - a.count),
  };
}

async function collectorUserIds(tenantId: string, collectorId: string): Promise<string[]> {
  const collector = await db.collector.findFirst({
    where: { id: collectorId, tenantId },
    select: { userId: true },
  });
  return collector ? [collector.userId] : [];
}

/** Company / branch reconciliation workspace summary. */
export async function getReconciliationOverview(params?: {
  branchId?: string | null;
  collectorId?: string | null;
  from?: string | null;
  to?: string | null;
}): Promise<{ success: boolean; error?: string; data?: ReconciliationOverview }> {
  const actor = await resolveReconciliationActor();
  try {
    return { success: true, data: await buildOverview(actor, params) };
  } catch (error) {
    return fail(error);
  }
}

/** Collector-facing summary: only their own differences and cases. */
export async function getCollectorReconciliationSummary(): Promise<{
  success: boolean;
  error?: string;
  data?: ReconciliationOverview;
}> {
  const actor = await resolveReconciliationActor();
  if (actor.kind !== "collector") {
    return { success: false, error: "This summary is for collectors." };
  }
  if (!actor.collectorId) {
    return { success: false, error: "Your collector profile is not active." };
  }
  try {
    return {
      success: true,
      data: await buildOverview(actor, { collectorId: actor.collectorId }),
    };
  } catch (error) {
    return fail(error);
  }
}

/** Acknowledge one difference. Unresolved lines need a note and evidence/case. */
export async function reviewReconciliationLine(params: {
  lineId: string;
  note: string;
  evidenceRef?: string | null;
  caseId?: string | null;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_line_review");
    if (!params.note?.trim() || params.note.trim().length < 5) {
      return { success: false, error: "Record a review note of at least 5 characters." };
    }
    const line = await db.reconciliationLine.findFirst({
      where: { id: params.lineId, tenantId: actor.ctx.tenantId },
      include: { session: { select: { branchId: true, status: true } } },
    });
    if (!line) return { success: false, error: "That difference was not found." };
    if (!actorAllowsBranch(actor, line.branchId)) {
      return { success: false, error: "This difference is outside your branch scope" };
    }
    if (line.session.status === "closed") {
      return { success: false, error: "This session is closed." };
    }
    if (line.status === "reviewed") {
      return { success: true, data: null };
    }
    const caseId = params.caseId ?? null;
    if (caseId) {
      const found = await db.reconciliationExceptionCase.findFirst({
        where: { id: caseId, tenantId: actor.ctx.tenantId },
        select: {
          id: true,
          tenantId: true,
          branchId: true,
          collectorId: true,
          ownerId: true,
          status: true,
        },
      });
      if (!found) return { success: false, error: "That case was not found." };
      assertCanManageCase(actor, found);
    }
    if (
      isUnresolvedLineStatus(line.status) &&
      !params.evidenceRef?.trim() &&
      !caseId
    ) {
      return {
        success: false,
        error: "Link an exception case or record evidence before acknowledging a difference.",
      };
    }
    if (line.reviewedAt && line.status !== "reviewed") {
      return { success: false, error: "This revision has already been reviewed." };
    }
    await db.$transaction(async (tx) => {
      await tx.reconciliationLine.update({
        where: { id: line.id },
        data: {
          status: "reviewed",
          reviewedAt: new Date(),
          reviewedById: actor.ctx.userId,
          reason: params.note.trim(),
          exceptionCaseId: caseId ?? line.exceptionCaseId,
        },
      });
      await createAuditLogTx(tx, {
        userId: actor.ctx.userId,
        tenantId: actor.ctx.tenantId,
        branchId: line.branchId,
        action: "susu.reconciliation_line_reviewed",
        entityType: "reconciliationLine",
        entityId: line.id,
        details: {
          previousStatus: line.status,
          note: params.note.trim(),
          evidenceRef: params.evidenceRef?.trim() ?? null,
          caseId,
          financialMutation: false,
        },
      });
    });
    revalidatePath("/susu/admin/reconciliation");
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}
