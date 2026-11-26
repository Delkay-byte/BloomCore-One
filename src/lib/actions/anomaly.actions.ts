"use server";

import { db } from "@/lib/db";
import { requireTenantAdminMomo } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import {
  ANOMALY_RULE_CATALOG,
  ANOMALY_THRESHOLDS,
  type AnomalySeverity,
  type AnomalyFinding,
} from "@/lib/anomaly-rules";
import {
  collectAnomalyFindings,
  persistAnomalyFindings,
  type ScanSummary,
} from "@/lib/anomaly-scan";

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
 */
export async function runAnomalyScan(input?: {
  from?: string;
  to?: string;
}): Promise<AnomalyActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const period = periodFromInput(input?.from, input?.to);
  const now = new Date();
  const findings = await collectAnomalyFindings(ctx.tenantId, period, now);
  const summary = await persistAnomalyFindings({
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    trigger: "manual",
    period,
    findings,
    now,
  });
  return { success: true, data: summary };
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
