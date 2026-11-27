"use server";

/**
 * Phase 5 — Susu reconciliation exception case lifecycle.
 *
 * This is the one queue for unresolved reconciliation differences. A case is a
 * review record only: resolving, rejecting or reopening it never edits a
 * contribution, remittance, withdrawal or daily account. Any financial
 * correction is posted by its own authorised workflow and linked here.
 *
 * Lifecycle (server-enforced in @/lib/reconciliation-policy):
 *   open -> assigned -> under_review / awaiting_evidence -> escalated
 *        -> resolution_proposed -> resolved | rejected -> reopened
 *
 * Independent approval:
 *   high severity or amountAtStake >= GHS 500 cannot be resolved directly.
 *   A resolution is proposed by one person and approved by another with
 *   company or branch-finance authority. A branch manager alone cannot approve
 *   a high-value financial resolution.
 */

import { db } from "@/lib/db";
import { createAuditLogTx } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import {
  CASE_CATEGORIES,
  CASE_CATEGORY_LABELS,
  CASE_STATUS_LABELS,
  canTransitionCase,
  caseRequiresEvidence,
  isTerminalCaseStatus,
  nextCaseStatuses,
  requiresIndependentApproval,
  type Severity,
} from "@/lib/reconciliation-policy";
import {
  ReconciliationError,
  actorAllowsBranch,
  assertCanManageCase,
  assertCanReadCase,
  assertFinanceAuthority,
  requireReconciliationAdmin,
  resolveReconciliationActor,
  validateCaseOwner,
  type ReconciliationActor,
} from "@/lib/finance/reconciliation-access";
import { createExceptionCaseTx } from "@/lib/finance/reconciliation-cases";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";

interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface CaseEventView {
  id: string;
  type: string;
  actorId: string;
  actorName: string | null;
  actorRole: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  evidenceRef: string | null;
  note: string | null;
  payload: string | null;
  createdAt: Date;
}

export interface ExceptionCaseView {
  id: string;
  caseNumber: string;
  tenantId: string;
  branchId: string | null;
  branchName: string | null;
  collectorId: string | null;
  collectorName: string | null;
  sourceSessionId: string | null;
  sourceSession: {
    id: string;
    type: string;
    status: string;
    periodStart: Date;
    periodEnd: Date;
  } | null;
  category: string;
  categoryLabel: string;
  severity: string;
  status: string;
  statusLabel: string;
  title: string;
  description: string | null;
  amountAtStake: number | null;
  ownerId: string | null;
  ownerName: string | null;
  assignedAt: Date | null;
  dueAt: Date | null;
  evidence: string | null;
  escalatedAt: Date | null;
  escalationLevel: number;
  reopenCount: number;
  resolutionProposedById: string | null;
  resolutionProposedByName: string | null;
  resolutionProposedAt: Date | null;
  proposedResolutionType: string | null;
  proposedResolutionNote: string | null;
  proposedEvidenceRef: string | null;
  resolutionApprovedById: string | null;
  resolutionApprovedByName: string | null;
  resolutionApprovedAt: Date | null;
  resolutionType: string | null;
  resolutionNote: string | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  openedById: string;
  openedByName: string | null;
  openedAt: Date;
  lastActivityAt: Date;
  overdue: boolean;
  requiresEvidence: boolean;
  requiresIndependentApproval: boolean;
  allowedNextStatuses: string[];
  dueDateExtensionCount: number;
  linkCount: number;
  lineCount: number;
  links: Array<{
    id: string;
    entityType: string;
    entityId: string;
    note: string | null;
    createdAt: Date;
  }>;
  lines: Array<{
    id: string;
    entityType: string;
    entityId: string;
    status: string;
    severity: string | null;
    variance: number;
    reason: string | null;
    revision: number;
  }>;
  events: CaseEventView[];
}

export interface CasesListResponse extends ActionResponse {
  data?: {
    cases: ExceptionCaseView[];
    total: number;
    byStatus: Record<string, number>;
  };
}

export interface CaseViewResponse extends ActionResponse {
  data?: ExceptionCaseView;
}

function fail(error: unknown): { success: false; error: string } {
  if (error instanceof ReconciliationError) {
    return { success: false, error: error.message };
  }
  return { success: false, error: "The exception case action could not be completed." };
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

function parseDueAt(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const now = Date.now();
  if (parsed.getTime() < now - 60_000) return null;
  if (parsed.getTime() > now + 366 * 86_400_000) return null;
  return parsed;
}

const RESOLUTION_TYPES = new Set([
  "correction_posted",
  "contribution_reversal",
  "remittance_reversal",
  "withdrawal_adjustment",
  "cash_recovered",
  "no_action",
  "other",
]);

const LINK_ENTITY_TYPES = new Set([
  "contribution",
  "collector_remittance",
  "remittance_discrepancy",
  "daily_closing",
  "susu_reconciliation",
  "susu_account",
  "collector",
  "withdrawal",
  "customer_withdrawal_request",
  "provider_statement_row",
  "branch_liquidity_line",
  "shift",
  "other",
]);

/**
 * Validate a polymorphic link against the tenant database. The client cannot
 * link an arbitrary id, and a branch-restricted actor cannot link another
 * branch's record.
 */
async function validateLinkTarget(
  tx: Prisma.TransactionClient,
  actor: ReconciliationActor,
  caseBranchId: string | null,
  entityType: string,
  entityId: string
): Promise<void> {
  if (!LINK_ENTITY_TYPES.has(entityType)) {
    throw new ReconciliationError("Unsupported record type for this case");
  }
  const tenantId = actor.ctx.tenantId;
  let branchId: string | null | undefined = undefined;
  let found = false;

  switch (entityType) {
    case "contribution": {
      const row = await tx.contribution.findFirst({
        where: { id: entityId, tenantId },
        select: { branchId: true },
      });
      found = Boolean(row);
      branchId = row?.branchId;
      break;
    }
    case "collector_remittance": {
      const row = await tx.collectorRemittance.findFirst({
        where: { id: entityId, tenantId },
        select: { branchId: true, receivingBranchId: true },
      });
      found = Boolean(row);
      branchId = row?.receivingBranchId ?? row?.branchId;
      break;
    }
    case "remittance_discrepancy": {
      const row = await tx.remittanceDiscrepancy.findFirst({
        where: { id: entityId, tenantId },
        select: { remittance: { select: { branchId: true, receivingBranchId: true } } },
      });
      found = Boolean(row);
      branchId = row?.remittance.receivingBranchId ?? row?.remittance.branchId;
      break;
    }
    case "daily_closing": {
      const row = await tx.dailyCollectorClosing.findFirst({
        where: { id: entityId, tenantId },
        select: { branchId: true },
      });
      found = Boolean(row);
      branchId = row?.branchId;
      break;
    }
    case "susu_reconciliation": {
      const row = await tx.susuReconciliation.findFirst({
        where: { id: entityId, tenantId },
        select: { branchId: true },
      });
      found = Boolean(row);
      branchId = row?.branchId;
      break;
    }
    case "susu_account": {
      const row = await tx.susuAccount.findFirst({
        where: { id: entityId, tenantId },
        select: { id: true },
      });
      found = Boolean(row);
      break;
    }
    case "collector": {
      const row = await tx.collector.findFirst({
        where: { id: entityId, tenantId },
        select: { branchId: true },
      });
      found = Boolean(row);
      branchId = row?.branchId;
      break;
    }
    case "withdrawal": {
      const row = await tx.withdrawal.findFirst({
        where: { id: entityId, tenantId },
        select: { branchId: true },
      });
      found = Boolean(row);
      branchId = row?.branchId;
      break;
    }
    case "customer_withdrawal_request": {
      const row = await tx.customerWithdrawalRequest.findFirst({
        where: { id: entityId, tenantId },
        select: { branchId: true },
      });
      found = Boolean(row);
      branchId = row?.branchId;
      break;
    }
    case "provider_statement_row": {
      const row = await tx.providerStatementRow.findFirst({
        where: { id: entityId, tenantId },
        select: { id: true },
      });
      found = Boolean(row);
      break;
    }
    case "branch_liquidity_line": {
      const row = await tx.branchLiquidityLine.findFirst({
        where: { id: entityId, tenantId },
        select: { snapshot: { select: { locationId: true } } },
      });
      found = Boolean(row);
      branchId = row?.snapshot.locationId;
      break;
    }
    case "shift": {
      const row = await tx.shift.findFirst({
        where: { id: entityId, tenantId },
        select: { locationId: true },
      });
      found = Boolean(row);
      branchId = row?.locationId;
      break;
    }
    case "other":
      found = true;
      break;
    default:
      found = false;
  }

  if (!found) throw new ReconciliationError("The selected record was not found.");
  if (branchId && caseBranchId && branchId !== caseBranchId) {
    throw new ReconciliationError("The selected record belongs to another branch");
  }
}

async function recordEvent(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    caseId: string;
    type: string;
    actorId: string;
    actorRole: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    reason?: string | null;
    evidenceRef?: string | null;
    note?: string | null;
    payload?: Record<string, unknown> | null;
  }
): Promise<void> {
  await tx.reconciliationExceptionEvent.create({
    data: {
      tenantId: params.tenantId,
      caseId: params.caseId,
      type: params.type,
      actorId: params.actorId,
      actorRole: params.actorRole,
      fromStatus: params.fromStatus ?? null,
      toStatus: params.toStatus ?? null,
      reason: params.reason?.trim() || null,
      evidenceRef: params.evidenceRef?.trim() || null,
      note: params.note?.trim() || null,
      payload: params.payload ? JSON.stringify(params.payload) : null,
    },
  });
}

