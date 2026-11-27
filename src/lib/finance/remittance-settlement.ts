/**
 * Susu remittance settlement engine (Phases 1-3 integration).
 *
 * There is ONE authoritative definition of what a collector still owes the
 * business, and ONE place that decides how money already handed over is
 * matched to the contributions that produced it. Both the Phase 3 declaration
 * workflow and the pre-existing counter-handover action (recordRemittance)
 * read this module, so the two entry points cannot drift into two different
 * definitions of the same financial event.
 *
 * Obligation model
 * ----------------
 *   contributed = sum(non-reversed contributions attributed to the collector)
 *   settled     = sum(per non-reversed, non-returned remittance) of
 *                 cash actually received when it was received, otherwise the
 *                 amount declared (a declaration awaiting custody still
 *                 reduces what is left to declare, so the same cash cannot be
 *                 declared twice)
 *   outstanding = contributed - settled   (never below zero)
 *
 * Receipt shortfalls deliberately remain outstanding: declaring GH₵500 and
 * handing over GH₵400 leaves GH₵100 owed until it is declared again. The shortfall
 * is also recorded as an open discrepancy, so it cannot be forgotten.
 *
 * Allocations are FIFO by collection date and may be PARTIAL: GH₵5,000 of
 * contributions can be settled by 3,000 then 1,500 then 500, with the last
 * contribution split across two declarations. The sum allocated per
 * contribution can never exceed that contribution's amount, so the same money
 * cannot be settled twice.
 */

import type { Prisma } from "@prisma/client";

export type SettlementTx = Prisma.TransactionClient;

/** Round to pesewas without float drift. */
export function money(value: number | string | Prisma.Decimal): number {
  return Math.round(Number(value) * 100) / 100;
}

export interface CollectorObligation {
  contributed: number;
  allocated: number;
  settled: number;
  outstanding: number;
}

export async function computeCollectorObligation(
  tx: SettlementTx,
  tenantId: string,
  collectorId: string
): Promise<CollectorObligation> {
  const contributedAgg = await tx.contribution.aggregate({
    where: { tenantId, collectorId, reversedAt: null },
    _sum: { amount: true },
  });
  const contributed = money(contributedAgg._sum.amount ?? 0);

  const remittances = await tx.collectorRemittance.findMany({
    where: { tenantId, collectorId, reversedAt: null, status: { not: "returned" } },
    select: { remittedAmount: true, receivedAmount: true, receivedAt: true },
  });
  const settled = money(
    remittances.reduce(
      (sum, row) =>
        sum +
        Number(
          row.receivedAt && row.receivedAmount != null
            ? row.receivedAmount
            : row.remittedAmount
        ),
      0
    )
  );

  const allocatedAgg = await tx.remittanceContribution.aggregate({
    where: {
      tenantId,
      contribution: { tenantId, collectorId, reversedAt: null },
      remittance: { tenantId, collectorId, reversedAt: null },
    },
    _sum: { amount: true },
  });
  const allocated = money(allocatedAgg._sum.amount ?? 0);

  return {
    contributed,
    allocated,
    settled,
    outstanding: Math.max(0, money(contributed - settled)),
  };
}

/**
 * Link as much of `amount` as the collector's unsettled contributions can
 * justify, oldest first. Returns the allocated total; anything left over is an
 * over-remittance (cash received beyond what was collected) and is deliberately
 * left unallocated so finance sees it as a variance.
 *
 * The caller MUST already hold the collector settlement lock inside the same
 * transaction, and MUST have computed `amount` from the same transaction.
 */
export async function allocateToContributions(
  tx: SettlementTx,
  params: {
    tenantId: string;
    collectorId: string;
    remittanceId: string;
    amount: number;
  }
): Promise<number> {
  const { tenantId, collectorId, remittanceId } = params;
  let remaining = money(params.amount);
  if (remaining <= 0) return 0;

  const contributions = await tx.contribution.findMany({
    where: { tenantId, collectorId, reversedAt: null },
    orderBy: [{ collectionDate: "asc" }, { createdAt: "asc" }],
    select: { id: true, amount: true },
  });
  if (contributions.length === 0) return 0;

  const links = await tx.remittanceContribution.findMany({
    where: {
      tenantId,
      contributionId: { in: contributions.map((c) => c.id) },
      remittance: { reversedAt: null },
    },
    select: { contributionId: true, amount: true },
  });
  const alreadyAllocated = new Map<string, number>();
  for (const link of links) {
    alreadyAllocated.set(
      link.contributionId,
      money((alreadyAllocated.get(link.contributionId) ?? 0) + Number(link.amount))
    );
  }

  const startOf = money(params.amount);
  for (const contribution of contributions) {
    if (remaining <= 0) break;
    const available = money(
      Number(contribution.amount) - (alreadyAllocated.get(contribution.id) ?? 0)
    );
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    await tx.remittanceContribution.create({
      data: {
        tenantId,
        remittanceId,
        contributionId: contribution.id,
        amount: take,
      },
    });
    remaining = money(remaining - take);
  }
  return money(startOf - Math.max(0, remaining));
}

export const REMITTANCE_DECLARED = "declared";
export const REMITTANCE_SUBMITTED = "submitted";
export const REMITTANCE_RECEIVED = "received";
export const REMITTANCE_VERIFIED = "verified";
export const REMITTANCE_RETURNED = "returned";
export const REMITTANCE_DISPUTED = "disputed";
export const REMITTANCE_REVERSED = "reversed";

export function isRemittanceReversed(status: string | null | undefined): boolean {
  return status === REMITTANCE_REVERSED;
}