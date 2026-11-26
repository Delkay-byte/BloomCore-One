"use server";

import { db } from "@/lib/db";
import { requireTenantAdminMomo } from "@/lib/tenant";
import {
  getAnomalyScoringProvider,
  type AnomalyTriageBriefing,
  type AnomalyTriageSignal,
  type TriageSeverity,
} from "@/lib/zeli/anomaly-detection";

export interface ZeliAnomalyBriefingResponse {
  success: boolean;
  error?: string;
  data?: AnomalyTriageBriefing;
}

/**
 * Build Zeli's advisory triage briefing from this tenant's active operational
 * findings. Read-only: it never creates, acknowledges or resolves a finding.
 */
export async function getZeliAnomalyBriefing(): Promise<ZeliAnomalyBriefingResponse> {
  const ctx = await requireTenantAdminMomo();

  const rows = await db.operationalAnomaly.findMany({
    where: {
      tenantId: ctx.tenantId,
      status: { in: ["open", "acknowledged"] },
    },
    select: {
      id: true,
      ruleKey: true,
      severity: true,
      status: true,
      workerId: true,
      locationId: true,
      detectedAt: true,
    },
    orderBy: { detectedAt: "desc" },
    take: 500,
  });

  const workerIds = Array.from(
    new Set(rows.map((row) => row.workerId).filter((id): id is string => Boolean(id)))
  );
  const locationIds = Array.from(
    new Set(rows.map((row) => row.locationId).filter((id): id is string => Boolean(id)))
  );

  const [workers, locations] = await Promise.all([
    workerIds.length > 0
      ? db.user.findMany({
          where: { tenantId: ctx.tenantId, id: { in: workerIds } },
          select: { id: true, fullName: true },
        })
      : [],
    locationIds.length > 0
      ? db.location.findMany({
          where: { tenantId: ctx.tenantId, id: { in: locationIds } },
          select: { id: true, name: true },
        })
      : [],
  ]);

  const workerNames = new Map(workers.map((row) => [row.id, row.fullName]));
  const locationNames = new Map(locations.map((row) => [row.id, row.name]));

  const signals: AnomalyTriageSignal[] = rows.map((row) => ({
    id: row.id,
    ruleKey: row.ruleKey,
    severity: row.severity as TriageSeverity,
    status: row.status,
    workerId: row.workerId,
    workerName: row.workerId ? workerNames.get(row.workerId) ?? null : null,
    locationId: row.locationId,
    locationName: row.locationId ? locationNames.get(row.locationId) ?? null : null,
    detectedAt: row.detectedAt.toISOString(),
  }));

  return {
    success: true,
    data: getAnomalyScoringProvider().score(signals),
  };
}