type CaseRowWithRelations = Prisma.ReconciliationExceptionCaseGetPayload<{
  include: {
    links: true;
    events: true;
    lines: true;
    collector: { select: { user: { select: { fullName: true } } } };
    sourceSession: { select: { id: true; type: true; status: true; periodStart: true; periodEnd: true } };
  };
}>;

function toCaseView(
  row: CaseRowWithRelations,
  names: Map<string, string>,
  branches: Map<string, string>
): ExceptionCaseView {
  const now = Date.now();
  const overdue =
    Boolean(row.dueAt && row.dueAt.getTime() < now) &&
    !isTerminalCaseStatus(row.status);
  const dueDateExtensionCount = row.events.filter(
    (event) => event.type === "due_date_extended"
  ).length;
  return {
    id: row.id,
    caseNumber: row.caseNumber,
    tenantId: row.tenantId as string,
    branchId: row.branchId ?? null,
    branchName: row.branchId ? (branches.get(row.branchId) ?? null) : null,
    collectorId: row.collectorId ?? null,
    collectorName: row.collector?.user.fullName ?? null,
    sourceSessionId: row.sourceSessionId ?? null,
    sourceSession: row.sourceSession
      ? {
          id: row.sourceSession.id,
          type: row.sourceSession.type,
          status: row.sourceSession.status,
          periodStart: row.sourceSession.periodStart,
          periodEnd: row.sourceSession.periodEnd,
        }
      : null,
    category: row.category,
    categoryLabel: CASE_CATEGORY_LABELS[row.category] ?? row.category,
    severity: row.severity,
    status: row.status,
    statusLabel: CASE_STATUS_LABELS[row.status] ?? row.status,
    title: row.title,
    description: row.description ?? null,
    amountAtStake: row.amountAtStake == null ? null : Number(row.amountAtStake),
    ownerId: row.ownerId ?? null,
    ownerName: row.ownerId ? (names.get(row.ownerId) ?? null) : null,
    assignedAt: row.assignedAt ?? null,
    dueAt: row.dueAt ?? null,
    evidence: row.evidence ?? null,
    escalatedAt: row.escalatedAt ?? null,
    escalationLevel: row.escalationLevel,
    reopenCount: row.reopenCount,
    resolutionProposedById: row.resolutionProposedById ?? null,
    resolutionProposedByName: row.resolutionProposedById
      ? (names.get(row.resolutionProposedById) ?? null)
      : null,
    resolutionProposedAt: row.resolutionProposedAt ?? null,
    proposedResolutionType: row.proposedResolutionType ?? null,
    proposedResolutionNote: row.proposedResolutionNote ?? null,
    proposedEvidenceRef: row.proposedEvidenceRef ?? null,
    resolutionApprovedById: row.resolutionApprovedById ?? null,
    resolutionApprovedByName: row.resolutionApprovedById
      ? (names.get(row.resolutionApprovedById) ?? null)
      : null,
    resolutionApprovedAt: row.resolutionApprovedAt ?? null,
    resolutionType: row.resolutionType ?? null,
    resolutionNote: row.resolutionNote ?? null,
    resolvedById: row.resolvedById ?? null,
    resolvedAt: row.resolvedAt ?? null,
    openedById: row.openedById,
    openedByName: names.get(row.openedById) ?? null,
    openedAt: row.openedAt,
    lastActivityAt: row.lastActivityAt,
    overdue,
    requiresEvidence: caseRequiresEvidence({
      category: row.category,
      severity: row.severity,
      amountAtStake: row.amountAtStake == null ? null : Number(row.amountAtStake),
    }),
    requiresIndependentApproval: requiresIndependentApproval({
      severity: row.severity,
      amountAtStake: row.amountAtStake == null ? null : Number(row.amountAtStake),
    }),
    allowedNextStatuses: nextCaseStatuses(row.status),
    dueDateExtensionCount,
    linkCount: row.links.length,
    lineCount: row.lines.length,
    links: row.links.map((link) => ({
      id: link.id,
      entityType: link.entityType,
      entityId: link.entityId,
      note: link.note ?? null,
      createdAt: link.createdAt,
    })),
    lines: row.lines.map((line) => ({
      id: line.id,
      entityType: line.entityType,
      entityId: line.entityId,
      status: line.status,
      severity: line.severity ?? null,
      variance: Number(line.variance),
      reason: line.reason ?? null,
      revision: line.revision,
    })),
    events: row.events.map((event) => ({
      id: event.id,
      type: event.type,
      actorId: event.actorId,
      actorName: names.get(event.actorId) ?? null,
      actorRole: event.actorRole ?? null,
      fromStatus: event.fromStatus ?? null,
      toStatus: event.toStatus ?? null,
      reason: event.reason ?? null,
      evidenceRef: event.evidenceRef ?? null,
      note: event.note ?? null,
      payload: event.payload ?? null,
      createdAt: event.createdAt,
    })),
  };
}

const CASE_INCLUDE = {
  links: true,
  events: { orderBy: { createdAt: "asc" } },
  lines: { orderBy: [{ fingerprint: "asc" }, { revision: "desc" }] },
  collector: { select: { user: { select: { fullName: true } } } },
  sourceSession: {
    select: { id: true, type: true, status: true, periodStart: true, periodEnd: true },
  },
} satisfies Prisma.ReconciliationExceptionCaseInclude;

