/**
 * Phase 5 — read-only difference detection for Susu reconciliation.
 *
 * Every query in this module observes existing records. Nothing here posts,
 * reverses or edits a contribution, remittance, withdrawal or daily account.
 * The only writes are:
 *   * the reconciliation lines that record an observation;
 *   * operational fields on DailyCollectorClosing (recomputed expectations);
 *   * the optional review link on OfflineSyncAttempt.
 *
 * Detection is idempotent by fingerprint. An unreviewed observation is updated
 * in place; a reviewed or case-linked observation is never rewritten — a new
 * revision is appended instead, so history cannot be silently altered.
 */

import type { Prisma } from "@prisma/client";
import {
  addDaysUtc,
  formatBusinessDay,
  money,
  normalizeBusinessDay,
  severityForAmount,
  type LineStatus,
  type Severity,
} from "@/lib/reconciliation-policy";

export type DetectionTx = Prisma.TransactionClient;

export interface ReconciliationSessionInput {
  id: string;
  tenantId: string | null;
  branchId: string | null;
  collectorId: string | null;
  type: string;
  periodStart: Date;
  periodEnd: Date;
}

export interface DetectionFinding {
  fingerprint: string;
  entityType: string;
  entityId: string;
  branchId: string | null;
  collectorId: string | null;
  expectedAmount: number | null;
  declaredAmount: number | null;
  physicalAmount: number | null;
  receivedAmount: number | null;
  verifiedAmount: number | null;
  variance: number;
  status: LineStatus;
  severity: Severity;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface DetectionRunResult {
  findings: DetectionFinding[];
  created: number;
  updated: number;
  revisions: number;
  unchanged: number;
}

export interface ReconciliationSummary {
  definitionVersion: number;
  generatedAt: string;
  expectedTotal: number;
  declaredTotal: number;
  handedOverTotal: number;
  receivedTotal: number;
  verifiedTotal: number;
  shortfallTotal: number;
  overageTotal: number;
  outstandingTotal: number;
  disputedTotal: number;
  amountsAtStake: number;
  lineCount: number;
  matchedCount: number;
  unresolvedCount: number;
  shortfallCount: number;
  overageCount: number;
  unmatchedCount: number;
  duplicateCount: number;
  missingEvidenceCount: number;
  syncFailureCount: number;
  pendingSyncCount: number;
  pendingSyncAmount: number;
  exceptionCaseCount: number;
  byStatus: Record<string, number>;
}

const EPSILON = 0.005;

function amount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? money(n) : null;
}

function classify(diff: number): "matched" | "shortfall" | "overage" {
  if (diff > EPSILON) return "shortfall";
  if (diff < -EPSILON) return "overage";
  return "matched";
}

function periodBounds(periodStart: Date, periodEnd: Date) {
  const start = normalizeBusinessDay(periodStart);
  let end = normalizeBusinessDay(periodEnd);
  if (end < start) end = start;
  return { start, endExclusive: addDaysUtc(end, 1), endDay: end };
}

function dayKey(date: Date): string {
  return formatBusinessDay(normalizeBusinessDay(date));
}

function hashKey(value: string): string {
  // Stable, short, non-secret fingerprint component. FNV-1a is enough here:
  // the full business key is preserved in metadata.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function shiftFinding(input: {
  session: ReconciliationSessionInput;
  fingerprint: string;
  entityType: string;
  entityId: string;
  branchId: string | null;
  collectorId: string | null;
  expectedAmount?: number | null;
  declaredAmount?: number | null;
  physicalAmount?: number | null;
  receivedAmount?: number | null;
  verifiedAmount?: number | null;
  variance: number;
  status: LineStatus;
  reason: string;
  severityAmount?: number | null;
  metadata?: Record<string, unknown>;
}): DetectionFinding {
  return {
    fingerprint: input.fingerprint,
    entityType: input.entityType,
    entityId: input.entityId,
    branchId: input.branchId,
    collectorId: input.collectorId,
    expectedAmount: input.expectedAmount ?? null,
    declaredAmount: input.declaredAmount ?? null,
    physicalAmount: input.physicalAmount ?? null,
    receivedAmount: input.receivedAmount ?? null,
    verifiedAmount: input.verifiedAmount ?? null,
    variance: money(input.variance),
    status: input.status,
    severity: severityForAmount(
      Math.abs(input.severityAmount ?? input.variance ?? 0)
    ),
    reason: input.reason,
    metadata: input.metadata,
  };
}

/**
 * Run every relevant detector for the session and return findings.
 *
 * Session type narrows the detectors:
 *   sync         -> offline synchronization only
 *   remittance   -> Phase 3 remittances and discrepancies only
 *   daily_close  -> one collector's daily closing, contributions and sync
 *   branch_close -> all detectors
 *   other        -> contribution integrity only
 */
