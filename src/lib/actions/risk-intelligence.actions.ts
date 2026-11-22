"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { requireTenantAdminMomo } from "@/lib/tenant";
import { createAuditLog, createAuditLogTx } from "@/lib/audit";
import { RATE_LIMITS } from "@/lib/security/config";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import {
  RISK_INTELLIGENCE_DECAY_DAYS,
  RISK_INTELLIGENCE_POLICY_VERSION,
  RISK_INTELLIGENCE_PROMISES,
  RISK_QUERY_GUIDANCE,
  evaluateRiskQuery,
  validateRiskContribution,
  type RiskConsentState,
  type RiskQueryResult,
} from "@/lib/risk-intelligence/policy";
import { hashRiskSubject, riskIntelligenceConfigured } from "@/lib/risk-intelligence/hasher";

/**
 * Shared agent risk intelligence: the governed operations.
 *
 * Every operation here is a business's own administrative act: joining, leaving,
 * contributing a signal about a closed record of its own, and asking about someone it
 * already employs or is about to. There is no operation to browse people, to search by
 * name across the network, or to mark someone as blocked.
 */

export interface RiskActionResponse<T> {
  success: boolean;
  error?: string;
  data?: T;
}

export interface RiskConsentView {
  active: boolean;
  status: string;
  scope: string;
  policyVersion: string;
  consentedAt: string | null;
  withdrawnAt: string | null;
  withdrawReason: string | null;
  currentPolicyVersion: string;
  configured: boolean;
  promises: readonly string[];
  signalCount: number;
}

async function loadConsent(tenantId: string): Promise<RiskConsentState> {
  const row = await db.riskIntelligenceConsent.findFirst({
    where: { tenantId },
    orderBy: { consentedAt: "desc" },
    select: { status: true, scope: true, policyVersion: true },
  });
  if (!row) return { active: false, scope: null, policyVersion: null };
  return {
    active: row.status === "active",
    scope: row.scope === "query_only" ? "query_only" : "share_signals",
    policyVersion: row.policyVersion,
  };
}

const consentSchema = z.object({
  scope: z.enum(["share_signals", "query_only"]),
  acceptedPolicyVersion: z.string().min(1).max(80),
});

export async function getRiskIntelligenceConsent(): Promise<RiskActionResponse<RiskConsentView>> {
  const ctx = await requireTenantAdminMomo();
  const row = await db.riskIntelligenceConsent.findFirst({
    where: { tenantId: ctx.tenantId },
    orderBy: { consentedAt: "desc" },
  });
  const signalCount = await db.agentRiskSignal.count({
    where: { tenantId: ctx.tenantId, status: "open" },
  });
  return {
    success: true,
    data: {
      active: row?.status === "active",
      status: row?.status ?? "not_joined",
      scope: row?.scope ?? "share_signals",
      policyVersion: row?.policyVersion ?? RISK_INTELLIGENCE_POLICY_VERSION,
      consentedAt: row?.consentedAt.toISOString() ?? null,
      withdrawnAt: row?.withdrawnAt?.toISOString() ?? null,
      withdrawReason: row?.withdrawReason ?? null,
      currentPolicyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
      configured: riskIntelligenceConfigured(),
      promises: RISK_INTELLIGENCE_PROMISES,
      signalCount,
    },
  };
}

/**
 * Join shared risk intelligence. The owner must have read the current policy version;
 * accepting an older one is refused, so nobody joins on stale terms.
 */
