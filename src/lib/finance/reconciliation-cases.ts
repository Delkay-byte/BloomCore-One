/**
 * Shared server helpers for creating Susu exception cases inside a transaction.
 *
 * The case number is generated server-side and the advisory lock serialises
 * number allocation on PostgreSQL; SQLite serialises writers itself. No action
 * trusts a client-supplied case number.
 */

import type { Prisma } from "@prisma/client";
import { createAuditLogTx } from "@/lib/audit";
import { lockAccountForUpdate } from "@/lib/db-lock";
import {
  CASE_DUE_HOURS,
  money,
  severityForAmount,
  type Severity,
} from "@/lib/reconciliation-policy";

export type CaseTx = Prisma.TransactionClient;

export interface CaseLinkInput {
  entityType: string;
  entityId: string;
  note?: string | null;
}

export interface CreateCaseTxInput {
  tenantId: string;
  branchId: string | null;
  collectorId?: string | null;
  sourceSessionId?: string | null;
  category: string;
  severity?: Severity;
  title: string;
  description?: string | null;
  amountAtStake?: number | null;
  ownerId?: string | null;
  dueAt?: Date | null;
  evidence?: string | null;
  evidenceRef?: string | null;
  links?: CaseLinkInput[];
  actorId: string;
  actorRole: string;
}

export interface CreatedCase {
  id: string;
  caseNumber: string;
  status: string;
  dueAt: Date;
  severity: string;
}

function casePrefix(date: Date): string {
  return `REC-${date.getUTCFullYear()}-`;
}

/**
 * Allocate the next case number for the tenant, inside the caller's
 * transaction. The max+1 approach is protected by an advisory lock and the
 * (tenantId, caseNumber) unique constraint is the final backstop.
 */
export async function nextCaseNumberTx(tx: CaseTx, tenantId: string, now: Date): Promise<string> {
  await lockAccountForUpdate(tx, `recon:case-number:${tenantId}`);
  const prefix = casePrefix(now);
  const latest = await tx.reconciliationExceptionCase.findFirst({
    where: { tenantId, caseNumber: { startsWith: prefix } },
    orderBy: { caseNumber: "desc" },
    select: { caseNumber: true },
  });
  const sequence = latest
    ? Number.parseInt(latest.caseNumber.slice(prefix.length), 10) + 1
    : 1;
  const safe = Number.isFinite(sequence) && sequence > 0 ? sequence : 1;
  return `${prefix}${String(safe).padStart(4, "0")}`;
}

/**
 * Map a reconciliation finding to the case category used by owner reporting.
 * Provider-statement and liquidity categories are preserved for compatibility.
 */
export function caseCategoryForFinding(entityType: string): string {
  switch (entityType) {
    case "daily_closing":
      return "daily_close";
    case "collector_remittance":
    case "remittance_discrepancy":
      return "remittance";
    case "offline_transaction":
    case "offline_sync_attempt":
      return "offline_sync";
    case "contribution":
      return "contribution";
    case "withdrawal_exception":
      return "withdrawal";
    default:
      return "other";
  }
}

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

export function highestSeverity(values: string[]): Severity {
  let rank = 0;
  for (const value of values) rank = Math.max(rank, SEVERITY_RANK[value] ?? 0);
  return rank === 2 ? "high" : rank === 1 ? "medium" : "low";
}

export async function createExceptionCaseTx(
  tx: CaseTx,
  input: CreateCaseTxInput
): Promise<CreatedCase> {
  const now = new Date();
  const severity = input.severity ?? severityForAmount(input.amountAtStake ?? 0);
  const dueAt =
    input.dueAt ??
    new Date(now.getTime() + CASE_DUE_HOURS[severity] * 60 * 60 * 1000);
  const caseNumber = await nextCaseNumberTx(tx, input.tenantId, now);

  const created = await tx.reconciliationExceptionCase.create({
    data: {
      tenantId: input.tenantId,
      branchId: input.branchId,
      collectorId: input.collectorId ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      caseNumber,
      category: input.category,
      severity,
      status: input.ownerId ? "assigned" : "open",
      title: input.title.slice(0, 180),
      description: input.description?.slice(0, 2000) ?? null,
      amountAtStake: input.amountAtStake == null ? null : money(input.amountAtStake),
      ownerId: input.ownerId ?? null,
      assignedAt: input.ownerId ? now : null,
      dueAt,
      evidence: input.evidence?.trim().slice(0, 1000) ?? null,
      openedById: input.actorId,
      lastActivityAt: now,
    },
    select: { id: true, caseNumber: true, status: true, dueAt: true, severity: true },
  });

  await tx.reconciliationExceptionEvent.create({
    data: {
      tenantId: input.tenantId,
      caseId: created.id,
      type: "opened",
      actorId: input.actorId,
      actorRole: input.actorRole,
      fromStatus: null,
      toStatus: created.status,
      reason: input.description?.slice(0, 500) ?? null,
      evidenceRef: input.evidenceRef ?? null,
      note: input.evidence?.slice(0, 500) ?? null,
      payload: JSON.stringify({
        category: input.category,
        severity,
        amountAtStake: input.amountAtStake ?? null,
        sourceSessionId: input.sourceSessionId ?? null,
        collectorId: input.collectorId ?? null,
      }),
    },
  });

  const seen = new Set<string>();
  for (const link of input.links ?? []) {
    const entityType = link.entityType?.trim();
    const entityId = link.entityId?.trim();
    if (!entityType || !entityId) continue;
    const key = `${entityType}:${entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await tx.reconciliationExceptionLink.create({
      data: {
        tenantId: input.tenantId,
        caseId: created.id,
        entityType,
        entityId,
        note: link.note?.trim() ?? null,
        createdById: input.actorId,
      },
    });
  }

  await createAuditLogTx(tx, {
    userId: input.actorId,
    tenantId: input.tenantId,
    branchId: input.branchId,
    action: "susu.exception_case_opened",
    entityType: "reconciliationExceptionCase",
    entityId: created.id,
    details: {
      caseNumber: created.caseNumber,
      category: input.category,
      severity,
      branchId: input.branchId,
      collectorId: input.collectorId ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      amountAtStake: input.amountAtStake ?? null,
      ownerId: input.ownerId ?? null,
      financialMutation: false,
    },
  });

  return {
    id: created.id,
    caseNumber: created.caseNumber,
    status: created.status,
    dueAt: created.dueAt ?? dueAt,
    severity: created.severity,
  };
}
