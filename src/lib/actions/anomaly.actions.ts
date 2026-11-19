"use server";

import { db } from "@/lib/db";
import { requireTenantAdminMomo } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import {
  ANOMALY_RULE_CATALOG,
  ANOMALY_THRESHOLDS,
  evaluateAnomalies,
  type AnomalySeverity,
} from "@/lib/anomaly-rules";

export interface AnomalyActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface AnomalyView {
  id: string;
  fingerprint: string;
  ruleKey: string;
  severity: AnomalySeverity;
  status: string;
  title: string;
  summary: string;
  entityType: string;
  entityId: string;
  locationId: string | null;
  workerId: string | null;
  businessDate: string | null;
  metricValue: number | null;
  thresholdValue: number | null;
  evidence: Record<string, unknown> | null;
  detectedAt: string;
  lastSeenAt: string;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface AnomalyBoard {
  anomalies: AnomalyView[];
  counts: {
    open: number;
    acknowledged: number;
    resolved: number;
    high: number;
    medium: number;
    low: number;
  };
  rules: Array<{ key: string; label: string; description: string }>;
  thresholds: typeof ANOMALY_THRESHOLDS;
  period: { from: string; to: string };
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function safeEvidence(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function periodFromInput(from?: string, to?: string): { from: string; to: string } {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date();
  const end = dateOnly.test(to ?? "")
    ? (to as string)
    : today.toISOString().slice(0, 10);
  const endDate = new Date(`${end}T00:00:00.000Z`);
  const defaultStart = new Date(endDate.getTime() - 29 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const start = dateOnly.test(from ?? "") ? (from as string) : defaultStart;
  if (start > end) return { from: end, to: start };
  const days =
    Math.round(
      (new Date(`${end}T00:00:00Z`).getTime() -
        new Date(`${start}T00:00:00Z`).getTime()) /
        86_400_000
    ) + 1;
  if (days > 90) {
    return {
      from: new Date(endDate.getTime() - 89 * 86_400_000).toISOString().slice(0, 10),
      to: end,
    };
  }
  return { from: start, to: end };
}

/**
 * Run the deterministic rule set for this tenant and persist findings.
 *
 * Re-running is safe: the (tenantId, fingerprint) unique key upserts the same
 * finding instead of duplicating it. Resolved findings stay resolved.
 */
export async function runAnomalyScan(input?: {
  from?: string;
  to?: string;
}): Promise<AnomalyActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const period = periodFromInput(input?.from, input?.to);
  const now = new Date();

  const [locations, accounts, transactions, transfers, handovers] = await Promise.all([
    db.location.findMany({
      where: { tenantId: ctx.tenantId, status: "active" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.dailyAccount.findMany({
      where: {
        tenantId: ctx.tenantId,
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
      },
    }),
    db.momoTransaction.findMany({
      where: {
        tenantId: ctx.tenantId,
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
        tenantId: ctx.tenantId,
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
        tenantId: ctx.tenantId,
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
          where: { tenantId: ctx.tenantId, id: { in: workerIds } },
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

  const existing = await db.operationalAnomaly.findMany({
    where: {
      tenantId: ctx.tenantId,
      fingerprint: { in: findings.map((row) => row.fingerprint) },
    },
    select: { fingerprint: true },
  });
  const existingSet = new Set(existing.map((row) => row.fingerprint));
  const created = findings.filter((row) => !existingSet.has(row.fingerprint)).length;

  await db.$transaction(async (tx) => {
    for (const finding of findings) {
      await tx.operationalAnomaly.upsert({
        where: {
          tenantId_fingerprint: {
            tenantId: ctx.tenantId,
            fingerprint: finding.fingerprint,
          },
        },
        create: {
          tenantId: ctx.tenantId,
          fingerprint: finding.fingerprint,
          ruleKey: finding.ruleKey,
          severity: finding.severity,
          title: finding.title,
          summary: finding.summary,
          entityType: finding.entityType,
          entityId: finding.entityId,
          locationId: finding.locationId,
          workerId: finding.workerId,
          businessDate: finding.businessDate
            ? new Date(`${finding.businessDate}T00:00:00.000Z`)
            : null,
          metricValue: finding.metricValue,
          thresholdValue: finding.thresholdValue,
          evidence: JSON.stringify(finding.evidence),
          detectedAt: now,
          lastSeenAt: now,
        },
        update: {
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
          evidence: JSON.stringify(finding.evidence),
          lastSeenAt: now,
        },
      });
    }
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "anomaly.scan_completed",
      entityType: "tenant",
      entityId: ctx.tenantId,
      details: {
        from: period.from,
        to: period.to,
        scanned: findings.length,
        created,
        updated: findings.length - created,
        high: findings.filter((row) => row.severity === "high").length,
        medium: findings.filter((row) => row.severity === "medium").length,
        low: findings.filter((row) => row.severity === "low").length,
      },
    });
  });

  return {
    success: true,
    data: {
      scanned: findings.length,
      created,
      updated: findings.length - created,
      high: findings.filter((row) => row.severity === "high").length,
      medium: findings.filter((row) => row.severity === "medium").length,
      low: findings.filter((row) => row.severity === "low").length,
      period,
    },
  };
}

export async function getAnomalyBoard(filters?: {
  status?: string;
  severity?: string;
  ruleKey?: string;
}): Promise<AnomalyBoard> {
  const ctx = await requireTenantAdminMomo();

  const where: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (filters?.status && filters.status !== "all") where.status = filters.status;
  if (filters?.severity && filters.severity !== "all") where.severity = filters.severity;
  if (filters?.ruleKey && filters.ruleKey !== "all") where.ruleKey = filters.ruleKey;

  const rows = await db.operationalAnomaly.findMany({
    where,
    orderBy: [{ detectedAt: "desc" }],
    take: 500,
  });
  const statusRank = (status: string) =>
    status === "open" ? 0 : status === "acknowledged" ? 1 : 2;
  const severityRank = (severity: string) =>
    severity === "high" ? 0 : severity === "medium" ? 1 : 2;
  rows.sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      severityRank(a.severity) - severityRank(b.severity) ||
      b.detectedAt.getTime() - a.detectedAt.getTime()
  );

  const actorIds = Array.from(
    new Set(
      rows
        .flatMap((row) => [row.acknowledgedById, row.resolvedById])
        .filter((id): id is string => Boolean(id))
    )
  );
  const actors =
    actorIds.length > 0
      ? await db.user.findMany({
          where: { tenantId: ctx.tenantId, id: { in: actorIds } },
          select: { id: true, fullName: true },
        })
      : [];
  const names = new Map(actors.map((row) => [row.id, row.fullName]));

  const all = await db.operationalAnomaly.findMany({
    where: { tenantId: ctx.tenantId },
    select: { status: true, severity: true },
  });

  return {
    anomalies: rows.map((row) => ({
      id: row.id,
      fingerprint: row.fingerprint,
      ruleKey: row.ruleKey,
      severity: row.severity as AnomalySeverity,
      status: row.status,
      title: row.title,
      summary: row.summary,
      entityType: row.entityType,
      entityId: row.entityId,
      locationId: row.locationId,
      workerId: row.workerId,
      businessDate: iso(row.businessDate),
      metricValue: row.metricValue === null ? null : Number(row.metricValue),
      thresholdValue: row.thresholdValue === null ? null : Number(row.thresholdValue),
      evidence: safeEvidence(row.evidence),
      detectedAt: row.detectedAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      acknowledgedByName: row.acknowledgedById
        ? names.get(row.acknowledgedById) ?? null
        : null,
      acknowledgedAt: iso(row.acknowledgedAt),
      resolvedByName: row.resolvedById ? names.get(row.resolvedById) ?? null : null,
      resolvedAt: iso(row.resolvedAt),
      resolutionNote: row.resolutionNote,
    })),
    counts: {
      open: all.filter((row) => row.status === "open").length,
      acknowledged: all.filter((row) => row.status === "acknowledged").length,
      resolved: all.filter((row) => row.status === "resolved").length,
      high: all.filter((row) => row.severity === "high").length,
      medium: all.filter((row) => row.severity === "medium").length,
      low: all.filter((row) => row.severity === "low").length,
    },
    rules: ANOMALY_RULE_CATALOG.map((row) => ({ ...row })),
    thresholds: ANOMALY_THRESHOLDS,
    period: periodFromInput(),
  };
}

export async function acknowledgeAnomaly(input: {
  id: string;
  note?: string;
}): Promise<AnomalyActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const note = input.note?.trim() ?? "";
  if (note.length > 500) {
    return { success: false, error: "The note is too long." };
  }
  const row = await db.operationalAnomaly.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
  });
  if (!row) return { success: false, error: "Finding not found." };
  if (row.status !== "open") {
    return { success: false, error: "Only an open finding can be acknowledged." };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.operationalAnomaly.updateMany({
        where: { id: row.id, tenantId: ctx.tenantId, status: "open" },
        data: {
          status: "acknowledged",
          acknowledgedById: ctx.userId,
          acknowledgedAt: new Date(),
          resolutionNote: note || null,
        },
      });
      if (updated.count !== 1) throw new Error("ANOMALY_CONFLICT");
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "anomaly.acknowledged",
        entityType: "operationalAnomaly",
        entityId: row.id,
        details: { ruleKey: row.ruleKey, note: note || null },
      });
    });
  } catch {
    return { success: false, error: "The finding could not be acknowledged." };
  }
  return { success: true };
}

export async function resolveAnomaly(input: {
  id: string;
  note: string;
}): Promise<AnomalyActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const note = input.note?.trim() ?? "";
  if (note.length < 5 || note.length > 500) {
    return {
      success: false,
      error: "Record what was checked and why the finding is closed (5–500 characters).",
    };
  }
  const row = await db.operationalAnomaly.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
  });
  if (!row) return { success: false, error: "Finding not found." };
  if (row.status === "resolved") {
    return { success: false, error: "This finding is already resolved." };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.operationalAnomaly.updateMany({
        where: {
          id: row.id,
          tenantId: ctx.tenantId,
          status: { in: ["open", "acknowledged"] },
        },
        data: {
          status: "resolved",
          resolvedById: ctx.userId,
          resolvedAt: new Date(),
          resolutionNote: note,
        },
      });
      if (updated.count !== 1) throw new Error("ANOMALY_CONFLICT");
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "anomaly.resolved",
        entityType: "operationalAnomaly",
        entityId: row.id,
        details: { ruleKey: row.ruleKey, note },
      });
    });
  } catch {
    return { success: false, error: "The finding could not be resolved." };
  }
  return { success: true };
}