export async function joinRiskIntelligence(
  input: unknown
): Promise<RiskActionResponse<{ policyVersion: string }>> {
  const parsed = consentSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request." };
  if (parsed.data.acceptedPolicyVersion !== RISK_INTELLIGENCE_POLICY_VERSION) {
    return {
      success: false,
      error: "The shared risk policy has changed. Read the current version before joining.",
    };
  }
  const ctx = await requireTenantAdminMomo();

  if (!riskIntelligenceConfigured()) {
    return {
      success: false,
      error:
        "Shared risk intelligence is not configured on this deployment, so joining would collect nothing. Joining is disabled until it is.",
    };
  }

  await db.$transaction(async (tx) => {
    const existing = await tx.riskIntelligenceConsent.findFirst({
      where: { tenantId: ctx.tenantId, policyVersion: RISK_INTELLIGENCE_POLICY_VERSION },
    });
    if (existing) {
      await tx.riskIntelligenceConsent.update({
        where: { id: existing.id },
        data: {
          status: "active",
          scope: parsed.data.scope,
          consentedById: ctx.userId,
          consentedAt: new Date(),
          withdrawnAt: null,
          withdrawnById: null,
          withdrawReason: null,
        },
      });
    } else {
      await tx.riskIntelligenceConsent.create({
        data: {
          tenantId: ctx.tenantId,
          policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
          scope: parsed.data.scope,
          consentedById: ctx.userId,
        },
      });
    }
    await createAuditLogTx(tx, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "risk_intelligence.joined",
      entityType: "riskIntelligenceConsent",
      entityId: ctx.tenantId,
      details: { scope: parsed.data.scope, policyVersion: RISK_INTELLIGENCE_POLICY_VERSION, financialMutation: false },
    });
  });

  return { success: true, data: { policyVersion: RISK_INTELLIGENCE_POLICY_VERSION } };
}

/**
 * Leave. Withdrawal takes effect immediately: this business's signals stop being counted
 * for anyone else's query, and it stops receiving answers.
 */
export async function withdrawRiskIntelligence(
  input: unknown
): Promise<RiskActionResponse<{ withdrawn: true }>> {
  const parsed = z.object({ reason: z.string().min(10).max(500) }).safeParse(input);
  if (!parsed.success) return { success: false, error: "Write a short reason for withdrawing." };
  const ctx = await requireTenantAdminMomo();

  await db.$transaction(async (tx) => {
    await tx.riskIntelligenceConsent.updateMany({
      where: { tenantId: ctx.tenantId, status: "active" },
      data: {
        status: "withdrawn",
        withdrawnAt: new Date(),
        withdrawnById: ctx.userId,
        withdrawReason: parsed.data.reason,
      },
    });
    // A withdrawn business stops sharing what it contributed. The rows are kept so the
    // audit trail is intact, but they no longer count towards anyone's cohort.
    await tx.agentRiskSignal.updateMany({
      where: { tenantId: ctx.tenantId, status: "open" },
      data: { status: "withdrawn" },
    });
    await createAuditLogTx(tx, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "risk_intelligence.withdrawn",
      entityType: "riskIntelligenceConsent",
      entityId: ctx.tenantId,
      details: { reason: parsed.data.reason, financialMutation: false },
    });
  });

  return { success: true, data: { withdrawn: true } };
}

const contributeSchema = z.object({
  userId: z.string().min(1).max(64),
  category: z.string().min(1).max(40),
  severity: z.enum(["high", "medium", "low"]),
  sourceType: z.enum(["anomalyInvestigation", "reconciliationExceptionCase", "dailyAccount"]),
  sourceId: z.string().min(1).max(64),
  note: z.string().min(10).max(500),
  observedFrom: z.string().min(10),
  observedTo: z.string().min(10),
});

/**
 * Contribute one signal about one of this business's own closed records.
 *
 * The subject is hashed here and never stored in the clear. The contributing incident is
 * checked to belong to this tenant before anything is written, so a business cannot share
 * a signal built on another business's record.
 */
