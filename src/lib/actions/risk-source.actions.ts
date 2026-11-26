"use server";

import { db } from "@/lib/db";
import { requireTenantAdminMomo } from "@/lib/tenant";
import {
  RISK_CATEGORY_LABELS,
  type RiskCategory,
  type RiskSeverity,
} from "@/lib/risk-intelligence/policy";

export interface RiskSignalSource {
  sourceType: "dailyAccount" | "anomalyInvestigation" | "reconciliationExceptionCase";
  sourceId: string;
  label: string;
  summary: string;
  category: RiskCategory;
  categoryLabel: string;
  severity: RiskSeverity;
  observedFrom: string;
  observedTo: string;
  alreadyShared: boolean;
}

export interface RiskSourceResponse {
  success: boolean;
  error?: string;
  data?: { sources: RiskSignalSource[]; employeeName: string };
}

function anomalyCategory(ruleKey: string): RiskCategory {
  if (ruleKey === "daily_shortage") return "shortage";
  if (ruleKey === "repeated_shortage" || ruleKey === "repeated_shift_variance") {
    return "repeated_shortage";
  }
  if (ruleKey === "unreviewed_account") return "unreconciled_day";
  if (ruleKey === "missing_account") return "evidence_gap";
  if (ruleKey === "unconfirmed_handover") return "unconfirmed_handover";
  return "policy_breach";
}

function severityValue(value: string | null | undefined): RiskSeverity {
  return value === "high" || value === "low" ? value : "medium";
}

/**
 * Closed records of one employee that can support a live contribution. The
 * list is tenant-scoped and only returns records already linked to that
 * employee, so the contribution form cannot be used to signal somebody else.
 */