export async function detectDifferences(
  tx: DetectionTx,
  session: ReconciliationSessionInput
): Promise<DetectionFinding[]> {
  const { start, endExclusive } = periodBounds(
    session.periodStart,
    session.periodEnd
  );
  const findings: DetectionFinding[] = [];
  const type = session.type;

  const wantsDaily = type === "daily_close" || type === "branch_close";
  const wantsRemittance = type === "remittance" || type === "branch_close";
  const wantsSync = type === "sync" || type === "daily_close" || type === "branch_close";
  const wantsContribution = type !== "remittance" && type !== "sync";

  const collectorFilter = session.collectorId ?? undefined;
  const branchFilter = session.branchId ?? undefined;

  const collectors = await tx.collector.findMany({
    where: {
      tenantId: session.tenantId ?? undefined,
      ...(branchFilter ? { branchId: branchFilter } : {}),
      ...(collectorFilter ? { id: collectorFilter } : {}),
    },
    select: { id: true, userId: true, branchId: true, status: true },
  });
  const collectorById = new Map(collectors.map((c) => [c.id, c]));
  const collectorByUser = new Map(collectors.map((c) => [c.userId, c]));

  // -----------------------------------------------------------------------
  // Contributions (read-only) — used by daily closing, duplicates and
  // integrity checks. Branch attribution is the contribution's own branchId.
  // -----------------------------------------------------------------------
  const contributions = wantsContribution || wantsDaily
    ? await tx.contribution.findMany({
        where: {
          tenantId: session.tenantId ?? undefined,
          ...(branchFilter ? { branchId: branchFilter } : {}),
          ...(collectorFilter ? { collectorId: collectorFilter } : {}),
          collectionDate: { gte: start, lt: endExclusive },
          reversedAt: null,
        },
        select: {
          id: true,
          tenantId: true,
          branchId: true,
          accountId: true,
          collectorId: true,
          amount: true,
          collectionDate: true,
          channel: true,
          referenceId: true,
          recordedDeviceId: true,
          reversedAt: true,
        },
        orderBy: { collectionDate: "asc" },
      })
    : [];

  const contributorTotals = new Map<
    string,
    { recorded: number; synced: number; count: number; syncedCount: number; day: string }
  >();
  for (const contribution of contributions) {
    if (!contribution.collectorId || contribution.channel !== "collector") continue;
    const key = `${contribution.collectorId}|${dayKey(contribution.collectionDate)}`;
    const bucket =
      contributorTotals.get(key) ??
      { recorded: 0, synced: 0, count: 0, syncedCount: 0, day: dayKey(contribution.collectionDate) };
    bucket.recorded = money(bucket.recorded + Number(contribution.amount));
    bucket.count += 1;
    if (contribution.recordedDeviceId) {
      bucket.synced = money(bucket.synced + Number(contribution.amount));
      bucket.syncedCount += 1;
    }
    contributorTotals.set(key, bucket);
  }

  // -----------------------------------------------------------------------
  // Offline synchronization (attempts and queued transactions).
  // -----------------------------------------------------------------------
  const attemptsInPeriod = wantsSync
    ? await tx.offlineSyncAttempt.findMany({
        where: {
          tenantId: session.tenantId ?? undefined,
          createdAt: { gte: start, lt: endExclusive },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];

  // The latest attempt for a key is authoritative across period boundaries.
  const periodKeys = [
    ...new Set(
      attemptsInPeriod
        .map((a) => a.idempotencyKey)
        .filter((key): key is string => Boolean(key))
    ),
  ];
  const latestForKey = new Map<string, (typeof attemptsInPeriod)[number]>();
  if (periodKeys.length > 0) {
    const allForKey = await tx.offlineSyncAttempt.findMany({
      where: { tenantId: session.tenantId ?? undefined, idempotencyKey: { in: periodKeys } },
      orderBy: { createdAt: "desc" },
    });
    for (const attempt of allForKey) {
      if (attempt.idempotencyKey && !latestForKey.has(attempt.idempotencyKey)) {
        latestForKey.set(attempt.idempotencyKey, attempt);
      }
    }
  } else {
    for (const attempt of attemptsInPeriod) latestForKey.set(`id:${attempt.id}`, attempt);
  }

  const failedAttempts: Array<{ attempt: (typeof attemptsInPeriod)[number]; collectorId: string | null; branchId: string | null }> = [];
  const attemptsToLink: string[] = [];
  for (const attempt of attemptsInPeriod) {
    const effective = attempt.idempotencyKey
      ? latestForKey.get(attempt.idempotencyKey) ?? attempt
      : attempt;
    if (effective.outcome !== "rejected" && effective.outcome !== "failed") continue;
    const collector =
      (attempt.collectorId ? collectorById.get(attempt.collectorId) : undefined) ??
      collectorByUser.get(attempt.userId);
    if (branchFilter && collector?.branchId !== branchFilter) continue;
    if (collectorFilter && collector?.id !== collectorFilter) continue;
    failedAttempts.push({
      attempt,
      collectorId: collector?.id ?? attempt.collectorId ?? null,
      branchId: collector?.branchId ?? branchFilter ?? null,
    });
    attemptsToLink.push(attempt.id);
  }

  const pendingTransactions = wantsSync
    ? await tx.offlineTransaction.findMany({
        where: {
          tenantId: session.tenantId ?? undefined,
          ...(branchFilter ? { branchId: branchFilter } : {}),
          status: { in: ["pending_sync", "syncing", "failed"] },
          localTimestamp: { gte: start, lt: endExclusive },
        },
        select: {
          id: true,
          userId: true,
          branchId: true,
          deviceId: true,
          type: true,
          status: true,
          idempotencyKey: true,
          localTimestamp: true,
        },
      })
    : [];

  const syncByCollectorDay = new Map<
    string,
    { pendingCount: number; failedCount: number; pendingAmount: number }
  >();
  const bumpSync = (
    collectorId: string | null,
    day: string,
    field: "pendingCount" | "failedCount" | "pendingAmount",
    value: number
  ) => {
    if (!collectorId) return;
    const key = `${collectorId}|${day}`;
    const bucket = syncByCollectorDay.get(key) ?? {
      pendingCount: 0,
      failedCount: 0,
      pendingAmount: 0,
    };
    bucket[field] += value;
    syncByCollectorDay.set(key, bucket);
  };

  for (const pending of pendingTransactions) {
    const collector = collectorByUser.get(pending.userId);
    if (collectorFilter && collector?.id !== collectorFilter) continue;
    if (branchFilter && pending.branchId !== branchFilter) continue;
    const isFailed = pending.status === "failed";
    findings.push(
      shiftFinding({
        session,
        fingerprint: `offline_transaction:${pending.id}`,
        entityType: "offline_transaction",
        entityId: pending.id,
        branchId: pending.branchId ?? collector?.branchId ?? branchFilter ?? null,
        collectorId: collector?.id ?? null,
        expectedAmount: null,
        variance: 0,
        status: isFailed ? "sync_failure" : "pending_sync",
        severityAmount: 0,
        reason: isFailed
          ? "Offline transaction was recorded locally but the server marked synchronization as failed"
          : "Offline transaction is captured on the device and has not yet synchronized",
        metadata: {
          idempotencyKey: pending.idempotencyKey,
          deviceId: pending.deviceId,
          type: pending.type,
          status: pending.status,
          localTimestamp: pending.localTimestamp.toISOString(),
          amountKnown: false,
        },
      })
    );
    bumpSync(
      collector?.id ?? null,
      dayKey(pending.localTimestamp),
      isFailed ? "failedCount" : "pendingCount",
      1
    );
  }

  for (const { attempt, collectorId, branchId } of failedAttempts) {
    const syncAmount = amount(attempt.amount);
    findings.push(
      shiftFinding({
        session,
        fingerprint: `offline_sync_attempt:${attempt.id}`,
        entityType: "offline_sync_attempt",
        entityId: attempt.id,
        branchId,
        collectorId,
        expectedAmount: syncAmount,
        variance: 0,
        status: "sync_failure",
        severityAmount: syncAmount,
        reason: attempt.reason?.trim() || "Offline contribution synchronization was rejected or failed",
        metadata: {
          reasonCode: attempt.reasonCode,
          retryable: attempt.retryable,
          idempotencyKey: attempt.idempotencyKey,
          deviceId: attempt.deviceId,
          accountId: attempt.accountId,
          outcome: attempt.outcome,
          amountKnown: syncAmount !== null,
        },
      })
    );
    bumpSync(collectorId, dayKey(attempt.createdAt), "failedCount", 1);
    if (syncAmount !== null) {
      bumpSync(collectorId, dayKey(attempt.createdAt), "pendingAmount", syncAmount);
    }
  }

  // -----------------------------------------------------------------------
  // Daily collector closing.
  // -----------------------------------------------------------------------
  if (wantsDaily) {
    const closings = await tx.dailyCollectorClosing.findMany({
      where: {
        tenantId: session.tenantId ?? undefined,
        ...(branchFilter ? { branchId: branchFilter } : {}),
        ...(collectorFilter ? { collectorId: collectorFilter } : {}),
        closingDate: { gte: start, lt: endExclusive },
      },
      orderBy: { closingDate: "asc" },
    });
    const closingKeys = new Set<string>();

    for (const closing of closings) {
      const collector = collectorById.get(closing.collectorId);
      const key = `${closing.collectorId}|${dayKey(closing.closingDate)}`;
      closingKeys.add(key);
      const totals = contributorTotals.get(key);
      const expected = totals?.recorded ?? 0;
      const synced = totals?.synced ?? 0;
      const sync = syncByCollectorDay.get(key);
      const pendingAmount = money(sync?.pendingAmount ?? 0);
      const pendingCount = sync?.pendingCount ?? 0;
      const failedCount = sync?.failedCount ?? 0;

      // Operational fields are refreshed from server-side records. Financial
      // records are never touched.
      if (
        amount(closing.expectedCash) !== expected ||
        amount(closing.contributionsRecorded) !== expected ||
        amount(closing.contributionsSynced) !== synced ||
        amount(closing.contributionsPending) !== pendingAmount ||
        closing.pendingSyncCount !== pendingCount ||
        closing.failedSyncCount !== failedCount
      ) {
        await tx.dailyCollectorClosing.update({
          where: { id: closing.id },
          data: {
            expectedCash: expected,
            contributionsRecorded: expected,
            contributionsSynced: synced,
            contributionsPending: pendingAmount,
            pendingSyncCount: pendingCount,
            failedSyncCount: failedCount,
          },
        });
      }

      const declared = amount(closing.declaredCash);
      const physical = amount(closing.handoverAmount);
      const received = amount(closing.receivedAmount);
      const actual = received ?? physical ?? declared ?? 0;
      const variance = money(expected - actual);
      const status: LineStatus =
        received === null
          ? declared === null && physical === null
            ? "missing_evidence"
            : classify(money(expected - (physical ?? declared ?? 0))) === "matched"
              ? "unmatched"
              : classify(money(expected - (physical ?? declared ?? 0)))
          : classify(variance);

      findings.push(
        shiftFinding({
          session,
          fingerprint: `daily_closing:${closing.id}:cash`,
          entityType: "daily_closing",
          entityId: closing.id,
          branchId: closing.branchId ?? collector?.branchId ?? branchFilter ?? null,
          collectorId: closing.collectorId,
          expectedAmount: expected,
          declaredAmount: declared,
          physicalAmount: physical,
          receivedAmount: received,
          verifiedAmount: null,
          variance,
          status,
          severityAmount: variance,
          reason:
            status === "shortfall"
              ? "Cash counted/received is less than the contributions recorded for this collector"
              : status === "overage"
                ? "Cash counted/received is more than the contributions recorded for this collector"
                : status === "unmatched"
                  ? "Cash has been declared or handed over but not yet received and counted by office staff"
                  : status === "missing_evidence"
                    ? "No cash declaration or office receipt exists for this closing"
                    : "Declared, handed-over and received cash agree with recorded contributions",
          metadata: {
            status: closing.status,
            declaredById: closing.declaredById,
            handedOverById: closing.handedOverById,
            receivedById: closing.receivedById,
            declarationEvidenceRef: closing.declarationEvidenceRef,
            handoverEvidenceRef: closing.handoverEvidenceRef,
            receiptEvidenceRef: closing.receiptEvidenceRef,
            pendingSyncCount: pendingCount,
            failedSyncCount: failedCount,
            closingDate: dayKey(closing.closingDate),
          },
        })
      );

      if (pendingAmount > EPSILON || pendingCount > 0) {
        findings.push(
          shiftFinding({
            session,
            fingerprint: `daily_closing:${closing.id}:pending_sync`,
            entityType: "daily_closing",
            entityId: closing.id,
            branchId: closing.branchId ?? collector?.branchId ?? branchFilter ?? null,
            collectorId: closing.collectorId,
            expectedAmount: pendingAmount > EPSILON ? pendingAmount : null,
            variance: 0,
            status: "pending_sync",
            severityAmount: pendingAmount,
            reason:
              "Field contributions for this closing are still awaiting a successful offline synchronization",
            metadata: {
              pendingSyncCount: pendingCount,
              failedSyncCount: failedCount,
              pendingAmountKnown: pendingAmount > EPSILON,
            },
          })
        );
      }

      const hasEvidence = Boolean(
        closing.declarationEvidenceRef ||
          closing.handoverEvidenceRef ||
          closing.receiptEvidenceRef
      );
      if (Math.abs(variance) > EPSILON && !hasEvidence) {
        findings.push(
          shiftFinding({
            session,
            fingerprint: `daily_closing:${closing.id}:evidence`,
            entityType: "daily_closing",
            entityId: closing.id,
            branchId: closing.branchId ?? collector?.branchId ?? branchFilter ?? null,
            collectorId: closing.collectorId,
            expectedAmount: null,
            variance: Math.abs(variance),
            status: "missing_evidence",
            severityAmount: variance,
            reason:
              "The closing has a cash difference but no receipt, handover or declaration evidence reference",
            metadata: { varianceAmount: variance, closingDate: dayKey(closing.closingDate) },
          })
        );
      }
    }

    // Contributions recorded with no closing record at all.
    for (const [key, totals] of contributorTotals.entries()) {
      if (closingKeys.has(key)) continue;
      const [collectorId, day] = key.split("|");
      const collector = collectorById.get(collectorId);
      if (collectorFilter && collectorId !== collectorFilter) continue;
      findings.push(
        shiftFinding({
          session,
          fingerprint: `daily_closing_missing:${collectorId}:${day}`,
          entityType: "daily_closing",
          entityId: `${collectorId}:${day}`,
          branchId: collector?.branchId ?? branchFilter ?? null,
          collectorId,
          expectedAmount: totals.recorded,
          variance: totals.recorded,
          status: "missing_evidence",
          severityAmount: totals.recorded,
          reason:
            "Contributions were recorded for this collector and day but no daily closing exists",
          metadata: { closingDate: day, contributionCount: totals.count },
        })
      );
    }

    // Keep the session's synchronised attempts linked for review. This writes
    // review metadata only; outcome, retry flag and payload digest are intact.
    if (attemptsToLink.length > 0) {
      await tx.offlineSyncAttempt.updateMany({
        where: { id: { in: attemptsToLink }, tenantId: session.tenantId ?? undefined },
        data: { reconciliationId: session.id },
      });
    }
  }

  // -----------------------------------------------------------------------
  // Formal Phase 3 remittances and their discrepancies.
  // -----------------------------------------------------------------------
  if (wantsRemittance) {
    const remittances = await tx.collectorRemittance.findMany({
      where: {
        tenantId: session.tenantId ?? undefined,
        ...(collectorFilter ? { collectorId: collectorFilter } : {}),
        ...(branchFilter
          ? { OR: [{ branchId: branchFilter }, { receivingBranchId: branchFilter }] }
          : {}),
        createdAt: { gte: start, lt: endExclusive },
      },
      include: { discrepancies: true },
      orderBy: { createdAt: "asc" },
    });

    for (const remittance of remittances) {
      const expected = amount(remittance.expectedAmount) ?? 0;
      const declared = amount(remittance.remittedAmount);
      const received = amount(remittance.receivedAmount);
      const verified = amount(remittance.verifiedAmount);
      const reversed = Boolean(remittance.reversedAt) || remittance.status === "reversed";
      const actual = verified ?? received ?? declared ?? 0;
      const variance = money(expected - actual);
      const status: LineStatus = reversed
        ? "unmatched"
        : received === null
          ? "unmatched"
          : classify(variance);
      findings.push(
        shiftFinding({
          session,
          fingerprint: `remittance:${remittance.id}`,
          entityType: "collector_remittance",
          entityId: remittance.id,
          branchId: remittance.receivingBranchId ?? remittance.branchId ?? branchFilter ?? null,
          collectorId: remittance.collectorId,
          expectedAmount: expected,
          declaredAmount: declared,
          receivedAmount: received,
          verifiedAmount: verified,
          variance,
          status,
          severityAmount: variance,
          reason: reversed
            ? "The declaration was reversed; custody and allocation evidence must be reviewed"
            : received === null
              ? "The declaration has not been received and counted by office staff"
              : status === "shortfall"
                ? "Cash received or verified is less than the collector's outstanding obligation"
                : status === "overage"
                  ? "Cash received or verified exceeds the collector's outstanding obligation"
                  : "Declared, received and verified amounts agree with the obligation",
          metadata: {
            remittanceStatus: remittance.status,
            referenceId: remittance.referenceId,
            method: remittance.method,
            transactionReference: remittance.transactionReference,
            receiptEvidenceRef: remittance.receiptEvidenceRef,
            verificationEvidenceRef: remittance.verificationEvidenceRef,
            reversedAt: remittance.reversedAt?.toISOString() ?? null,
          },
        })
      );

      for (const discrepancy of remittance.discrepancies) {
        const resolved = Boolean(discrepancy.resolutionAt) || discrepancy.status === "resolved";
        if (resolved) continue;
        const dVariance = amount(discrepancy.variance) ?? 0;
        const mapped: LineStatus =
          Math.abs(dVariance) <= EPSILON
            ? "missing_evidence"
            : dVariance > 0
              ? "shortfall"
              : "overage";
        findings.push(
          shiftFinding({
            session,
            fingerprint: `remittance_discrepancy:${discrepancy.id}`,
            entityType: "remittance_discrepancy",
            entityId: discrepancy.id,
            branchId: remittance.receivingBranchId ?? remittance.branchId ?? branchFilter ?? null,
            collectorId: remittance.collectorId,
            expectedAmount: amount(discrepancy.expectedAmount),
            declaredAmount: amount(discrepancy.declaredAmount),
            receivedAmount: amount(discrepancy.receivedAmount),
            verifiedAmount: amount(discrepancy.verifiedAmount),
            variance: dVariance,
            status: mapped,
            severityAmount: dVariance,
            reason: discrepancy.reason || "Formal remittance discrepancy recorded by Phase 3",
            metadata: {
              discrepancyId: discrepancy.id,
              remittanceId: discrepancy.remittanceId,
              type: discrepancy.type,
              status: discrepancy.status,
              evidenceRef: discrepancy.evidenceRef,
            },
          })
        );
        if (!discrepancy.evidenceRef) {
          findings.push(
            shiftFinding({
              session,
              fingerprint: `remittance_discrepancy_evidence:${discrepancy.id}`,
              entityType: "remittance_discrepancy",
              entityId: discrepancy.id,
              branchId: remittance.receivingBranchId ?? remittance.branchId ?? branchFilter ?? null,
              collectorId: remittance.collectorId,
              expectedAmount: null,
              variance: Math.abs(dVariance),
              status: "missing_evidence",
              severityAmount: dVariance,
              reason: "The formal remittance discrepancy has no supporting evidence reference",
              metadata: { discrepancyId: discrepancy.id, remittanceId: discrepancy.remittanceId, type: discrepancy.type },
            })
          );
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Contribution integrity: duplicate business fingerprints, reversals kept
  // in an active settlement, over-allocation and placeholder references.
  // -----------------------------------------------------------------------
  if (wantsContribution) {
    const duplicateGroups = new Map<string, typeof contributions>();
    for (const contribution of contributions) {
      const key = [
        contribution.accountId,
        contribution.collectorId ?? "office",
        money(Number(contribution.amount)).toFixed(2),
        dayKey(contribution.collectionDate),
      ].join("|");
      const group = duplicateGroups.get(key) ?? [];
      group.push(contribution);
      duplicateGroups.set(key, group);
    }
    for (const [key, group] of duplicateGroups.entries()) {
      if (group.length < 2) continue;
      const first = group[0];
      const exposure = money(Number(first.amount) * (group.length - 1));
      findings.push(
        shiftFinding({
          session,
          fingerprint: `contribution_duplicate:${hashKey(key)}`,
          entityType: "contribution",
          entityId: first.id,
          branchId: first.branchId ?? branchFilter ?? null,
          collectorId: first.collectorId,
          expectedAmount: null,
          variance: exposure,
          status: "duplicate",
          severityAmount: exposure,
          reason:
            "Two or more contributions share the same account, collector, amount and business day; confirm they are separate cash collections",
          metadata: {
            businessKey: key,
            count: group.length,
            contributionIds: group.map((c) => c.id),
            referenceIds: group.map((c) => c.referenceId),
            exposureAmount: exposure,
          },
        })
      );
    }

    for (const contribution of contributions) {
      if (/^(n\/a|na|none|null|unknown|test|-|0)$/i.test(contribution.referenceId.trim())) {
        findings.push(
          shiftFinding({
            session,
            fingerprint: `contribution_reference:${contribution.id}`,
            entityType: "contribution",
            entityId: contribution.id,
            branchId: contribution.branchId ?? branchFilter ?? null,
            collectorId: contribution.collectorId,
            expectedAmount: null,
            variance: 0,
            status: "missing_evidence",
            severityAmount: 0,
            reason: "The contribution reference looks like a placeholder rather than a traceable receipt reference",
            metadata: { referenceId: contribution.referenceId },
          })
        );
      }
    }

    // A reversed contribution must not remain part of an active declaration.
    const reversedLinked = await tx.contribution.findMany({
      where: {
        tenantId: session.tenantId ?? undefined,
        ...(branchFilter ? { branchId: branchFilter } : {}),
        ...(collectorFilter ? { collectorId: collectorFilter } : {}),
        reversedAt: { not: null },
        collectionDate: { gte: start, lt: endExclusive },
        remittanceLinks: { some: { remittance: { reversedAt: null } } },
      },
      select: { id: true, branchId: true, collectorId: true, amount: true, referenceId: true },
    });
    for (const contribution of reversedLinked) {
      findings.push(
        shiftFinding({
          session,
          fingerprint: `contribution_reversed_linked:${contribution.id}`,
          entityType: "contribution",
          entityId: contribution.id,
          branchId: contribution.branchId ?? branchFilter ?? null,
          collectorId: contribution.collectorId,
          expectedAmount: null,
          variance: money(Number(contribution.amount)),
          status: "unmatched",
          severityAmount: Number(contribution.amount),
          reason:
            "A reversed contribution is still allocated to a remittance that has not been reversed",
          metadata: { referenceId: contribution.referenceId },
        })
      );
    }

    // A contribution must not be allocated more than its face value.
    const contributionIds = contributions.map((c) => c.id);
    if (contributionIds.length > 0) {
      const overAllocated = await tx.remittanceContribution.groupBy({
        by: ["contributionId"],
        where: { contributionId: { in: contributionIds } },
        _sum: { amount: true },
      });
      const contributionAmount = new Map(
        contributions.map((c) => [c.id, Number(c.amount)])
      );
      const overIds = overAllocated
        .filter((row) => {
          const total = Number(row._sum.amount ?? 0);
          return total - (contributionAmount.get(row.contributionId) ?? 0) > EPSILON;
        })
        .map((row) => row.contributionId);
      if (overIds.length > 0) {
        const overRows = await tx.contribution.findMany({
          where: { tenantId: session.tenantId ?? undefined, id: { in: overIds } },
          select: { id: true, branchId: true, collectorId: true, amount: true, referenceId: true },
        });
        for (const contribution of overRows) {
          const total = money(
            Number(overAllocated.find((r) => r.contributionId === contribution.id)?._sum.amount ?? 0)
          );
          findings.push(
            shiftFinding({
              session,
              fingerprint: `contribution_over_allocated:${contribution.id}`,
              entityType: "contribution",
              entityId: contribution.id,
              branchId: contribution.branchId ?? branchFilter ?? null,
              collectorId: contribution.collectorId,
              expectedAmount: money(Number(contribution.amount)),
              variance: money(total - Number(contribution.amount)),
              status: "duplicate",
              severityAmount: total,
              reason: "Remittance allocations exceed the contribution amount",
              metadata: { allocatedTotal: total, referenceId: contribution.referenceId },
            })
          );
        }
      }
    }
  }

  // Persist the reviewed sync attempts for remittance/sync sessions too.
  if (!wantsDaily && attemptsToLink.length > 0) {
    await tx.offlineSyncAttempt.updateMany({
      where: { id: { in: attemptsToLink }, tenantId: session.tenantId ?? undefined },
      data: { reconciliationId: session.id },
    });
  }

  // De-duplicate by fingerprint (defensive; each detector is normally unique).
  const byFingerprint = new Map<string, DetectionFinding>();
  for (const finding of findings) {
    if (!byFingerprint.has(finding.fingerprint)) {
      byFingerprint.set(finding.fingerprint, finding);
    }
  }
  return [...byFingerprint.values()];
}

/**
 * Apply findings idempotently.
 *
 * An unreviewed, case-free observation is refreshed in place. A reviewed or
 * case-linked observation is never mutated: a new revision is appended, which
 * keeps the earlier evidence exactly as it was seen.
 */
export async function applyFindings(
  tx: DetectionTx,
  session: ReconciliationSessionInput,
  findings: DetectionFinding[]
): Promise<DetectionRunResult> {
  let created = 0;
  let updated = 0;
  let revisions = 0;
  let unchanged = 0;
  const now = new Date();

  for (const finding of findings) {
    const latest = await tx.reconciliationLine.findFirst({
      where: {
        sessionId: session.id,
        fingerprint: finding.fingerprint,
      },
      orderBy: { revision: "desc" },
    });

    const data = {
      tenantId: session.tenantId,
      branchId: finding.branchId,
      collectorId: finding.collectorId,
      entityType: finding.entityType,
      entityId: finding.entityId,
      expectedAmount: finding.expectedAmount,
      declaredAmount: finding.declaredAmount,
      physicalAmount: finding.physicalAmount,
      receivedAmount: finding.receivedAmount,
      verifiedAmount: finding.verifiedAmount,
      variance: finding.variance,
      status: finding.status,
      severity: finding.severity,
      reason: finding.reason,
      metadataJson: finding.metadata ? JSON.stringify(finding.metadata) : null,
      lastSeenAt: now,
    };

    if (!latest) {
      await tx.reconciliationLine.create({
        data: {
          ...data,
          sessionId: session.id,
          fingerprint: finding.fingerprint,
          revision: 1,
        },
      });
      created += 1;
      continue;
    }

    const sameAmounts =
      amount(latest.expectedAmount) === finding.expectedAmount &&
      amount(latest.declaredAmount) === finding.declaredAmount &&
      amount(latest.physicalAmount) === finding.physicalAmount &&
      amount(latest.receivedAmount) === finding.receivedAmount &&
      amount(latest.verifiedAmount) === finding.verifiedAmount &&
      amount(latest.variance) === finding.variance;
    const sameStatus = latest.status === finding.status;
    const frozen = Boolean(latest.reviewedAt || latest.exceptionCaseId);

    if (sameAmounts && sameStatus) {
      await tx.reconciliationLine.update({
        where: { id: latest.id },
        data: { lastSeenAt: now },
      });
      unchanged += 1;
      continue;
    }

    if (frozen) {
      await tx.reconciliationLine.create({
        data: {
          ...data,
          sessionId: session.id,
          fingerprint: finding.fingerprint,
          revision: latest.revision + 1,
        },
      });
      revisions += 1;
      continue;
    }

    await tx.reconciliationLine.update({ where: { id: latest.id }, data });
    updated += 1;
  }

  return { findings, created, updated, revisions, unchanged };
}

/** Build the reporting summary from the latest revision of each fingerprint. */
export function summarizeLines(
  lines: Array<{
    fingerprint: string;
    revision: number;
    status: string;
    expectedAmount: unknown;
    declaredAmount: unknown;
    physicalAmount: unknown;
    receivedAmount: unknown;
    verifiedAmount: unknown;
    variance: unknown;
    exceptionCaseId: string | null;
  }>,
  generatedAt: Date
): ReconciliationSummary {
  const latest = new Map<string, (typeof lines)[number]>();
  for (const line of lines) {
    const current = latest.get(line.fingerprint);
    if (!current || line.revision > current.revision) latest.set(line.fingerprint, line);
  }

  const summary: ReconciliationSummary = {
    definitionVersion: 1,
    generatedAt: generatedAt.toISOString(),
    expectedTotal: 0,
    declaredTotal: 0,
    handedOverTotal: 0,
    receivedTotal: 0,
    verifiedTotal: 0,
    shortfallTotal: 0,
    overageTotal: 0,
    outstandingTotal: 0,
    disputedTotal: 0,
    amountsAtStake: 0,
    lineCount: latest.size,
    matchedCount: 0,
    unresolvedCount: 0,
    shortfallCount: 0,
    overageCount: 0,
    unmatchedCount: 0,
    duplicateCount: 0,
    missingEvidenceCount: 0,
    syncFailureCount: 0,
    pendingSyncCount: 0,
    pendingSyncAmount: 0,
    exceptionCaseCount: 0,
    byStatus: {},
  };
  const linkedCases = new Set<string>();

  for (const line of latest.values()) {
    if (line.exceptionCaseId) linkedCases.add(line.exceptionCaseId);
    const expected = amount(line.expectedAmount) ?? 0;
    const variance = amount(line.variance) ?? 0;
    summary.expectedTotal = money(summary.expectedTotal + (amount(line.expectedAmount) ?? 0));
    summary.declaredTotal = money(summary.declaredTotal + (amount(line.declaredAmount) ?? 0));
    summary.handedOverTotal = money(summary.handedOverTotal + (amount(line.physicalAmount) ?? 0));
    summary.receivedTotal = money(summary.receivedTotal + (amount(line.receivedAmount) ?? 0));
    summary.verifiedTotal = money(summary.verifiedTotal + (amount(line.verifiedAmount) ?? 0));
    if (variance > 0) summary.shortfallTotal = money(summary.shortfallTotal + variance);
    if (variance < 0) summary.overageTotal = money(summary.overageTotal - variance);
    summary.byStatus[line.status] = (summary.byStatus[line.status] ?? 0) + 1;

    if (line.status === "matched" || line.status === "reviewed") {
      summary.matchedCount += 1;
      continue;
    }
    summary.unresolvedCount += 1;
    summary.amountsAtStake = money(summary.amountsAtStake + Math.abs(variance));
    summary.disputedTotal = summary.amountsAtStake;
    if (line.status === "shortfall") summary.shortfallCount += 1;
    else if (line.status === "overage") summary.overageCount += 1;
    else if (line.status === "unmatched") summary.unmatchedCount += 1;
    else if (line.status === "duplicate") summary.duplicateCount += 1;
    else if (line.status === "missing_evidence") summary.missingEvidenceCount += 1;
    else if (line.status === "sync_failure") summary.syncFailureCount += 1;
    else if (line.status === "pending_sync") summary.pendingSyncCount += 1;

    if (line.status === "pending_sync" || line.status === "sync_failure") {
      summary.pendingSyncAmount = money(
        summary.pendingSyncAmount + Math.abs(amount(line.expectedAmount) ?? variance)
      );
    }
    // A missing closing or missing receipt is still money the business has not
    // seen. Pending offline rows are excluded here because they are reported in
    // pendingSyncAmount until the server accepts or rejects them.
    if (
      line.status !== "pending_sync" &&
      line.status !== "sync_failure" &&
      line.status !== "duplicate"
    ) {
      const counted = amount(line.verifiedAmount) ?? amount(line.receivedAmount) ?? 0;
      if (expected > counted) {
        summary.outstandingTotal = money(summary.outstandingTotal + (expected - counted));
      }
    }
  }

  summary.exceptionCaseCount = linkedCases.size;
  return summary;
}