export async function contributeRiskSignal(
  input: unknown
): Promise<RiskActionResponse<{ signalId: string; expiresAt: string }>> {
  const parsed = contributeSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid signal." };
  const ctx = await requireTenantAdminMomo();

  const consent = await loadConsent(ctx.tenantId);
  const subject = await db.user.findFirst({
    where: { id: parsed.data.userId, tenantId: ctx.tenantId },
    select: { id: true, fullName: true, phone: true },
  });
  // Only somebody this business actually has a record for, and only if they have a
  // phone number, because the shared key needs both parts.
  if (!subject || !subject.phone) {
    return {
      success: false,
      error: "Shared signals require an employee of your business with a recorded name and phone number.",
    };
  }

  const alreadyContributed = Boolean(
    await db.agentRiskSignal.findFirst({
      where: {
        tenantId: ctx.tenantId,
        sourceType: parsed.data.sourceType,
        sourceId: parsed.data.sourceId,
      },
      select: { id: true },
    })
  );

  const validation = validateRiskContribution({
    consent,
    category: parsed.data.category,
    severity: parsed.data.severity,
    sourceType: parsed.data.sourceType,
    sourceId: parsed.data.sourceId,
    reasonLength: parsed.data.note.trim().length,
    alreadyContributed,
  });
  if (!validation.ok) return { success: false, error: validation.error };

  // The source record must belong to this business.
  const ownsSource =
    parsed.data.sourceType === "anomalyInvestigation"
      ? Boolean(
          await db.anomalyInvestigation.findFirst({
            where: { id: parsed.data.sourceId, tenantId: ctx.tenantId },
            select: { id: true },
          })
        )
      : parsed.data.sourceType === "reconciliationExceptionCase"
        ? Boolean(
            await db.reconciliationExceptionCase.findFirst({
              where: { id: parsed.data.sourceId, tenantId: ctx.tenantId },
              select: { id: true },
            })
          )
        : Boolean(
            await db.dailyAccount.findFirst({
              where: { id: parsed.data.sourceId, tenantId: ctx.tenantId },
              select: { id: true },
            })
          );
  if (!ownsSource) {
    return { success: false, error: "That record is not one of your business's records." };
  }

  const observedFrom = new Date(parsed.data.observedFrom);
  const observedTo = new Date(parsed.data.observedTo);
  if (Number.isNaN(observedFrom.getTime()) || Number.isNaN(observedTo.getTime()) || observedTo < observedFrom) {
    return { success: false, error: "Check the dates this signal covers." };
  }

  const expiresAt = new Date(observedTo);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + RISK_INTELLIGENCE_DECAY_DAYS);

  const hashed = hashRiskSubject(subject.fullName, subject.phone);

  const created = await db.$transaction(async (tx) => {
    const row = await tx.agentRiskSignal.create({
      data: {
        tenantId: ctx.tenantId,
        subjectKey: hashed.subjectKey,
        keyBasis: hashed.keyBasis,
        saltVersion: hashed.saltVersion,
        category: validation.category,
        severity: validation.severity,
        sourceType: parsed.data.sourceType,
        sourceId: parsed.data.sourceId,
        internalNote: parsed.data.note,
        observedFrom,
        observedTo,
        expiresAt,
      },
      select: { id: true },
    });
    await createAuditLogTx(tx, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "risk_intelligence.signal_shared",
      entityType: "agentRiskSignal",
      entityId: row.id,
      details: {
        category: validation.category,
        severity: validation.severity,
        sourceType: parsed.data.sourceType,
        sourceId: parsed.data.sourceId,
        expiresAt: expiresAt.toISOString(),
        financialMutation: false,
      },
    });
    return row;
  });

  return { success: true, data: { signalId: created.id, expiresAt: expiresAt.toISOString() } };
}

const querySchema = z.object({
  userId: z.string().min(1).max(64),
  reason: z.string().min(10).max(500),
});

/**
 * Ask whether other participating businesses have reported signals about someone this
 * business already has a record for.
 *
 * The disclosure row is written inside the same transaction as the read, so a business
 * cannot receive a shared answer without a record of having asked.
 */
