"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { requireTenantContext } from "@/lib/tenant";
import {
  deriveProvenance,
  orderProvenanceTimeline,
  type ProvenanceResult,
  type ProvenanceTimelineEntry,
} from "@/lib/evidence-provenance";

/**
 * "How do we know this?" for one transaction.
 *
 * Everything is read through the caller's tenant. The facts the provenance model
 * receives are gathered here and nowhere else, so a company owner can never be shown
 * another business's statement row as the reason a figure is trusted.
 */

const idSchema = z.string().min(1).max(64);

export interface TransactionProvenance {
  provenance: ProvenanceResult;
  timeline: ProvenanceTimelineEntry[];
  /** True because no approved provider integration exists in this build. */
  providerIntegrationAvailable: boolean;
}

export async function getTransactionProvenance(
  transactionId: string
): Promise<{ success: true; data: TransactionProvenance } | { success: false; error: string }> {
  const parsed = idSchema.safeParse(transactionId);
  if (!parsed.success) return { success: false, error: "Invalid transaction." };

  // Any signed-in member of the business may ask how a record is known; the answer is
  // read-only and tenant-scoped. It resolves through the business owner's session, and
  // the transaction lookup below is scoped to that tenant, so a worker in another
  // business cannot read this record.
  const ctx = await requireTenantContext("admin");
  const tenantId = ctx.tenantId;

  const transaction = await db.momoTransaction.findFirst({
    where: { id: parsed.data, tenantId },
    select: {
      id: true,
      amount: true,
      type: true,
      createdAt: true,
      reference: true,
      recordedById: true,
      recordedDeviceId: true,
      status: true,
      correctsTransactionId: true,
      supportingEvidence: true,
      dailyAccountId: true,
      externalReference: true,
    },
  });
  if (!transaction) return { success: false, error: "Transaction not found." };

  const [statementRows, evidenceRows, corrections, exceptions, findings] = await Promise.all([
    db.providerStatementRow.findMany({
      where: { tenantId, matchedEntityType: "momoTransaction", matchedEntityId: transaction.id },
      select: {
        id: true,
        status: true,
        matchType: true,
        matchedAt: true,
        externalReference: true,
        transactionAt: true,
        import: { select: { id: true, status: true } },
      },
      take: 5,
    }),
    db.evidenceAttachment.count({
      where: { tenantId, subjectType: "momoTransaction", subjectId: transaction.id },
    }),
    db.momoTransaction.count({
      where: { tenantId, correctsTransactionId: transaction.id },
    }),
    db.reconciliationExceptionCase.count({
      where: {
        tenantId,
        status: { notIn: ["resolved", "dismissed"] },
        links: { some: { entityType: "momoTransaction", entityId: transaction.id } },
      },
    }),
    db.operationalAnomaly.count({
      where: {
        tenantId,
        status: { not: "resolved" },
        entityType: "momoTransaction",
        entityId: transaction.id,
      },
    }),
  ]);

  // A supporting-evidence pointer typed by the operator counts as attached evidence too.
  const evidenceCount = evidenceRows + (transaction.supportingEvidence ? 1 : 0);
  const matchedRow = statementRows[0] ?? null;
  const statementMatched = Boolean(matchedRow);

  // A provider *record* means an approved, authenticated integration. An imported CSV
  // is the business's own file, so it can never promote a record this far.
  const providerIntegrationAvailable = false;

  const provenance = deriveProvenance({
    recorded: true,
    deviceCaptured: Boolean(transaction.recordedDeviceId),
    evidenceCount,
    statementMatched,
    providerRecordConfirmed: false,
    corrected:
      transaction.status === "reversed" ||
      transaction.status === "corrected" ||
      corrections > 0 ||
      Boolean(transaction.correctsTransactionId),
    openInvestigation: exceptions > 0 || findings > 0,
  });

  const timeline: ProvenanceTimelineEntry[] = [
    {
      at: transaction.createdAt.toISOString(),
      actor: transaction.recordedById,
      label: "Recorded in MaaCash",
      detail: `${transaction.type} of GH₵${Number(transaction.amount).toFixed(2)}`,
      providerConfirmed: false,
    },
  ];

  if (matchedRow?.matchedAt) {
    timeline.push({
      at: matchedRow.matchedAt.toISOString(),
      actor: null,
      label: "Matched to an imported provider statement",
      detail: `${matchedRow.matchType ?? "match"} · ${matchedRow.externalReference ?? "no external reference"}`,
      providerConfirmed: false,
    });
  }
  if (transaction.status === "reversed" || transaction.status === "corrected") {
    timeline.push({
      at: null,
      actor: null,
      label: transaction.status === "reversed" ? "Reversed" : "Corrected",
      detail: "The original entry is kept, and the change carries its own author and time.",
      providerConfirmed: false,
    });
  }
  if (exceptions > 0) {
    timeline.push({
      at: null,
      actor: null,
      label: "Open reconciliation exception",
      detail: `${exceptions} exception${exceptions === 1 ? "" : "s"} still open`,
      providerConfirmed: false,
    });
  }
  if (findings > 0) {
    timeline.push({
      at: null,
      actor: null,
      label: "Open anomaly finding",
      detail: `${findings} finding${findings === 1 ? "" : "s"} not closed`,
      providerConfirmed: false,
    });
  }

  return {
    success: true,
    data: {
      provenance,
      timeline: orderProvenanceTimeline(timeline),
      providerIntegrationAvailable,
    },
  };
}
