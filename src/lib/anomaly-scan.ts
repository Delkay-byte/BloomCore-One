/**
 * Collecting deterministic anomaly findings for one business.
 *
 * Split from the server action so a scheduled run and a manual run evaluate the
 * same rules over the same period. It only reads.
 */

import { db } from "@/lib/db";
import { createAuditLogTx } from "@/lib/audit";
import { createNotification } from "@/lib/notifications/notifications";
import { evaluateAnomalies, type AnomalyFinding } from "@/lib/anomaly-rules";
import {
  scanDisposition,
  selectAlerts,
  suppressionCovers,
  suppressionIsActive,
} from "@/lib/anomaly-investigation";
import { snapshotHash } from "@/lib/anomaly-snapshot";

export interface AnomalyPeriod {
  from: string;
  to: string;
}

export async function collectAnomalyFindings(
  tenantId: string,
  period: AnomalyPeriod,
  now: Date
): Promise<AnomalyFinding[]> {
  const [locations, accounts, transactions, transfers, handovers] = await Promise.all([
    db.location.findMany({
      where: { tenantId: tenantId, status: "active" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.dailyAccount.findMany({
      where: {
        tenantId: tenantId,
        businessDate: {
          gte: new Date(`${period.from}T00:00:00.000Z`),
          lte: new Date(`${period.to}T23:59:59.999Z`),
        },
      },
      select: {
        id: true,
        locationId: true,
        location: { select: { name: true } },
        workerId: true,
        worker: { select: { fullName: true } },
        businessDate: true,
        status: true,
        submittedAt: true,
        reviewedAt: true,
        totalExpenses: true,
        calculatedDifference: true,
        ledgerMode: true,
      },
    }),
    db.momoTransaction.findMany({
      where: {
        tenantId: tenantId,
        businessDate: {
          gte: new Date(`${period.from}T00:00:00.000Z`),
          lte: new Date(`${period.to}T23:59:59.999Z`),
        },
      },
      select: {
        id: true,
        type: true,
        amount: true,
        status: true,
        businessDate: true,
        locationId: true,
        location: { select: { name: true } },
        workerId: true,
        worker: { select: { fullName: true } },
        reference: true,
        reversesTransactionId: true,
      },
    }),
    db.branchTransfer.findMany({
      where: {
        tenantId: tenantId,
        OR: [
          {
            createdAt: {
              gte: new Date(`${period.from}T00:00:00.000Z`),
              lte: new Date(`${period.to}T23:59:59.999Z`),
            },
          },
          { status: { in: ["approved", "dispatched", "variance_investigation"] } },
        ],
      },
      select: {
        id: true,
        reference: true,
        status: true,
        amount: true,
        variance: true,
        sourceLocationId: true,
        destinationLocationId: true,
        approvedAt: true,
        dispatchedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.shiftHandover.findMany({
      where: {
        tenantId: tenantId,
        shift: {
          businessDate: {
            gte: new Date(`${period.from}T00:00:00.000Z`),
            lte: new Date(`${period.to}T23:59:59.999Z`),
          },
        },
      },
      select: {
        id: true,
        shiftId: true,
        status: true,
        outgoingUserId: true,
        cashVariance: true,
        floatVariance: true,
        createdAt: true,
        confirmedAt: true,
        shift: {
          select: {
            businessDate: true,
            locationId: true,
            location: { select: { name: true } },
          },
        },
      },
    }),
  ]);

  const workerIds = Array.from(
    new Set([
      ...accounts.map((row) => row.workerId),
      ...transactions.map((row) => row.workerId),
      ...handovers.map((row) => row.outgoingUserId),
    ])
  );
  const workers =
    workerIds.length > 0
      ? await db.user.findMany({
          where: { tenantId: tenantId, id: { in: workerIds } },
          select: { id: true, fullName: true },
        })
      : [];
  const workerNames = new Map(workers.map((row) => [row.id, row.fullName]));

  const findings = evaluateAnomalies({
    from: period.from,
    to: period.to,
    now,
    locations,
    accounts: accounts.map((row) => ({
      id: row.id,
      locationId: row.locationId,
      locationName: row.location.name,
      workerId: row.workerId,
      workerName: row.worker.fullName,
      businessDate: row.businessDate,
      status: row.status,
      submittedAt: row.submittedAt,
      reviewedAt: row.reviewedAt,
      totalExpenses: row.totalExpenses,
      calculatedDifference: row.calculatedDifference,
      ledgerMode: row.ledgerMode,
    })),
    transactions: transactions.map((row) => ({
      id: row.id,
      type: row.type,
      amount: row.amount,
      status: row.status,
      businessDate: row.businessDate,
      locationId: row.locationId,
      locationName: row.location.name,
      workerId: row.workerId,
      workerName: row.worker.fullName,
      reference: row.reference,
      isReversal: Boolean(row.reversesTransactionId) || row.status === "reversal",
    })),
    transfers,
    handovers: handovers.map((row) => ({
      id: row.id,
      shiftId: row.shiftId,
      status: row.status,
      outgoingUserId: row.outgoingUserId,
      outgoingUserName: workerNames.get(row.outgoingUserId) ?? "Employee",
      cashVariance: row.cashVariance,
      floatVariance: row.floatVariance,
      createdAt: row.createdAt,
      confirmedAt: row.confirmedAt,
      businessDate: row.shift.businessDate,
      locationId: row.shift.locationId,
      locationName: row.shift.location.name,
    })),
  });

  return findings;
}

export interface ScanSummary {
  scanned: number;
  created: number;
  updated: number;
  reopened: number;
  suppressed: number;
  notified: number;
  high: number;
  medium: number;
  low: number;
  period: { from: string; to: string };
  runId: string | null;
}

/**
 * Persist one scan's findings.
 *
 * A rescan no longer overwrites what was seen. Each finding keeps a first-seen
 * date and a hash of its evidence; when the evidence, metric or severity changes,
 * an `AnomalyFindingEvent` is appended with the values seen and the hash of
 * exactly that evidence. A closed finding that is still true is reopened rather
 * than left closed, unless an unexpired suppression covers it.
 *
 * Alert fatigue is controlled in the same pass: only newly created, high findings
 * raise a notification, at most `ALERT_BUDGET_PER_RUN` per scan, and never the
 * same finding twice inside `NOTIFY_QUIET_HOURS`.
 */
export async function persistAnomalyFindings(input: {
  tenantId: string;
  actorId: string | null;
  trigger: "manual" | "scheduled";
  period: { from: string; to: string };
  findings: AnomalyFinding[];
  now?: Date;
}): Promise<ScanSummary> {
  const now = input.now ?? new Date();
  const { tenantId, findings, period } = input;

  const run = await db.anomalyScanRun.create({
    data: {
      tenantId,
      trigger: input.trigger,
      status: "running",
      startedAt: now,
      periodFrom: period.from,
      periodTo: period.to,
    },
    select: { id: true },
  });

  const fingerprints = findings.map((row) => row.fingerprint);
  const [existing, suppressions] = await Promise.all([
    db.operationalAnomaly.findMany({
      where: { tenantId, fingerprint: { in: fingerprints } },
    }),
    db.anomalySuppression.findMany({
      where: { tenantId, revokedAt: null, expiresAt: { gt: now } },
    }),
  ]);
  const existingByFingerprint = new Map(existing.map((row) => [row.fingerprint, row]));
  const hashOf = (finding: AnomalyFinding) =>
    snapshotHash(finding.entityType, finding.entityId, finding.evidence);

  const created = findings.filter((row) => !existingByFingerprint.has(row.fingerprint));
  const suppressed = findings.filter((finding) =>
    suppressions.some((rule) => suppressionCovers(rule, finding) && suppressionIsActive(rule, now))
  );
  const suppressedFingerprints = new Set(suppressed.map((row) => row.fingerprint));
  const createdFingerprints = new Set(created.map((row) => row.fingerprint));
  const alerts = selectAlerts(
    findings
      .filter((row) => createdFingerprints.has(row.fingerprint))
      .filter((row) => !suppressedFingerprints.has(row.fingerprint))
      .map((row) => ({
        fingerprint: row.fingerprint,
        severity: row.severity,
        lastNotifiedAt: null,
      })),
    now
  );
  const alertFingerprints = new Set(alerts.map((row) => row.fingerprint));
  const notifiedAt = new Map<string, string>();
  let reopened = 0;

  await db.$transaction(async (tx) => {
    for (const finding of findings) {
      const previous = existingByFingerprint.get(finding.fingerprint);
      const hash = hashOf(finding);
      const evidence = JSON.stringify(finding.evidence);
      const base = {
        severity: finding.severity,
        title: finding.title,
        summary: finding.summary,
        locationId: finding.locationId,
        workerId: finding.workerId,
        businessDate: finding.businessDate
          ? new Date(`${finding.businessDate}T00:00:00.000Z`)
          : null,
        metricValue: finding.metricValue,
        thresholdValue: finding.thresholdValue,
        evidence,
        lastSeenAt: now,
        snapshotHash: hash,
      };

      const row = await tx.operationalAnomaly.upsert({
        where: { tenantId_fingerprint: { tenantId, fingerprint: finding.fingerprint } },
        create: {
          tenantId,
          fingerprint: finding.fingerprint,
          ruleKey: finding.ruleKey,
          entityType: finding.entityType,
          entityId: finding.entityId,
          firstSeenAt: now,
          detectedAt: now,
          ...base,
        },
        update: base,
        select: { id: true },
      });

      if (!previous) {
        await tx.anomalyFindingEvent.create({
          data: {
            tenantId,
            anomalyId: row.id,
            kind: "detected",
            severity: finding.severity,
            metricValue: finding.metricValue,
            thresholdValue: finding.thresholdValue,
            summary: finding.summary,
            evidence,
            snapshotHash: hash,
            actorId: input.actorId,
            scanRunId: run.id,
          },
        });
      } else {
        const action = scanDisposition({
          status: previous.status,
          disposition: null,
          lastSnapshotHash: previous.snapshotHash ?? null,
          newSnapshotHash: hash,
          suppressed: suppressedFingerprints.has(finding.fingerprint),
        });
        if (action === "reopen") {
          reopened += 1;
          await tx.operationalAnomaly.update({
            where: { id: row.id },
            data: {
              status: "open",
              resolvedById: null,
              resolvedAt: null,
              reopenCount: { increment: 1 },
            },
          });
          await tx.anomalyFindingEvent.create({
            data: {
              tenantId,
              anomalyId: row.id,
              kind: "reopened",
              severity: finding.severity,
              metricValue: finding.metricValue,
              thresholdValue: finding.thresholdValue,
              summary: finding.summary,
              evidence,
              snapshotHash: hash,
              note: "The condition was detected again after this finding was closed.",
              actorId: input.actorId,
              scanRunId: run.id,
            },
          });
        } else if (action === "updated") {
          await tx.anomalyFindingEvent.create({
            data: {
              tenantId,
              anomalyId: row.id,
              kind: "rescan",
              severity: finding.severity,
              metricValue: finding.metricValue,
              thresholdValue: finding.thresholdValue,
              summary: finding.summary,
              evidence,
              snapshotHash: hash,
              actorId: input.actorId,
              scanRunId: run.id,
            },
          });
        }
      }

      if (alertFingerprints.has(finding.fingerprint)) {
        await tx.operationalAnomaly.update({
          where: { id: row.id },
          data: { lastNotifiedAt: now },
        });
        notifiedAt.set(finding.fingerprint, row.id);
      }
    }

    await tx.anomalyScanRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        finishedAt: new Date(),
        scanned: findings.length,
        created: created.length,
        reopened,
        suppressed: suppressed.length,
        notified: alertFingerprints.size,
      },
    });

    await createAuditLogTx(tx, {
      userId: input.actorId ?? "system:anomaly-scan",
      tenantId,
      action: "anomaly.scan_completed",
      entityType: "tenant",
      entityId: tenantId,
      details: {
        trigger: input.trigger,
        from: period.from,
        to: period.to,
        scanned: findings.length,
        created: created.length,
        reopened,
        suppressed: suppressed.length,
        notified: alertFingerprints.size,
        high: findings.filter((row) => row.severity === "high").length,
        medium: findings.filter((row) => row.severity === "medium").length,
        low: findings.filter((row) => row.severity === "low").length,
      },
    });
  });

  // Notifications are created outside the transaction: a failed notification must
  // not roll back findings that were already recorded.
  for (const finding of findings) {
    if (!alertFingerprints.has(finding.fingerprint)) continue;
    await createNotification({
      tenantId,
      kind: "system",
      severity: "critical",
      title: finding.title,
      body: finding.summary,
      href: "/admin/anomalies",
      dedupeKey: `anomaly:${tenantId}:${finding.fingerprint}`,
    });
  }

  return {
    scanned: findings.length,
    created: created.length,
    updated: findings.length - created.length,
    reopened,
    suppressed: suppressed.length,
    notified: alertFingerprints.size,
    high: findings.filter((row) => row.severity === "high").length,
    medium: findings.filter((row) => row.severity === "medium").length,
    low: findings.filter((row) => row.severity === "low").length,
    period,
    runId: run.id,
  };
}