export async function querySharedRiskSignals(
  input: unknown
): Promise<RiskActionResponse<{ result: RiskQueryResult; subjectLabel: string }>> {
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: RISK_QUERY_GUIDANCE.reason_required };
  }
  const ctx = await requireTenantAdminMomo();

  const limited = await consumeRateLimit("risk-query", ctx.tenantId, RATE_LIMITS.publicExpensive);
  if (!limited.allowed) {
    return { success: false, error: "Too many shared risk queries. Try again in a minute." };
  }

  const subject = await db.user.findFirst({
    where: { id: parsed.data.userId, tenantId: ctx.tenantId },
    select: { id: true, fullName: true, phone: true },
  });
  if (!subject) return { success: false, error: "Employee not found." };

  const consent = await loadConsent(ctx.tenantId);

  let signals: { category: string; severity: string; tenantId: string | null; observedTo: Date; expiresAt: Date }[] = [];
  let subjectKey: string | null = null;
  if (consent.active && consent.policyVersion === RISK_INTELLIGENCE_POLICY_VERSION && subject.phone) {
    try {
      subjectKey = hashRiskSubject(subject.fullName, subject.phone).subjectKey;
    } catch {
      subjectKey = null;
    }
    if (subjectKey) {
      signals = await db.agentRiskSignal.findMany({
        where: { subjectKey, status: "open" },
        select: {
          category: true,
          severity: true,
          tenantId: true,
          observedTo: true,
          expiresAt: true,
        },
        take: 120,
      });
    }
  }

  const evaluation = evaluateRiskQuery({
    consent,
    tenantAvailable: true,
    role: ctx.role,
    subjectKnownToCaller: Boolean(subject),
    reason: parsed.data.reason,
    callerTenantId: ctx.tenantId,
    signals: signals.map((signal) => ({
      category: signal.category,
      severity: signal.severity,
      tenantId: signal.tenantId ?? "",
      observedAt: signal.observedTo.toISOString(),
      expiresAt: signal.expiresAt.toISOString(),
    })),
    asOf: new Date().toISOString(),
  });

  if (evaluation.allowed && subjectKey) {
    await db.$transaction(async (tx) => {
      await tx.riskIntelligenceDisclosure.create({
        data: {
          tenantId: ctx.tenantId,
          subjectKey,
          // Categories and bands only. The contributing businesses are not recorded here
          // either, so a leaked disclosure log cannot identify them.
          disclosed: JSON.stringify({
            verdict: evaluation.verdict,
            categories: evaluation.signals.map((row) => row.category),
            band: evaluation.signals.map((row) => row.contributorBand),
          }),
          contributorCount: evaluation.contributorCount,
          viewerId: ctx.userId,
          reason: parsed.data.reason,
        },
      });
      await createAuditLogTx(tx, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: "risk_intelligence.signals_viewed",
        entityType: "agentRiskSignal",
        entityId: subject.id,
        details: {
          verdict: evaluation.verdict,
          contributorCount: evaluation.contributorCount,
          sharedCategories: evaluation.signals.map((row) => row.category),
          financialMutation: false,
        },
      });
    });
  }

  return {
    success: true,
    data: { result: evaluation, subjectLabel: subject.fullName.split(" ")[0] ?? "this person" },
  };
}

/** This business's own contributions, so it can see and withdraw what it shared. */
export async function listMyRiskSignals(): Promise<
  RiskActionResponse<{ signals: { id: string; category: string; severity: string; status: string; expiresAt: string; sourceType: string }[] }>
> {
  const ctx = await requireTenantAdminMomo();
  const rows = await db.agentRiskSignal.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, category: true, severity: true, status: true, expiresAt: true, sourceType: true },
  });
  return {
    success: true,
    data: {
      signals: rows.map((row) => ({
        id: row.id,
        category: row.category,
        severity: row.severity,
        status: row.status,
        expiresAt: row.expiresAt.toISOString(),
        sourceType: row.sourceType,
      })),
    },
  };
}

/** Withdraw one contributed signal without leaving the programme. */
export async function withdrawMyRiskSignal(
  input: unknown
): Promise<RiskActionResponse<{ withdrawn: true }>> {
  const parsed = z.object({ id: z.string().min(1).max(64), reason: z.string().min(10).max(500) }).safeParse(input);
  if (!parsed.success) return { success: false, error: "Write a short reason for withdrawing this signal." };
  const ctx = await requireTenantAdminMomo();

  const existing = await db.agentRiskSignal.findFirst({
    where: { id: parsed.data.id, tenantId: ctx.tenantId },
    select: { id: true },
  });
  if (!existing) return { success: false, error: "Signal not found." };

  await db.$transaction(async (tx) => {
    await tx.agentRiskSignal.update({
      where: { id: existing.id },
      data: { status: "withdrawn" },
    });
    await createAuditLogTx(tx, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "risk_intelligence.signal_withdrawn",
      entityType: "agentRiskSignal",
      entityId: existing.id,
      details: { reason: parsed.data.reason, financialMutation: false },
    });
  });

  return { success: true, data: { withdrawn: true } };
}

/** Expire old signals. Called by the daily scan; never deletes a row. */
export async function expireStaleRiskSignals(): Promise<{ expired: number }> {
  const now = new Date();
  const result = await db.agentRiskSignal.updateMany({
    where: { status: "open", expiresAt: { lte: now } },
    data: { status: "expired" },
  });
  if (result.count > 0) {
    await createAuditLog({ userId: "system:risk_intelligence", action: "risk_intelligence.signals_expired", entityType: "agentRiskSignal", details: { expired: result.count, financialMutation: false } });
  }
  return { expired: result.count };
}