async function branchNames(tenantId: string, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map<string, string>();
  const branches = await db.location.findMany({
    where: { tenantId, id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(branches.map((branch) => [branch.id, branch.name]));
}

async function userNames(tenantId: string, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map<string, string>();
  const users = await db.user.findMany({
    where: { tenantId, id: { in: unique } },
    select: { id: true, fullName: true },
  });
  return new Map(users.map((user) => [user.id, user.fullName]));
}

async function findCase(actor: ReconciliationActor, caseId: string) {
  const row = await db.reconciliationExceptionCase.findFirst({
    where: { id: caseId, tenantId: actor.ctx.tenantId },
    include: CASE_INCLUDE,
  });
  if (!row) throw new ReconciliationError("That case was not found.");
  return row;
}

function caseScope(row: {
  id: string;
  tenantId: string | null;
  branchId: string | null;
  collectorId: string | null;
  ownerId: string | null;
  status: string;
}) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    branchId: row.branchId,
    collectorId: row.collectorId,
    ownerId: row.ownerId,
    status: row.status,
  };
}

async function loadManagedCase(actor: ReconciliationActor, caseId: string) {
  const row = await findCase(actor, caseId);
  assertCanManageCase(actor, caseScope(row));
  return row;
}

async function loadReadableCase(actor: ReconciliationActor, caseId: string) {
  const row = await findCase(actor, caseId);
  assertCanReadCase(actor, caseScope(row));
  return row;
}

/** Revalidate both the Susu workspace and the shared exception queue. */
function refresh(caseId: string) {
  revalidatePath("/susu/admin/reconciliation");
  revalidatePath("/susu/admin/reconciliation/exceptions");
  revalidatePath(`/susu/admin/reconciliation/exceptions/${caseId}`);
  revalidatePath("/collector/reconciliation");
  revalidatePath("/admin/reconciliation/exceptions");
}

async function auditCase(
  tx: Prisma.TransactionClient,
  actor: ReconciliationActor,
  row: { id: string; caseNumber: string; branchId: string | null; status: string },
  action: string,
  details: Record<string, unknown>
) {
  await createAuditLogTx(tx, {
    userId: actor.ctx.userId,
    tenantId: actor.ctx.tenantId,
    branchId: row.branchId,
    action,
    entityType: "reconciliationExceptionCase",
    entityId: row.id,
    details: {
      caseNumber: row.caseNumber,
      status: row.status,
      financialMutation: false,
      ...details,
    },
  });
}

/**
 * Open a case manually. Reconciliation sessions raise their own grouped cases;
 * this entry point covers provider statements, liquidity, shifts and linked
 * operational exceptions.
 */
export async function openExceptionCase(params: {
  category: string;
  severity?: string;
  title: string;
  description?: string;
  ownerId?: string | null;
  branchId?: string | null;
  collectorId?: string | null;
  amountAtStake?: number | null;
  dueAt?: string | Date | null;
  evidence?: string | null;
  links?: Array<{ entityType: string; entityId: string; note?: string }>;
}): Promise<{ success: boolean; error?: string; data?: { id: string; caseNumber: string } }> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_case_open");
    const title = params.title?.trim() ?? "";
    if (title.length < 3) {
      return { success: false, error: "A case title of at least 3 characters is required" };
    }
    if (!(CASE_CATEGORIES as readonly string[]).includes(params.category)) {
      return { success: false, error: "Unsupported case category" };
    }
    const severity = (params.severity ?? "medium") as Severity;
    if (!["low", "medium", "high"].includes(severity)) {
      return { success: false, error: "Unsupported severity" };
    }
    if (
      params.amountAtStake != null &&
      (!Number.isFinite(Number(params.amountAtStake)) || Number(params.amountAtStake) < 0)
    ) {
      return { success: false, error: "Enter a valid amount at stake" };
    }

    let branchId = params.branchId ?? null;
    if (branchId) {
      if (!actorAllowsBranch(actor, branchId)) {
        return { success: false, error: "You are not authorised to open a case for this branch" };
      }
    } else if (!actor.isCompanyWide) {
      return { success: false, error: "Choose a branch inside your scope" };
    }

    const collectorId = params.collectorId ?? null;
    if (collectorId) {
      const collector = await db.collector.findFirst({
        where: { id: collectorId, tenantId: actor.ctx.tenantId },
        select: { id: true, branchId: true },
      });
      if (!collector) return { success: false, error: "That collector was not found." };
      if (branchId && collector.branchId !== branchId) {
        return { success: false, error: "The collector does not belong to that branch" };
      }
      if (!branchId) branchId = collector.branchId ?? null;
    }

    if (params.ownerId) {
      await validateCaseOwner({
        tenantId: actor.ctx.tenantId,
        ownerId: params.ownerId,
        branchId,
      });
    }
    const dueAt = parseDueAt(params.dueAt);
    if (params.dueAt && !dueAt) {
      return { success: false, error: "Choose a valid future due date" };
    }

    for (const link of params.links ?? []) {
      if (!LINK_ENTITY_TYPES.has(link.entityType)) {
        return { success: false, error: "Unsupported record type for this case" };
      }
    }

    const result = await db.$transaction(async (tx) => {
      for (const link of params.links ?? []) {
        await validateLinkTarget(tx, actor, branchId, link.entityType, link.entityId);
      }
      return createExceptionCaseTx(tx, {
        tenantId: actor.ctx.tenantId,
        branchId,
        collectorId,
        category: params.category,
        severity,
        title,
        description: params.description ?? null,
        amountAtStake: params.amountAtStake ?? null,
        ownerId: params.ownerId ?? null,
        dueAt,
        evidence: params.evidence ?? null,
        links: (params.links ?? []).map((link) => ({
          entityType: link.entityType,
          entityId: link.entityId,
          note: link.note ?? null,
        })),
        actorId: actor.ctx.userId,
        actorRole: actor.ctx.role,
      });
    });

    refresh(result.id);
    return { success: true, data: { id: result.id, caseNumber: result.caseNumber } };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Backwards-compatible, validated update entry point. Dedicated actions below
 * are the preferred UI path; this keeps every state change under the same
 * policy checks.
 */
export async function updateExceptionCase(params: {
  id: string;
  status?: string;
  severity?: string;
  ownerId?: string | null;
  note?: string;
  evidence?: string;
  evidenceRef?: string;
  reason?: string;
  resolutionType?: string;
  resolutionNote?: string;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_case_update");
    const existing = await loadManagedCase(actor, params.id);
    if (params.status && !canTransitionCase(existing.status, params.status)) {
      return {
        success: false,
        error: `A case cannot move from ${existing.status} to ${params.status}.`,
      };
    }
    if (params.severity && !["low", "medium", "high"].includes(params.severity)) {
      return { success: false, error: "Unsupported severity" };
    }

    const ownerChanged =
      params.ownerId !== undefined && params.ownerId !== existing.ownerId;
    if (ownerChanged && params.ownerId) {
      await validateCaseOwner({
        tenantId: actor.ctx.tenantId,
        ownerId: params.ownerId,
        branchId: existing.branchId,
      });
    }
    if (ownerChanged && existing.ownerId && !params.reason?.trim()) {
      return {
        success: false,
        error: "Record a reassignment reason of at least 5 characters.",
      };
    }

    const nextStatus =
      params.status ??
      (ownerChanged && existing.status === "open" && params.ownerId
        ? "assigned"
        : existing.status);
    const now = new Date();
    const effectiveSeverity = params.severity ?? existing.severity;
    const amount =
      existing.amountAtStake == null ? null : Number(existing.amountAtStake);
    const needsEvidence = caseRequiresEvidence({
      category: existing.category,
      severity: effectiveSeverity,
      amountAtStake: amount,
    });
    const independent = requiresIndependentApproval({
      severity: effectiveSeverity,
      amountAtStake: amount,
    });
    const evidenceRef =
      params.evidenceRef?.trim() || params.evidence?.trim() || existing.evidence;

    if (nextStatus === "resolution_proposed") {
      if (!params.resolutionType || !RESOLUTION_TYPES.has(params.resolutionType)) {
        return { success: false, error: "Choose a supported resolution type." };
      }
      if (!params.resolutionNote || params.resolutionNote.trim().length < 10) {
        return { success: false, error: "Record the proposed resolution (10+ characters)." };
      }
      if (needsEvidence && !evidenceRef) {
        return { success: false, error: "This case requires evidence before resolution." };
      }
    }
    if (
      params.resolutionType &&
      (nextStatus === "resolved" || nextStatus === "rejected") &&
      !RESOLUTION_TYPES.has(params.resolutionType)
    ) {
      return { success: false, error: "Choose a supported resolution type." };
    }

    if (nextStatus === "resolved" || nextStatus === "rejected") {
      if (!params.resolutionNote || params.resolutionNote.trim().length < 10) {
        return { success: false, error: "Record the resolution (10+ characters)." };
      }
      if (nextStatus === "resolved" && independent) {
        return {
          success: false,
          error:
            "This case requires independent approval: propose a resolution, then have another authorised person approve it.",
        };
      }
      if (nextStatus === "resolved" && needsEvidence && !evidenceRef) {
        return { success: false, error: "This case requires evidence before it can be resolved." };
      }
    }

    if (nextStatus === "reopened") {
      if (!params.reason || params.reason.trim().length < 5) {
        return { success: false, error: "Record why the case is being reopened." };
      }
      if (!params.evidenceRef?.trim()) {
        return { success: false, error: "Reopening requires a new evidence reference." };
      }
      if (!["resolved", "rejected", "dismissed"].includes(existing.status)) {
        return { success: false, error: "Only a closed case can be reopened." };
      }
    }

    await db.$transaction(async (tx) => {
      const data: Prisma.ReconciliationExceptionCaseUpdateInput = {
        status: nextStatus,
        severity: effectiveSeverity,
        ownerId:
          params.ownerId === undefined ? existing.ownerId : params.ownerId,
        assignedAt:
          params.ownerId === undefined
            ? existing.assignedAt
            : params.ownerId
              ? now
              : null,
        evidence: evidenceRef ?? existing.evidence,
        lastActivityAt: now,
      };
      if (nextStatus === "resolution_proposed") {
        data.resolutionProposedById = actor.ctx.userId;
        data.resolutionProposedAt = now;
        data.proposedResolutionType = params.resolutionType ?? null;
        data.proposedResolutionNote = params.resolutionNote?.trim() ?? null;
        data.proposedEvidenceRef = evidenceRef ?? null;
        data.resolutionApprovedById = null;
        data.resolutionApprovedAt = null;
      }
      if (nextStatus === "resolved" || nextStatus === "rejected") {
        data.resolutionType = params.resolutionType ?? existing.resolutionType ?? "other";
        data.resolutionNote = params.resolutionNote?.trim() ?? existing.resolutionNote;
        data.resolvedById = actor.ctx.userId;
        data.resolvedAt = now;
      }
      if (nextStatus === "reopened") {
        data.reopenCount = { increment: 1 };
      }
      await tx.reconciliationExceptionCase.update({ where: { id: existing.id }, data });

      if (nextStatus !== existing.status) {
        await recordEvent(tx, {
          tenantId: actor.ctx.tenantId,
          caseId: existing.id,
          type:
            nextStatus === "reopened"
              ? "reopened"
              : nextStatus === "resolved"
                ? "resolved"
                : nextStatus === "rejected"
                  ? "rejected"
                  : nextStatus === "escalated"
                    ? "escalated"
                    : "status_changed",
          actorId: actor.ctx.userId,
          actorRole: actor.ctx.role,
          fromStatus: existing.status,
          toStatus: nextStatus,
          reason: params.reason ?? null,
          evidenceRef: params.evidenceRef ?? null,
          note: params.resolutionNote ?? params.note ?? null,
        });
      }
      if (ownerChanged) {
        await recordEvent(tx, {
          tenantId: actor.ctx.tenantId,
          caseId: existing.id,
          type: existing.ownerId ? "reassigned" : "assigned",
          actorId: actor.ctx.userId,
          actorRole: actor.ctx.role,
          fromStatus: existing.status,
          toStatus: nextStatus,
          reason: params.reason ?? null,
          note: params.note ?? null,
          payload: { fromOwnerId: existing.ownerId, toOwnerId: params.ownerId },
        });
      }
      if (params.evidence || params.evidenceRef) {
        await recordEvent(tx, {
          tenantId: actor.ctx.tenantId,
          caseId: existing.id,
          type: "evidence",
          actorId: actor.ctx.userId,
          actorRole: actor.ctx.role,
          evidenceRef: params.evidenceRef ?? null,
          note: params.evidence ?? null,
        });
      }
      if (params.note?.trim() && !params.status && !ownerChanged) {
        await recordEvent(tx, {
          tenantId: actor.ctx.tenantId,
          caseId: existing.id,
          type: "note",
          actorId: actor.ctx.userId,
          actorRole: actor.ctx.role,
          note: params.note,
        });
      }
      await auditCase(tx, actor, existing, "susu.exception_case_updated", {
        fromStatus: existing.status,
        toStatus: nextStatus,
        ownerChanged,
        fromOwnerId: existing.ownerId,
        toOwnerId: params.ownerId ?? existing.ownerId,
        reason: params.reason ?? null,
        evidenceRef: params.evidenceRef ?? null,
        resolutionType: params.resolutionType ?? null,
      });
    });

    refresh(existing.id);
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

/** Assign an unassigned case (or take ownership) with an optional due date. */
export async function assignExceptionCase(params: {
  caseId: string;
  ownerId: string;
  dueAt?: string | Date | null;
  note?: string;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_case_assign");
    const existing = await loadManagedCase(actor, params.caseId);
    if (isTerminalCaseStatus(existing.status)) {
      return { success: false, error: "A closed case must be reopened before assignment." };
    }
    if (existing.ownerId && existing.ownerId !== params.ownerId) {
      return { success: false, error: "Use reassign to transfer an owned case." };
    }
    await validateCaseOwner({
      tenantId: actor.ctx.tenantId,
      ownerId: params.ownerId,
      branchId: existing.branchId,
    });
    const dueAt = params.dueAt ? parseDueAt(params.dueAt) : null;
    if (params.dueAt && !dueAt) {
      return { success: false, error: "Choose a valid future due date" };
    }
    const now = new Date();
    const nextStatus =
      existing.status === "open" || existing.status === "reopened"
        ? "assigned"
        : existing.status;
    if (nextStatus !== existing.status && !canTransitionCase(existing.status, nextStatus)) {
      return { success: false, error: "This case cannot be assigned in its current state." };
    }
    await db.$transaction(async (tx) => {
      await tx.reconciliationExceptionCase.update({
        where: { id: existing.id },
        data: {
          ownerId: params.ownerId,
          assignedAt: now,
          status: nextStatus,
          dueAt: dueAt ?? existing.dueAt,
          lastActivityAt: now,
        },
      });
      await recordEvent(tx, {
        tenantId: actor.ctx.tenantId,
        caseId: existing.id,
        type: existing.ownerId ? "reassigned" : "assigned",
        actorId: actor.ctx.userId,
        actorRole: actor.ctx.role,
        fromStatus: existing.status,
        toStatus: nextStatus,
        note: params.note ?? null,
        payload: { fromOwnerId: existing.ownerId, toOwnerId: params.ownerId },
      });
      await auditCase(tx, actor, existing, "susu.exception_case_assigned", {
        fromOwnerId: existing.ownerId,
        toOwnerId: params.ownerId,
        fromStatus: existing.status,
        toStatus: nextStatus,
        dueAt: dueAt?.toISOString() ?? null,
      });
    });
    refresh(existing.id);
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

/** Transfer ownership. A reason is mandatory and kept in the timeline. */
export async function reassignExceptionCase(params: {
  caseId: string;
  ownerId: string;
  reason: string;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_case_reassign");
    const reason = params.reason?.trim() ?? "";
    if (reason.length < 5) {
      return { success: false, error: "Record a reassignment reason of at least 5 characters." };
    }
    const existing = await loadManagedCase(actor, params.caseId);
    if (isTerminalCaseStatus(existing.status)) {
      return { success: false, error: "A closed case must be reopened before reassignment." };
    }
    if (!existing.ownerId) {
      return { success: false, error: "Assign the case first, then reassign it." };
    }
    if (existing.ownerId === params.ownerId) {
      return { success: false, error: "That person already owns the case." };
    }
    await validateCaseOwner({
      tenantId: actor.ctx.tenantId,
      ownerId: params.ownerId,
      branchId: existing.branchId,
    });
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.reconciliationExceptionCase.update({
        where: { id: existing.id },
        data: { ownerId: params.ownerId, assignedAt: now, lastActivityAt: now },
      });
      await recordEvent(tx, {
        tenantId: actor.ctx.tenantId,
        caseId: existing.id,
        type: "reassigned",
        actorId: actor.ctx.userId,
        actorRole: actor.ctx.role,
        fromStatus: existing.status,
        toStatus: existing.status,
        reason,
        payload: { fromOwnerId: existing.ownerId, toOwnerId: params.ownerId },
      });
      await auditCase(tx, actor, existing, "susu.exception_case_reassigned", {
        fromOwnerId: existing.ownerId,
        toOwnerId: params.ownerId,
        reason,
      });
    });
    refresh(existing.id);
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

/** Add a note (and optional evidence) without changing the case outcome. */
export async function addExceptionCaseNote(params: {
  caseId: string;
  note: string;
  evidenceRef?: string | null;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_case_note");
    const note = params.note?.trim() ?? "";
    if (note.length < 3) {
      return { success: false, error: "Record a note of at least 3 characters." };
    }
    const existing = await loadManagedCase(actor, params.caseId);
    if (isTerminalCaseStatus(existing.status)) {
      return { success: false, error: "A closed case is read-only; reopen it to add notes." };
    }
    const evidenceRef = params.evidenceRef?.trim() || null;
    const nextStatus =
      existing.status === "awaiting_evidence" && evidenceRef
        ? "under_review"
        : existing.status;
    if (nextStatus !== existing.status && !canTransitionCase(existing.status, nextStatus)) {
      return { success: false, error: "This case cannot move to review yet." };
    }
    await db.$transaction(async (tx) => {
      await tx.reconciliationExceptionCase.update({
        where: { id: existing.id },
        data: {
          status: nextStatus,
          lastActivityAt: new Date(),
          evidence: evidenceRef || existing.evidence,
        },
      });
      await recordEvent(tx, {
        tenantId: actor.ctx.tenantId,
        caseId: existing.id,
        type: evidenceRef ? "evidence" : "note",
        actorId: actor.ctx.userId,
        actorRole: actor.ctx.role,
        fromStatus: existing.status,
        toStatus: nextStatus,
        note,
        evidenceRef,
      });
      await auditCase(tx, actor, existing, "susu.exception_case_note_added", {
        note,
        evidenceRef: params.evidenceRef ?? null,
      });
    });
    refresh(existing.id);
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

/** Extend the due date. The old and new dates remain in the timeline. */
export async function extendExceptionCaseDueDate(params: {
  caseId: string;
  dueAt: string | Date;
  reason: string;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_case_due_date");
    const reason = params.reason?.trim() ?? "";
    if (reason.length < 5) {
      return { success: false, error: "Record why the due date is being extended." };
    }
    const existing = await loadManagedCase(actor, params.caseId);
    if (isTerminalCaseStatus(existing.status)) {
      return { success: false, error: "A closed case has no active due date." };
    }
    const dueAt = parseDueAt(params.dueAt);
    if (!dueAt) return { success: false, error: "Choose a valid future due date" };
    if (existing.dueAt && dueAt.getTime() <= existing.dueAt.getTime()) {
      return { success: false, error: "The new due date must be later than the current due date." };
    }
    await db.$transaction(async (tx) => {
      await tx.reconciliationExceptionCase.update({
        where: { id: existing.id },
        data: { dueAt, lastActivityAt: new Date() },
      });
      await recordEvent(tx, {
        tenantId: actor.ctx.tenantId,
        caseId: existing.id,
        type: "due_date_extended",
        actorId: actor.ctx.userId,
        actorRole: actor.ctx.role,
        fromStatus: existing.status,
        toStatus: existing.status,
        reason,
        payload: {
          fromDueAt: existing.dueAt?.toISOString() ?? null,
          toDueAt: dueAt.toISOString(),
        },
      });
      await auditCase(tx, actor, existing, "susu.exception_case_due_date_extended", {
        fromDueAt: existing.dueAt?.toISOString() ?? null,
        toDueAt: dueAt.toISOString(),
        reason,
      });
    });
    refresh(existing.id);
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

/** Escalate a case to the next operational level. */
export async function escalateExceptionCase(params: {
  caseId: string;
  reason: string;
  dueAt?: string | Date | null;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_case_escalate");
    const reason = params.reason?.trim() ?? "";
    if (reason.length < 5) {
      return { success: false, error: "Record an escalation reason of at least 5 characters." };
    }
    const existing = await loadManagedCase(actor, params.caseId);
    if (isTerminalCaseStatus(existing.status)) {
      return { success: false, error: "A closed case cannot be escalated." };
    }
    if (!canTransitionCase(existing.status, "escalated")) {
      return { success: false, error: "This case cannot be escalated from its current state." };
    }
    const dueAt = params.dueAt ? parseDueAt(params.dueAt) : null;
    if (params.dueAt && !dueAt) {
      return { success: false, error: "Choose a valid future due date" };
    }
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.reconciliationExceptionCase.update({
        where: { id: existing.id },
        data: {
          status: "escalated",
          escalatedAt: now,
          escalationLevel: Math.min(3, existing.escalationLevel + 1),
          dueAt: dueAt ?? existing.dueAt,
          lastActivityAt: now,
        },
      });
      await recordEvent(tx, {
        tenantId: actor.ctx.tenantId,
        caseId: existing.id,
        type: "escalated",
        actorId: actor.ctx.userId,
        actorRole: actor.ctx.role,
        fromStatus: existing.status,
        toStatus: "escalated",
        reason,
        payload: {
          level: Math.min(3, existing.escalationLevel + 1),
          dueAt: (dueAt ?? existing.dueAt)?.toISOString() ?? null,
        },
      });
      await auditCase(tx, actor, existing, "susu.exception_case_escalated", {
        reason,
        previousLevel: existing.escalationLevel,
        level: Math.min(3, existing.escalationLevel + 1),
      });
    });
    refresh(existing.id);
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Escalate every overdue, active case in scope once. Used by the queue's
 * "escalate overdue" control; the per-case action remains available.
 */
export async function escalateOverdueCases(params?: {
  branchId?: string | null;
  limit?: number;
}): Promise<{ success: boolean; error?: string; data?: { escalated: number } }> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_case_escalate_overdue");
    if (params?.branchId && !actorAllowsBranch(actor, params.branchId)) {
      return { success: false, error: "That branch is outside your scope" };
    }
    const branchFilter = params?.branchId
      ? { branchId: params.branchId }
      : !actor.isCompanyWide
        ? { branchId: { in: actor.branchIds } }
        : {};
    const rows = await db.reconciliationExceptionCase.findMany({
      where: {
        tenantId: actor.ctx.tenantId,
        ...branchFilter,
        dueAt: { lt: new Date() },
        status: { notIn: ["resolved", "rejected", "dismissed", "escalated"] },
      },
      orderBy: { dueAt: "asc" },
      take: Math.min(50, Math.max(1, params?.limit ?? 50)),
      select: {
        id: true,
        caseNumber: true,
        branchId: true,
        status: true,
        escalationLevel: true,
        dueAt: true,
        tenantId: true,
      },
    });
    let escalated = 0;
    for (const row of rows) {
      try {
        await db.$transaction(async (tx) => {
          await tx.reconciliationExceptionCase.update({
            where: { id: row.id },
            data: {
              status: "escalated",
              escalatedAt: new Date(),
              escalationLevel: Math.min(3, row.escalationLevel + 1),
              lastActivityAt: new Date(),
            },
          });
          await recordEvent(tx, {
            tenantId: actor.ctx.tenantId,
            caseId: row.id,
            type: "escalated",
            actorId: actor.ctx.userId,
            actorRole: actor.ctx.role,
            fromStatus: row.status,
            toStatus: "escalated",
            reason: "Automatically escalated because the due date passed",
            payload: { automatic: true },
          });
          await auditCase(tx, actor, row, "susu.exception_case_escalated_overdue", {
            previousStatus: row.status,
            dueAt: row.dueAt?.toISOString() ?? null,
            automatic: true,
          });
        });
        escalated += 1;
      } catch {
        // One failed case must not stop the overdue sweep.
      }
    }
    if (escalated > 0) refresh("");
    return { success: true, data: { escalated } };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Propose a resolution. High-value cases then require a different authorised
 * approver in approveCaseResolution.
 */
export async function proposeCaseResolution(params: {
  caseId: string;
  resolutionType: string;
  resolutionNote: string;
  evidenceRef?: string | null;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_case_resolution_propose");
    const existing = await loadManagedCase(actor, params.caseId);
    if (isTerminalCaseStatus(existing.status)) {
      return { success: false, error: "This case is already closed." };
    }
    if (!canTransitionCase(existing.status, "resolution_proposed")) {
      return { success: false, error: "A resolution cannot be proposed from this state." };
    }
    if (!RESOLUTION_TYPES.has(params.resolutionType)) {
      return { success: false, error: "Choose a supported resolution type." };
    }
    const note = params.resolutionNote?.trim() ?? "";
    if (note.length < 10) {
      return { success: false, error: "Record the proposed resolution (10+ characters)." };
    }
    const evidenceRef = params.evidenceRef?.trim() || existing.evidence;
    const needsEvidence = caseRequiresEvidence({
      category: existing.category,
      severity: existing.severity,
      amountAtStake: existing.amountAtStake == null ? null : Number(existing.amountAtStake),
    });
    if (needsEvidence && !evidenceRef) {
      return { success: false, error: "This case requires evidence before a resolution is proposed." };
    }
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.reconciliationExceptionCase.update({
        where: { id: existing.id },
        data: {
          status: "resolution_proposed",
          resolutionProposedById: actor.ctx.userId,
          resolutionProposedAt: now,
          proposedResolutionType: params.resolutionType,
          proposedResolutionNote: note,
          proposedEvidenceRef: evidenceRef ?? null,
          evidence: evidenceRef ?? existing.evidence,
          resolutionApprovedById: null,
          resolutionApprovedAt: null,
          lastActivityAt: now,
        },
      });
      await recordEvent(tx, {
        tenantId: actor.ctx.tenantId,
        caseId: existing.id,
        type: "resolution_proposed",
        actorId: actor.ctx.userId,
        actorRole: actor.ctx.role,
        fromStatus: existing.status,
        toStatus: "resolution_proposed",
        note,
        evidenceRef,
        payload: { resolutionType: params.resolutionType },
      });
      await auditCase(tx, actor, existing, "susu.exception_case_resolution_proposed", {
        resolutionType: params.resolutionType,
        note,
        evidenceRef,
        requiresIndependentApproval: requiresIndependentApproval({
          severity: existing.severity,
          amountAtStake:
            existing.amountAtStake == null ? null : Number(existing.amountAtStake),
        }),
      });
    });
    refresh(existing.id);
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Approve a proposed resolution. The approver must be a different person; for
 * a high-value case they must also have company or branch-finance authority.
 */
export async function approveCaseResolution(params: {
  caseId: string;
  note?: string;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_case_resolution_approve");
    const existing = await loadManagedCase(actor, params.caseId);
    if (existing.status !== "resolution_proposed") {
      return { success: false, error: "This case has no resolution awaiting approval." };
    }
    if (!existing.resolutionProposedById || !existing.proposedResolutionNote) {
      return { success: false, error: "The proposed resolution is incomplete." };
    }
    if (existing.resolutionProposedById === actor.ctx.userId) {
      return { success: false, error: "The person who proposed a resolution cannot approve it." };
    }
    const needsIndependent = requiresIndependentApproval({
      severity: existing.severity,
      amountAtStake: existing.amountAtStake == null ? null : Number(existing.amountAtStake),
    });
    if (needsIndependent) {
      await assertFinanceAuthority(actor, existing.branchId);
    }
    const evidenceRef =
      existing.proposedEvidenceRef?.trim() || existing.evidence?.trim() || null;
    const needsEvidence = caseRequiresEvidence({
      category: existing.category,
      severity: existing.severity,
      amountAtStake: existing.amountAtStake == null ? null : Number(existing.amountAtStake),
    });
    if (needsEvidence && !evidenceRef) {
      return { success: false, error: "This case cannot be resolved without evidence." };
    }
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.reconciliationExceptionCase.update({
        where: { id: existing.id },
        data: {
          status: "resolved",
          resolutionType: existing.proposedResolutionType ?? "other",
          resolutionNote: existing.proposedResolutionNote,
          resolutionApprovedById: actor.ctx.userId,
          resolutionApprovedAt: now,
          resolvedById: actor.ctx.userId,
          resolvedAt: now,
          evidence: evidenceRef ?? existing.evidence,
          lastActivityAt: now,
        },
      });
      await recordEvent(tx, {
        tenantId: actor.ctx.tenantId,
        caseId: existing.id,
        type: "resolution_approved",
        actorId: actor.ctx.userId,
        actorRole: actor.ctx.role,
        fromStatus: "resolution_proposed",
        toStatus: "resolved",
        note: params.note ?? null,
        evidenceRef,
        payload: {
          proposedById: existing.resolutionProposedById,
          resolutionType: existing.proposedResolutionType,
          independentApproval: needsIndependent,
        },
      });
      await auditCase(tx, actor, existing, "susu.exception_case_resolution_approved", {
        proposedById: existing.resolutionProposedById,
        resolutionType: existing.proposedResolutionType,
        evidenceRef,
        independentApproval: needsIndependent,
      });
    });
    refresh(existing.id);
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

/** Send a proposed resolution back to review without closing the case. */
export async function rejectResolutionProposal(params: {
  caseId: string;
  reason: string;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_case_resolution_reject");
    const reason = params.reason?.trim() ?? "";
    if (reason.length < 5) {
      return { success: false, error: "Record why the proposal was rejected." };
    }
    const existing = await loadManagedCase(actor, params.caseId);
    if (existing.status !== "resolution_proposed") {
      return { success: false, error: "This case has no proposed resolution." };
    }
    await db.$transaction(async (tx) => {
      await tx.reconciliationExceptionCase.update({
        where: { id: existing.id },
        data: {
          status: "under_review",
          proposedResolutionType: null,
          proposedResolutionNote: null,
          proposedEvidenceRef: null,
          resolutionProposedById: null,
          resolutionProposedAt: null,
          lastActivityAt: new Date(),
        },
      });
      await recordEvent(tx, {
        tenantId: actor.ctx.tenantId,
        caseId: existing.id,
        type: "resolution_rejected",
        actorId: actor.ctx.userId,
        actorRole: actor.ctx.role,
        fromStatus: "resolution_proposed",
        toStatus: "under_review",
        reason,
      });
      await auditCase(tx, actor, existing, "susu.exception_case_resolution_rejected", {
        reason,
      });
    });
    refresh(existing.id);
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Resolve a case directly when independent approval is not required. High-value
 * cases must use propose + approve.
 */
export async function resolveExceptionCase(params: {
  caseId: string;
  resolutionType: string;
  resolutionNote: string;
  evidenceRef?: string | null;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_case_resolve");
    const existing = await loadManagedCase(actor, params.caseId);
    if (isTerminalCaseStatus(existing.status)) {
      return { success: false, error: "This case is already closed." };
    }
    if (!canTransitionCase(existing.status, "resolved")) {
      return { success: false, error: "This case cannot be resolved from its current state." };
    }
    if (!RESOLUTION_TYPES.has(params.resolutionType)) {
      return { success: false, error: "Choose a supported resolution type." };
    }
    const note = params.resolutionNote?.trim() ?? "";
    if (note.length < 10) {
      return { success: false, error: "Record the resolution (10+ characters)." };
    }
    if (
      requiresIndependentApproval({
        severity: existing.severity,
        amountAtStake:
          existing.amountAtStake == null ? null : Number(existing.amountAtStake),
      })
    ) {
      return {
        success: false,
        error:
          "This case requires independent approval: propose a resolution, then have another authorised person approve it.",
      };
    }
    const evidenceRef = params.evidenceRef?.trim() || existing.evidence;
    if (
      caseRequiresEvidence({
        category: existing.category,
        severity: existing.severity,
        amountAtStake:
          existing.amountAtStake == null ? null : Number(existing.amountAtStake),
      }) &&
      !evidenceRef
    ) {
      return { success: false, error: "This case requires evidence before it can be resolved." };
    }
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.reconciliationExceptionCase.update({
        where: { id: existing.id },
        data: {
          status: "resolved",
          resolutionType: params.resolutionType,
          resolutionNote: note,
          resolvedById: actor.ctx.userId,
          resolvedAt: now,
          evidence: evidenceRef ?? existing.evidence,
          lastActivityAt: now,
        },
      });
      await recordEvent(tx, {
        tenantId: actor.ctx.tenantId,
        caseId: existing.id,
        type: "resolved",
        actorId: actor.ctx.userId,
        actorRole: actor.ctx.role,
        fromStatus: existing.status,
        toStatus: "resolved",
        note,
        evidenceRef,
        payload: { resolutionType: params.resolutionType },
      });
      await auditCase(tx, actor, existing, "susu.exception_case_resolved", {
        resolutionType: params.resolutionType,
        note,
        evidenceRef,
      });
    });
    refresh(existing.id);
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

/** Reject an exception that is not valid, with a reason. Never edits finance. */
export async function rejectExceptionCase(params: {
  caseId: string;
  reason: string;
  evidenceRef?: string | null;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_case_reject");
    const reason = params.reason?.trim() ?? "";
    if (reason.length < 5) {
      return { success: false, error: "Record a rejection reason of at least 5 characters." };
    }
    const existing = await loadManagedCase(actor, params.caseId);
    if (isTerminalCaseStatus(existing.status)) {
      return { success: false, error: "This case is already closed." };
    }
    if (!canTransitionCase(existing.status, "rejected")) {
      return { success: false, error: "This case cannot be rejected from its current state." };
    }
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.reconciliationExceptionCase.update({
        where: { id: existing.id },
        data: {
          status: "rejected",
          resolutionType: "no_action",
          resolutionNote: reason,
          resolvedById: actor.ctx.userId,
          resolvedAt: now,
          evidence: params.evidenceRef?.trim() || existing.evidence,
          lastActivityAt: now,
        },
      });
      await recordEvent(tx, {
        tenantId: actor.ctx.tenantId,
        caseId: existing.id,
        type: "rejected",
        actorId: actor.ctx.userId,
        actorRole: actor.ctx.role,
        fromStatus: existing.status,
        toStatus: "rejected",
        reason,
        evidenceRef: params.evidenceRef ?? null,
      });
      await auditCase(tx, actor, existing, "susu.exception_case_rejected", {
        reason,
        evidenceRef: params.evidenceRef ?? null,
      });
    });
    refresh(existing.id);
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

/** Reopen a closed case because new evidence justifies another review. */
export async function reopenExceptionCase(params: {
  caseId: string;
  reason: string;
  evidenceRef: string;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_case_reopen");
    const reason = params.reason?.trim() ?? "";
    if (reason.length < 5) {
      return { success: false, error: "Record why the case is being reopened." };
    }
    if (!params.evidenceRef?.trim()) {
      return { success: false, error: "Reopening requires a new evidence reference." };
    }
    const existing = await loadManagedCase(actor, params.caseId);
    if (!["resolved", "rejected", "dismissed"].includes(existing.status)) {
      return { success: false, error: "Only a closed case can be reopened." };
    }
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.reconciliationExceptionCase.update({
        where: { id: existing.id },
        data: {
          status: "reopened",
          reopenCount: { increment: 1 },
          evidence: params.evidenceRef.trim(),
          lastActivityAt: now,
        },
      });
      await recordEvent(tx, {
        tenantId: actor.ctx.tenantId,
        caseId: existing.id,
        type: "reopened",
        actorId: actor.ctx.userId,
        actorRole: actor.ctx.role,
        fromStatus: existing.status,
        toStatus: "reopened",
        reason,
        evidenceRef: params.evidenceRef,
      });
      await auditCase(tx, actor, existing, "susu.exception_case_reopened", {
        reason,
        evidenceRef: params.evidenceRef,
        previousStatus: existing.status,
        reopenCount: existing.reopenCount + 1,
      });
    });
    refresh(existing.id);
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

/** Link an internal record. The target is re-validated in the tenant database. */
export async function linkCaseRecord(params: {
  caseId: string;
  entityType: string;
  entityId: string;
  note?: string;
}): Promise<ActionResponse> {
  const actor = await requireReconciliationAdmin();
  try {
    await writeLimit(actor, "finance:reconciliation_case_link");
    const existing = await loadManagedCase(actor, params.caseId);
    const entityType = params.entityType?.trim() ?? "";
    const entityId = params.entityId?.trim() ?? "";
    if (!LINK_ENTITY_TYPES.has(entityType) || !entityId) {
      return { success: false, error: "Choose a supported record to link." };
    }
    await db.$transaction(async (tx) => {
      await validateLinkTarget(tx, actor, existing.branchId, entityType, entityId);
      const already = await tx.reconciliationExceptionLink.findFirst({
        where: {
          tenantId: actor.ctx.tenantId,
          caseId: existing.id,
          entityType,
          entityId,
        },
        select: { id: true },
      });
      if (already) throw new ReconciliationError("That record is already linked to this case.");
      await tx.reconciliationExceptionLink.create({
        data: {
          tenantId: actor.ctx.tenantId,
          caseId: existing.id,
          entityType,
          entityId,
          note: params.note?.trim() ?? null,
          createdById: actor.ctx.userId,
        },
      });
      await tx.reconciliationExceptionCase.update({
        where: { id: existing.id },
        data: { lastActivityAt: new Date() },
      });
      await recordEvent(tx, {
        tenantId: actor.ctx.tenantId,
        caseId: existing.id,
        type: "link_added",
        actorId: actor.ctx.userId,
        actorRole: actor.ctx.role,
        note: `${entityType}:${entityId}`,
        payload: { entityType, entityId, linkNote: params.note ?? null },
      });
      await auditCase(tx, actor, existing, "susu.exception_case_linked", {
        entityType,
        entityId,
        linkNote: params.note ?? null,
      });
    });
    refresh(existing.id);
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

/**
 * List cases for the workspace queue.
 *
 * Collectors always see only cases whose collectorId is their own, even if a
 * client supplies another collector/branch. Branch users cannot escape their
 * scope via query parameters.
 */
/**
 * Eligible case owners for a branch. A company-wide administrator may own any
 * case; a branch manager or finance user must hold an active membership in the
 * case's branch. Identity comes from the server session, never the client.
 */
export async function getExceptionCaseOwnerOptions(params?: {
  branchId?: string | null;
}): Promise<{
  success: boolean;
  error?: string;
  data?: Array<{ id: string; name: string; role: string; branchId: string | null }>;
}> {
  const actor = await requireReconciliationAdmin();
  try {
    const branchId = params?.branchId ?? null;
    if (branchId && !actorAllowsBranch(actor, branchId)) {
      return { success: false, error: "That branch is outside your scope" };
    }
    const admins = await db.user.findMany({
      where: {
        tenantId: actor.ctx.tenantId,
        status: "active",
        role: "admin",
      },
      select: { id: true, fullName: true, role: true },
      orderBy: { fullName: "asc" },
    });
    const memberships = await db.branchMembership.findMany({
      where: {
        tenantId: actor.ctx.tenantId,
        status: "active",
        role: { in: ["branch_manager", "finance"] },
        ...(branchId ? { locationId: branchId } : {}),
      },
      select: { userId: true, locationId: true, role: true },
    });
    const memberIds = [...new Set(memberships.map((m) => m.userId))];
    const members = memberIds.length
      ? await db.user.findMany({
          where: {
            tenantId: actor.ctx.tenantId,
            id: { in: memberIds },
            status: "active",
          },
          select: { id: true, fullName: true, role: true },
          orderBy: { fullName: "asc" },
        })
      : [];
    const membershipByUser = new Map(memberships.map((m) => [m.userId, m]));
    const options = new Map<
      string,
      { id: string; name: string; role: string; branchId: string | null }
    >();
    for (const admin of admins) {
      options.set(admin.id, {
        id: admin.id,
        name: admin.fullName,
        role: "administrator",
        branchId: null,
      });
    }
    for (const member of members) {
      const membership = membershipByUser.get(member.id);
      options.set(member.id, {
        id: member.id,
        name: member.fullName,
        role: membership?.role ?? member.role,
        branchId: membership?.locationId ?? null,
      });
    }
    return { success: true, data: [...options.values()] };
  } catch (error) {
    return fail(error);
  }
}

export async function listExceptionCases(params?: {
  branchId?: string | null;
  collectorId?: string | null;
  category?: string | null;
  severity?: string | null;
  status?: string | null;
  ownerId?: string | null;
  overdue?: boolean;
  unassigned?: boolean;
  escalated?: boolean;
  search?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  limit?: number;
  offset?: number;
}): Promise<CasesListResponse> {
  const actor = await resolveReconciliationActor();
  try {
    const where: Prisma.ReconciliationExceptionCaseWhereInput = {
      tenantId: actor.ctx.tenantId,
    };
    if (actor.kind === "collector") {
      if (!actor.collectorId) {
        return { success: true, data: { cases: [], total: 0, byStatus: {} } };
      }
      where.collectorId = actor.collectorId;
    } else if (params?.branchId) {
      if (!actorAllowsBranch(actor, params.branchId)) {
        return { success: false, error: "That branch is outside your scope" };
      }
      where.branchId = params.branchId;
    } else if (!actor.isCompanyWide) {
      where.branchId = { in: actor.branchIds };
    }
    if (params?.collectorId) {
      if (actor.kind === "collector" && params.collectorId !== actor.collectorId) {
        return { success: false, error: "You can only see your own cases." };
      }
      where.collectorId = params.collectorId;
    }
    if (params?.category) where.category = params.category;
    if (params?.severity) where.severity = params.severity;
    if (params?.ownerId) where.ownerId = params.ownerId;
    if (params?.status) where.status = params.status;
    if (params?.escalated) where.status = "escalated";
    if (params?.unassigned) {
      where.ownerId = null;
      where.status = { notIn: ["resolved", "rejected", "dismissed"] };
    }
    if (params?.overdue) {
      where.dueAt = { lt: new Date() };
      where.status = { notIn: ["resolved", "rejected", "dismissed"] };
    }
    if (params?.search?.trim()) {
      const search = params.search.trim();
      where.OR = [
        { caseNumber: { contains: search } },
        { title: { contains: search } },
        { description: { contains: search } },
      ];
    }
    if (params?.dateFrom || params?.dateTo) {
      const openedAt: Prisma.DateTimeFilter = {};
      if (params.dateFrom) {
        const from = new Date(params.dateFrom);
        if (Number.isNaN(from.getTime())) return { success: false, error: "Invalid start date" };
        openedAt.gte = from;
      }
      if (params.dateTo) {
        const to = new Date(params.dateTo);
        if (Number.isNaN(to.getTime())) return { success: false, error: "Invalid end date" };
        to.setUTCHours(23, 59, 59, 999);
        openedAt.lte = to;
      }
      where.openedAt = openedAt;
    }

    const limit = Math.min(200, Math.max(1, params?.limit ?? 50));
    const offset = Math.max(0, params?.offset ?? 0);
    const [rows, total, grouped] = await Promise.all([
      db.reconciliationExceptionCase.findMany({
        where,
        include: CASE_INCLUDE,
        orderBy: [{ dueAt: "asc" }, { openedAt: "asc" }],
        take: limit,
        skip: offset,
      }),
      db.reconciliationExceptionCase.count({ where }),
      db.reconciliationExceptionCase.groupBy({
        by: ["status"],
        where,
        _count: { _all: true },
      }),
    ]);
    const names = await userNames(actor.ctx.tenantId, [
      ...rows.flatMap((row) => [
        row.ownerId,
        row.openedById,
        row.resolutionProposedById,
        row.resolutionApprovedById,
        row.resolvedById,
      ]),
      ...rows.flatMap((row) => row.events.map((event) => event.actorId)),
    ]);
    const branches = await branchNames(
      actor.ctx.tenantId,
      rows.map((row) => row.branchId)
    );
    const byStatus: Record<string, number> = {};
    for (const group of grouped) byStatus[group.status] = group._count._all;
    return {
      success: true,
      data: {
        cases: rows.map((row) => toCaseView(row, names, branches)),
        total,
        byStatus,
      },
    };
  } catch (error) {
    return fail(error);
  }
}

/** One case with full history, evidence references and linked records. */
export async function getExceptionCase(caseId: string): Promise<CaseViewResponse | null> {
  const actor = await resolveReconciliationActor();
  const row = await db.reconciliationExceptionCase.findFirst({
    where: { id: caseId, tenantId: actor.ctx.tenantId },
    include: CASE_INCLUDE,
  });
  if (!row) return null;
  try {
    assertCanReadCase(actor, caseScope(row));
  } catch {
    return null;
  }
  const names = await userNames(actor.ctx.tenantId, [
    row.ownerId,
    row.openedById,
    row.resolutionProposedById,
    row.resolutionApprovedById,
    row.resolvedById,
    ...row.events.map((event) => event.actorId),
  ]);
  const branches = await branchNames(actor.ctx.tenantId, [row.branchId]);
  return { success: true, data: toCaseView(row, names, branches) };
}

/**
 * Collector response on their own case. Collectors cannot resolve or assign;
 * they can add a time-stamped explanation and supporting evidence.
 */
export async function respondToExceptionCase(params: {
  caseId: string;
  note: string;
  evidenceRef?: string | null;
}): Promise<ActionResponse> {
  const actor = await resolveReconciliationActor();
  if (actor.kind !== "collector" || !actor.collectorId) {
    return { success: false, error: "This action is for collectors." };
  }
  try {
    await writeLimit(actor, "finance:reconciliation_case_respond");
    const note = params.note?.trim() ?? "";
    if (note.length < 3) {
      return { success: false, error: "Record a response of at least 3 characters." };
    }
    const existing = await loadReadableCase(actor, params.caseId);
    if (existing.collectorId !== actor.collectorId) {
      return { success: false, error: "That case was not found." };
    }
    if (isTerminalCaseStatus(existing.status)) {
      return { success: false, error: "This case is closed; contact your branch manager." };
    }
    const nextStatus = existing.status === "awaiting_evidence" && params.evidenceRef?.trim()
      ? "under_review"
      : existing.status === "open" || existing.status === "assigned"
        ? "under_review"
        : existing.status;
    if (
      nextStatus !== existing.status &&
      !canTransitionCase(existing.status, nextStatus)
    ) {
      return { success: false, error: "You cannot update this case in its current state." };
    }
    await db.$transaction(async (tx) => {
      await tx.reconciliationExceptionCase.update({
        where: { id: existing.id },
        data: {
          status: nextStatus,
          evidence: params.evidenceRef?.trim() || existing.evidence,
          lastActivityAt: new Date(),
        },
      });
      await recordEvent(tx, {
        tenantId: actor.ctx.tenantId,
        caseId: existing.id,
        type: "collector_response",
        actorId: actor.ctx.userId,
        actorRole: "collector",
        fromStatus: existing.status,
        toStatus: nextStatus,
        note,
        evidenceRef: params.evidenceRef ?? null,
      });
      await auditCase(tx, actor, existing, "susu.exception_case_collector_response", {
        fromStatus: existing.status,
        toStatus: nextStatus,
        note,
        evidenceRef: params.evidenceRef ?? null,
      });
    });
    refresh(existing.id);
    return { success: true, data: null };
  } catch (error) {
    return fail(error);
  }
}