export async function listClosedRiskSignalSources(
  userId: string
): Promise<RiskSourceResponse> {
  const ctx = await requireTenantAdminMomo();
  const employee = await db.user.findFirst({
    where: { id: userId, tenantId: ctx.tenantId },
    select: { id: true, fullName: true, phone: true },
  });
  if (!employee) return { success: false, error: "Choose an employee of your business." };
  if (!employee.phone) {
    return {
      success: false,
      error: "Record a phone number for this employee before sharing a signal that must be matched securely.",
    };
  }
  const consent = await db.riskIntelligenceConsent.findFirst({
    where: { tenantId: ctx.tenantId },
    orderBy: { consentedAt: "desc" },
    select: { status: true, scope: true },
  });
  if (!consent || consent.status !== "active" || consent.scope !== "share_signals") {
    return { success: false, error: "Join with signal sharing before contributing a closed-record signal." };
  }
  const [accounts, investigations, cases] = await Promise.all([
    db.dailyAccount.findMany({
      where: {
        tenantId: ctx.tenantId,
        workerId: userId,
        status: "reviewed",
        reviewedAt: { not: null },
      },
      orderBy: { reviewedAt: "desc" },
      take: 25,
      select: {
        id: true,
        businessDate: true,
        reviewedAt: true,
        differenceStatus: true,
        calculatedDifference: true,
      },
    }),
    db.anomalyInvestigation.findMany({
      where: {
        tenantId: ctx.tenantId,
        status: "closed",
        disposition: "genuine",
        closedAt: { not: null },
        anomaly: { workerId: userId },
      },
      orderBy: { closedAt: "desc" },
      take: 25,
      select: {
        id: true,
        closedAt: true,
        anomaly: {
          select: {
            ruleKey: true,
            title: true,
            summary: true,
            severity: true,
            businessDate: true,
            detectedAt: true,
          },
        },
      },
    }),
    db.reconciliationExceptionCase.findMany({
      where: { tenantId: ctx.tenantId, status: "resolved", resolvedAt: { not: null } },
      orderBy: { resolvedAt: "desc" },
      take: 40,
      select: {
        id: true,
        caseNumber: true,
        title: true,
        resolutionType: true,
        resolvedAt: true,
        links: { select: { entityType: true, entityId: true } },
      },
    }),
  ]);
  const linkedAccountIds = Array.from(
    new Set(
      cases
        .flatMap((row) => row.links)
        .filter((link) => link.entityType === "dailyAccount")
        .map((link) => link.entityId)
    )
  );
  const linkedShiftIds = Array.from(
    new Set(
      cases
        .flatMap((row) => row.links)
        .filter((link) => link.entityType === "shift")
        .map((link) => link.entityId)
    )
  );
  const [linkedAccounts, linkedShifts] = await Promise.all([
    linkedAccountIds.length
      ? db.dailyAccount.findMany({
          where: { id: { in: linkedAccountIds }, tenantId: ctx.tenantId },
          select: { id: true, workerId: true },
        })
      : Promise.resolve([]),
    linkedShiftIds.length
      ? db.shift.findMany({
          where: { id: { in: linkedShiftIds }, tenantId: ctx.tenantId },
          select: { id: true, assignedUserId: true },
        })
      : Promise.resolve([]),
  ]);
  const userAccountIds = new Set(
    linkedAccounts.filter((row) => row.workerId === userId).map((row) => row.id)
  );
  const userShiftIds = new Set(
    linkedShifts.filter((row) => row.assignedUserId === userId).map((row) => row.id)
  );
  const relevantCases = cases.filter((row) =>
    row.links.some(
      (link) =>
        (link.entityType === "user" && link.entityId === userId) ||
        (link.entityType === "dailyAccount" && userAccountIds.has(link.entityId)) ||
        (link.entityType === "shift" && userShiftIds.has(link.entityId))
    )
  );
  const sourceKeys = [
    ...accounts.map((row) => ({ sourceType: "dailyAccount", sourceId: row.id })),
    ...investigations.map((row) => ({ sourceType: "anomalyInvestigation", sourceId: row.id })),
    ...relevantCases.map((row) => ({
      sourceType: "reconciliationExceptionCase",
      sourceId: row.id,
    })),
  ];
  const existing = sourceKeys.length
    ? await db.agentRiskSignal.findMany({
        where: {
          tenantId: ctx.tenantId,
          OR: sourceKeys.map((key) => ({ sourceType: key.sourceType, sourceId: key.sourceId })),
        },
        select: { sourceType: true, sourceId: true },
      })
    : [];
  const sharedKeys = new Set(existing.map((row) => row.sourceType + ":" + row.sourceId));
  const sources: RiskSignalSource[] = [
    ...accounts.map((row) => {
      const category: RiskCategory =
        row.differenceStatus === "short" ? "shortage" : "unreconciled_day";
      const magnitude = Math.abs(Number(row.calculatedDifference));
      return {
        sourceType: "dailyAccount" as const,
        sourceId: row.id,
        label: "Daily account · " + row.businessDate.toISOString().slice(0, 10),
        summary:
          "Reviewed " +
          (row.reviewedAt ?? row.businessDate).toISOString().slice(0, 10) +
          " · difference " +
          row.differenceStatus,
        category,
        categoryLabel: RISK_CATEGORY_LABELS[category],
        severity: magnitude >= 100 ? ("high" as const) : ("medium" as const),
        observedFrom: row.businessDate.toISOString(),
        observedTo: row.businessDate.toISOString(),
        alreadyShared: sharedKeys.has("dailyAccount:" + row.id),
      };
    }),
    ...investigations.map((row) => {
      const category = anomalyCategory(row.anomaly.ruleKey);
      const observed = row.anomaly.businessDate ?? row.anomaly.detectedAt;
      return {
        sourceType: "anomalyInvestigation" as const,
        sourceId: row.id,
        label: row.anomaly.title,
        summary: "Investigation closed as genuine · " + row.anomaly.summary.slice(0, 180),
        category,
        categoryLabel: RISK_CATEGORY_LABELS[category],
        severity: severityValue(row.anomaly.severity),
        observedFrom: observed.toISOString(),
        observedTo: observed.toISOString(),
        alreadyShared: sharedKeys.has("anomalyInvestigation:" + row.id),
      };
    }),
    ...relevantCases.map((row) => {
      const category: RiskCategory = "policy_breach";
      return {
        sourceType: "reconciliationExceptionCase" as const,
        sourceId: row.id,
        label: "Reconciliation " + row.caseNumber + " · " + row.title,
        summary: "Resolved as " + (row.resolutionType ?? "recorded resolution"),
        category,
        categoryLabel: RISK_CATEGORY_LABELS[category],
        severity: "medium" as const,
        observedFrom: row.resolvedAt!.toISOString(),
        observedTo: row.resolvedAt!.toISOString(),
        alreadyShared: sharedKeys.has("reconciliationExceptionCase:" + row.id),
      };
    }),
  ].sort((left, right) => right.observedTo.localeCompare(left.observedTo));
  return { success: true, data: { sources, employeeName: employee.fullName } };
}
