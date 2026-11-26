"use server";

/**
 * Shared Risk Intelligence governance operations.
 *
 * Every permission check is server-side. Privacy operations require either an
 * explicit, revocable Privacy Access grant or an authenticated platform
 * administrator; an ordinary business administrator or support user cannot read
 * cross-business records or override a subject freeze. No DPO appointment is
 * required or assumed.
 */

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getAdminSession, getMomoSession, getSusuSession, verifyPassword } from "@/lib/auth";
import { requireTenantAdminMomo } from "@/lib/tenant";
import { createAuditLog, createAuditLogTx } from "@/lib/audit";
import { RISK_INTELLIGENCE_POLICY_VERSION } from "@/lib/risk-intelligence/policy";
import { candidateSubjectKeys } from "@/lib/risk-intelligence/hasher";
import { verifyRiskRetentionToken } from "@/lib/security/risk-retention-token";
import {
  acquireJobLease,
  assertJobLease,
  LeaseLostError,
  releaseJobLease,
  RETENTION_LEASE_KEY,
  type JobLease,
} from "@/lib/security/job-lease";
import {
  legalHoldDeadline,
  legalHoldReviewDue,
  riskAuditDeletionDeadline,
  signalDeletionDeadline,
} from "@/lib/risk-intelligence/retention";
import {
  SUBJECT_RIGHT_TYPES,
  applyRightsExtension,
  computeRightsDeadlines,
  isOverdue,
  requiresFreeze,
} from "@/lib/risk-intelligence/subject-rights";
import {
  ACCEPTED_NOTICE_DELIVERY_METHODS,
  NOTICE_ACKNOWLEDGEMENT_IS_NOT_CONSENT,
} from "@/lib/risk-intelligence/notices";
import {
  AGREEMENT_CATALOGUE,
  approvedAgreementHash,
  canTransitionAgreement,
  type AgreementState,
} from "@/lib/risk-intelligence/agreements";
import { getRiskSecretProvider } from "@/lib/risk-intelligence/secret-provider";
import { sendRiskNotification } from "@/lib/risk-intelligence/notifications";
import {
  LEGAL_INSTRUMENT_SOURCE,
  LEGAL_INSTRUMENT_VERSION,
  bloomCoreLegalProfile,
  employeeNoticeTemplate,
  instrumentSha256,
  renderLegalInstrument,
  type LegalInstrumentType,
} from "@/lib/risk-intelligence/legal-instruments";
import { resolveEffectiveNotice } from "@/lib/risk-intelligence/notice-resolution";
import { getRiskOrganisationConfig } from "@/lib/risk-intelligence/organisation-profile";
import {
  businessProfileCompleteness,
  getBusinessLegalProfile,
  getSignatoryProfile,
  type DpcRegistrationState,
} from "@/lib/risk-intelligence/business-profile";

export interface GovernanceResponse<T = undefined> {
  success: boolean;
  error?: string;
  /** True when a database-backed execution lease is held by another run. */
  conflict?: boolean;
  data?: T;
}


type PrivacyActor = {
  userId: string;
  role: string;
  tenantId: string | null;
  viaPlatform: boolean;
};

function isPrivacyAdministrator(role: string): boolean {
  // The retired "dpo" alias grants no authority. Historical audit rows keep
  // their original label but cannot authorise a current privacy operation.
  return role === "privacy_admin";
}

async function requirePrivacyActor(): Promise<PrivacyActor | null> {
  try {
    const session = await getAdminSession();
    if (session?.userId) {
      const grant = await db.riskPrivacyAccess.findFirst({
        where: { userId: session.userId, active: true },
        select: { role: true },
      });
      if (grant) {
        return {
          userId: session.userId,
          role: grant.role,
          tenantId: session.tenantId ?? null,
          viaPlatform: false,
        };
      }
    }
  } catch {
    // Fall through to the platform session check.
  }
  try {
    const { getPlatformAdminOrNull } = await import("@/lib/platform-auth");
    const platform = await getPlatformAdminOrNull();
    if (!platform || platform.forcePasswordReset) return null;
    return {
      userId: `platform:${platform.adminId}`,
      role: "privacy_admin",
      tenantId: null,
      viaPlatform: true,
    };
  } catch {
    return null;
  }
}

const GLOBAL_PRIVACY_ERROR =
  "Only a platform administrator can perform this global privacy action.";
const TENANT_SCOPE_ERROR =
  "This privacy action is outside the administrator's business scope.";

/** Platform owners are global; delegated tenant privacy leads are single-tenant. */
function canAccessTenant(actor: PrivacyActor, tenantId: string | null | undefined): boolean {
  if (actor.viaPlatform) return true;
  return Boolean(tenantId && actor.tenantId && actor.tenantId === tenantId);
}

async function controlEvent(params: {
  level: "global" | "business" | "signal" | "subject";
  action: string;
  scopeId?: string;
  tenantId?: string;
  actorId: string;
  reason: string;
  outcome: string;
  history?: Record<string, unknown>;
}): Promise<void> {
  await db.riskControlEvent.create({
    data: {
      level: params.level,
      action: params.action,
      scopeId: params.scopeId ?? null,
      tenantId: params.tenantId ?? null,
      actorId: params.actorId,
      reason: params.reason,
      outcome: params.outcome,
      history: params.history ? JSON.stringify(params.history) : null,
    },
  });
  await createAuditLog({
    userId: params.actorId,
    tenantId: params.tenantId ?? null,
    action: `risk_control.${params.action}`,
    entityType: "riskControlEvent",
    entityId: params.scopeId,
    details: {
      level: params.level,
      outcome: params.outcome,
      financialMutation: false,
    },
  });
}

/** Notify the authorised contacts at each contributing business for a subject. */
async function notifyContributingBusinesses(
  subjectKeys: string[],
  eventType:
    | "signal_disputed"
    | "signal_challenged"
    | "signal_withdrawn"
    | "signal_review_required",
  reference: string,
  actorId: string
): Promise<void> {
  if (subjectKeys.length === 0) return;
  const rows = await db.agentRiskSignal.findMany({
    where: { subjectKey: { in: subjectKeys } },
    select: { tenantId: true },
  });
  const tenantIds = [...new Set(rows.map((row) => row.tenantId).filter((id): id is string => Boolean(id)))];
  for (const tenantId of tenantIds) {
    const contacts = await db.user.findMany({
      where: { tenantId, role: "admin", status: "active" },
      select: { id: true },
      take: 2,
    });
    for (const contact of contacts) {
      await sendRiskNotification({
        eventType,
        scopeType: "signal",
        scopeId: reference,
        tenantId,
        recipientUserId: contact.id,
        reference,
        actorId,
      });
    }
  }
}

/** Metadata-only audit of secret use, wired to the application audit system. */
export async function enableSecretAccessAuditing(): Promise<GovernanceResponse> {
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  if (!actor.viaPlatform) return { success: false, error: GLOBAL_PRIVACY_ERROR };
  const { setRiskSecretAccessSink } = await import("@/lib/risk-intelligence/secret-provider");
  setRiskSecretAccessSink((metadata) => {
    // No key, salt, input or output value is ever written. The sink is global,
    // so attribution is to the provider access itself, not to the administrator
    // who enabled auditing.
    void createAuditLog({
      userId: "system:risk_secret_access",
      action: "risk_intelligence.secret_access",
      entityType: "riskKeyVersion",
      entityId: String(metadata.version),
      details: {
        version: metadata.version,
        providerId: metadata.providerId,
        operation: metadata.operation,
        outcome: metadata.outcome,
        at: metadata.at,
        financialMutation: false,
      },
    });
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// ENG-07 — emergency disablement
// ---------------------------------------------------------------------------

export async function setGlobalRiskControl(
  input: unknown
): Promise<GovernanceResponse<{ enabled: boolean }>> {
  const parsed = z
    .object({ enabled: z.boolean(), reason: z.string().min(10).max(500) })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "A reasoned decision is required." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  if (!actor.viaPlatform) return { success: false, error: GLOBAL_PRIVACY_ERROR };

  await db.$transaction(async (tx) => {
    await tx.riskGlobalControl.upsert({
      where: { id: "global" },
      update: {
        enabled: parsed.data.enabled,
        reason: parsed.data.reason,
        changedById: actor.userId,
      },
      create: {
        id: "global",
        enabled: parsed.data.enabled,
        reason: parsed.data.reason,
        changedById: actor.userId,
      },
    });
    await tx.riskControlEvent.create({
      data: {
        level: "global",
        action: parsed.data.enabled ? "global_enabled" : "global_disabled",
        actorId: actor.userId,
        reason: parsed.data.reason,
        outcome: parsed.data.enabled ? "enabled" : "disabled",
      },
    });
  });
  return { success: true, data: { enabled: parsed.data.enabled } };
}

const businessControlSchema = z.object({
  tenantId: z.string().min(1),
  reason: z.string().min(10).max(500),
});

export async function suspendBusinessParticipation(
  input: unknown
): Promise<GovernanceResponse> {
  const parsed = businessControlSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "A reasoned suspension is required." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  if (!actor.viaPlatform) return { success: false, error: GLOBAL_PRIVACY_ERROR };

  const updated = await db.riskIntelligenceConsent.updateMany({
    where: { tenantId: parsed.data.tenantId, status: "active" },
    data: {
      suspendedAt: new Date(),
      suspensionReason: parsed.data.reason,
      suspendedById: actor.userId,
    },
  });
  await controlEvent({
    level: "business",
    action: "business_suspended",
    scopeId: parsed.data.tenantId,
    tenantId: parsed.data.tenantId,
    actorId: actor.userId,
    reason: parsed.data.reason,
    outcome: updated.count ? "suspended" : "no_active_consent",
  });
  return { success: true };
}

export async function reinstateBusinessParticipation(
  input: unknown
): Promise<GovernanceResponse> {
  const parsed = businessControlSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "A reasoned reinstatement is required." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  if (!actor.viaPlatform) return { success: false, error: GLOBAL_PRIVACY_ERROR };

  await db.riskIntelligenceConsent.updateMany({
    where: { tenantId: parsed.data.tenantId, status: "active" },
    data: { suspendedAt: null, suspensionReason: null, suspendedById: null },
  });
  await controlEvent({
    level: "business",
    action: "business_reinstated",
    scopeId: parsed.data.tenantId,
    tenantId: parsed.data.tenantId,
    actorId: actor.userId,
    reason: parsed.data.reason,
    outcome: "reinstated",
  });
  return { success: true };
}

/**
 * ENG-07: proven bad-faith reporting. A privacy administrator records the evidence, freezes
 * the specific signal, and suspends the contributing business pending review.
 * It never freezes the subject: one fabricated report must not harm the person.
 */
export async function escalateBadFaithReport(input: unknown): Promise<GovernanceResponse> {
  const parsed = z
    .object({
      signalId: z.string().min(1),
      reason: z.string().min(30).max(1000),
      evidenceReference: z.string().min(5).max(300),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "A reasoned escalation with evidence is required." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  if (!actor.viaPlatform) return { success: false, error: GLOBAL_PRIVACY_ERROR };
  const signal = await db.agentRiskSignal.findUnique({ where: { id: parsed.data.signalId } });
  if (!signal) return { success: false, error: "Signal not found." };
  if (signal.status !== "open" && signal.status !== "frozen") {
    return { success: false, error: "Only an open or frozen signal can be escalated." };
  }
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.agentRiskSignal.update({
      where: { id: signal.id },
      data: { status: "withdrawn", withdrawnAt: now, frozenAt: now },
    });
    if (signal.tenantId) {
      await tx.riskIntelligenceConsent.updateMany({
        where: { tenantId: signal.tenantId, status: "active" },
        data: {
          suspendedAt: now,
          suspensionReason: "Bad-faith reporting escalation: " + parsed.data.reason,
          suspendedById: actor.userId,
        },
      });
    }
    await tx.riskControlEvent.create({
      data: {
        level: "business",
        action: "bad_faith_report_escalated",
        scopeId: signal.tenantId ?? signal.id,
        tenantId: signal.tenantId,
        actorId: actor.userId,
        reason: parsed.data.reason,
        outcome: "signal_withdrawn_and_business_suspended",
        history: JSON.stringify({ evidenceReference: parsed.data.evidenceReference }),
      },
    });
  });
  await createAuditLog({
    tenantId: signal.tenantId,
    userId: actor.userId,
    action: "risk_intelligence.bad_faith_escalated",
    entityType: "agentRiskSignal",
    entityId: signal.id,
    details: {
      evidenceReference: parsed.data.evidenceReference,
      financialMutation: false,
    },
  });
  return { success: true };
}

/** ENG-07: expulsion for a proven bad-faith pattern. Privacy-admin only and reversible. */
export async function expelBusinessFromSharedRegister(
  input: unknown
): Promise<GovernanceResponse> {
  const parsed = z
    .object({
      tenantId: z.string().min(1),
      reason: z.string().min(30).max(1000),
      evidenceReference: z.string().min(5).max(300),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "A reasoned expulsion with evidence is required." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  if (!actor.viaPlatform) return { success: false, error: GLOBAL_PRIVACY_ERROR };
  const now = new Date();
  const updated = await db.$transaction(async (tx) => {
    const result = await tx.riskIntelligenceConsent.updateMany({
      where: { tenantId: parsed.data.tenantId, status: "active" },
      data: {
        expelledAt: now,
        expulsionReason: parsed.data.reason,
        suspendedAt: now,
        suspensionReason: "Expelled from the shared register: " + parsed.data.reason,
        suspendedById: actor.userId,
      },
    });
    await tx.agentRiskSignal.updateMany({
      where: { tenantId: parsed.data.tenantId, status: { in: ["open", "frozen", "disputed_frozen"] } },
      data: { status: "withdrawn", withdrawnAt: now },
    });
    await tx.riskControlEvent.create({
      data: {
        level: "business",
        action: "business_expelled",
        scopeId: parsed.data.tenantId,
        tenantId: parsed.data.tenantId,
        actorId: actor.userId,
        reason: parsed.data.reason,
        outcome: result.count ? "expelled" : "no_active_consent",
        history: JSON.stringify({ evidenceReference: parsed.data.evidenceReference }),
      },
    });
    return result;
  });
  await createAuditLog({
    tenantId: parsed.data.tenantId,
    userId: actor.userId,
    action: "risk_intelligence.business_expelled",
    entityType: "businessTenant",
    entityId: parsed.data.tenantId,
    details: { evidenceReference: parsed.data.evidenceReference, financialMutation: false },
  });
  return updated.count
    ? { success: true }
    : { success: false, error: "No active participation consent was found for this business." };
}

export async function reinstateExpelledBusiness(input: unknown): Promise<GovernanceResponse> {
  const parsed = businessControlSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "A reasoned reinstatement is required." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  if (!actor.viaPlatform) return { success: false, error: GLOBAL_PRIVACY_ERROR };
  const updated = await db.riskIntelligenceConsent.updateMany({
    where: { tenantId: parsed.data.tenantId, expelledAt: { not: null } },
    data: { expelledAt: null, expulsionReason: null },
  });
  if (updated.count === 0) return { success: false, error: "No expelled business was found." };
  await controlEvent({
    level: "business",
    action: "business_expulsion_lifted",
    scopeId: parsed.data.tenantId,
    tenantId: parsed.data.tenantId,
    actorId: actor.userId,
    reason: parsed.data.reason,
    outcome: "expulsion_lifted",
  });
  return { success: true };
}
// ---------------------------------------------------------------------------
// ENG-02 — disputed and frozen subjects
// ---------------------------------------------------------------------------

async function freezeMatching(
  subjectKeys: string[],
  reason: string,
  actorId: string,
  caseRef: string | null,
  notifiedTenantId: string | null
): Promise<void> {
  await db.$transaction(async (tx) => {
    for (const subjectKey of subjectKeys) {
      await tx.riskSubjectFreeze.create({
        data: {
          subjectKey,
          reason,
          caseRef,
          frozenById: actorId,
          notifiedTenantId,
        },
      });
      // Freeze every version's source signals, not just the active key's rows.
      await tx.agentRiskSignal.updateMany({
        where: { subjectKey, status: "open" },
        data: { status: "disputed_frozen", frozenAt: new Date(), disputedAt: new Date() },
      });
    }
    await tx.riskControlEvent.create({
      data: {
        level: "subject",
        action: "subject_frozen",
        scopeId: subjectKeys.join(","),
        tenantId: notifiedTenantId,
        actorId,
        reason,
        outcome: "frozen",
        history: JSON.stringify({ caseRef, keyCount: subjectKeys.length }),
      },
    });
  });
}

export async function freezeRiskSubject(input: unknown): Promise<GovernanceResponse> {
  const parsed = z
    .object({
      fullName: z.string().min(3),
      phone: z.string().min(9),
      reason: z.string().min(10).max(500),
      caseRef: z.string().max(40).nullable().optional(),
      tenantId: z.string().nullable().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid freeze request." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  if (!actor.viaPlatform) return { success: false, error: GLOBAL_PRIVACY_ERROR };
  const keys = candidateSubjectKeys(parsed.data.fullName, parsed.data.phone).map(
    (candidate) => candidate.subjectKey
  );
  if (keys.length === 0) {
    return { success: false, error: "No supported key is available; the subject cannot be frozen." };
  }
  await freezeMatching(
    keys,
    parsed.data.reason,
    actor.userId,
    parsed.data.caseRef ?? null,
    parsed.data.tenantId ?? null
  );
  await notifyContributingBusinesses(
    keys,
    "signal_disputed",
    parsed.data.caseRef ?? keys[0],
    actor.userId
  );
  return { success: true };
}

export async function resolveRiskSubjectFreeze(input: unknown): Promise<GovernanceResponse> {
  const parsed = z
    .object({
      freezeId: z.string().min(1),
      decision: z.enum(["upheld", "rejected", "restored"]),
      reason: z.string().min(10).max(1000),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "A reasoned decision is required." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  if (!actor.viaPlatform) return { success: false, error: GLOBAL_PRIVACY_ERROR };

  const freeze = await db.riskSubjectFreeze.findUnique({ where: { id: parsed.data.freezeId } });
  if (!freeze || freeze.status !== "frozen") {
    return { success: false, error: "No open freeze was found for that reference." };
  }
  // One case can freeze several HMAC key versions. Resolve them together so no
  // older key's signals stay silently frozen after a decision.
  const related = await db.riskSubjectFreeze.findMany({
    where: {
      status: "frozen",
      ...(freeze.caseRef
        ? { caseRef: freeze.caseRef }
        : { subjectKey: freeze.subjectKey }),
    },
    select: { id: true, subjectKey: true },
  });
  const keys = related.map((row) => row.subjectKey);

  await db.$transaction(async (tx) => {
    if (parsed.data.decision === "upheld") {
      // Withdraw affected signals and start the 90-day post-resolution purge.
      await tx.agentRiskSignal.updateMany({
        where: { subjectKey: { in: keys }, status: "disputed_frozen" },
        data: {
          status: "withdrawn",
          withdrawnAt: new Date(),
          resolvedAt: new Date(),
        },
      });
    } else if (parsed.data.decision === "rejected") {
      // Restore eligibility only after a documented decision; original expiry stands.
      await tx.agentRiskSignal.updateMany({
        where: { subjectKey: { in: keys }, status: "disputed_frozen" },
        data: { status: "open", frozenAt: null, disputedAt: null, resolvedAt: new Date() },
      });
    }
    await tx.riskSubjectFreeze.updateMany({
      where: { id: { in: related.map((row) => row.id) } },
      data: {
        status: parsed.data.decision === "upheld" ? "upheld" : "restored",
        resolution: parsed.data.decision,
        resolutionById: actor.userId,
        resolvedAt: new Date(),
      },
    });
    await tx.riskControlEvent.create({
      data: {
        level: "subject",
        action: `freeze_${parsed.data.decision}`,
        scopeId: freeze.subjectKey,
        tenantId: freeze.notifiedTenantId,
        actorId: actor.userId,
        reason: parsed.data.reason,
        outcome: parsed.data.decision,
      },
    });
  });
  await notifyContributingBusinesses(
    keys,
    "signal_review_required",
    freeze.caseRef ?? freeze.id,
    actor.userId
  );
  return { success: true };
}

export async function freezeRiskSignal(input: unknown): Promise<GovernanceResponse> {
  const parsed = z
    .object({
      signalId: z.string().min(1),
      reason: z.string().min(10).max(500),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "A reasoned freeze is required." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  const signal = await db.agentRiskSignal.findUnique({ where: { id: parsed.data.signalId } });
  if (!signal) return { success: false, error: "Signal not found." };
  if (!canAccessTenant(actor, signal.tenantId)) {
    return { success: false, error: "Signal not found." };
  }
  await db.$transaction(async (tx) => {
    await tx.agentRiskSignal.update({
      where: { id: signal.id },
      data: { status: "frozen", frozenAt: new Date() },
    });
    await tx.riskControlEvent.create({
      data: {
        level: "signal",
        action: "signal_frozen",
        scopeId: signal.id,
        tenantId: signal.tenantId,
        actorId: actor.userId,
        reason: parsed.data.reason,
        outcome: "frozen",
      },
    });
  });
  await notifyContributingBusinesses(
    [signal.subjectKey],
    "signal_disputed",
    signal.id,
    actor.userId
  );
  return { success: true };
}

export async function releaseRiskSignalFreeze(input: unknown): Promise<GovernanceResponse> {
  const parsed = z
    .object({ signalId: z.string().min(1), reason: z.string().min(10).max(500) })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "A reasoned release is required." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  const signal = await db.agentRiskSignal.findUnique({ where: { id: parsed.data.signalId } });
  if (!signal || signal.status !== "frozen") {
    return { success: false, error: "No frozen signal was found." };
  }
  if (!canAccessTenant(actor, signal.tenantId)) {
    return { success: false, error: "No frozen signal was found." };
  }
  await db.$transaction(async (tx) => {
    await tx.agentRiskSignal.update({
      where: { id: signal.id },
      data: { status: "open", frozenAt: null },
    });
    await tx.riskControlEvent.create({
      data: {
        level: "signal",
        action: "signal_released",
        scopeId: signal.id,
        tenantId: signal.tenantId,
        actorId: actor.userId,
        reason: parsed.data.reason,
        outcome: "released",
      },
    });
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// ENG-04 — scoped legal holds
// ---------------------------------------------------------------------------

const holdSchema = z.object({
  scopeType: z.enum(["signal", "subject", "request"]),
  scopeId: z.string().min(1),
  tenantId: z.string().nullable().optional(),
  reference: z.string().min(3).optional(),
  /** Legacy field name accepted for existing callers. */
  dpoReference: z.string().min(3).optional(),
  reason: z.string().min(10).max(1000),
  caseClosureDate: z.string().datetime().nullable().optional(),
}).refine((value) => Boolean(value.reference || value.dpoReference), {
  message: "A hold reference is required.",
});

export async function placeLegalHold(input: unknown): Promise<GovernanceResponse<{ id: string }>> {
  const parsed = holdSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid legal hold request." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  let holdTenantId = parsed.data.tenantId ?? null;
  if (parsed.data.scopeType === "signal") {
    const signal = await db.agentRiskSignal.findUnique({
      where: { id: parsed.data.scopeId },
      select: { tenantId: true },
    });
    if (!signal) return { success: false, error: "The identified record does not exist." };
    holdTenantId = holdTenantId ?? signal.tenantId;
  } else if (parsed.data.scopeType === "subject") {
    const freeze = await db.riskSubjectFreeze.findFirst({
      where: { subjectKey: parsed.data.scopeId },
      select: { notifiedTenantId: true },
    });
    if (!freeze) return { success: false, error: "The identified record does not exist." };
    holdTenantId = holdTenantId ?? freeze.notifiedTenantId;
  } else {
    const request = await db.subjectRightsRequest.findUnique({
      where: { caseRef: parsed.data.scopeId },
      select: { tenantId: true },
    });
    if (!request) return { success: false, error: "The identified record does not exist." };
    holdTenantId = holdTenantId ?? request.tenantId;
  }
  if (!holdTenantId || !canAccessTenant(actor, holdTenantId)) {
    return { success: false, error: TENANT_SCOPE_ERROR };
  }
  if (parsed.data.tenantId && parsed.data.tenantId !== holdTenantId) {
    return { success: false, error: "The hold scope does not belong to the stated business." };
  }
  const now = new Date();
  const reviewDate = new Date(now.getTime() + 14 * 86_400_000);
  const hold = await db.riskLegalHold.create({
    data: {
      scopeType: parsed.data.scopeType,
      scopeId: parsed.data.scopeId,
      tenantId: holdTenantId,
      dpoReference: parsed.data.reference ?? parsed.data.dpoReference ?? "",
      reason: parsed.data.reason,
      authorisedById: actor.userId,
      reviewDate,
      caseClosureDate: parsed.data.caseClosureDate
        ? new Date(parsed.data.caseClosureDate)
        : null,
    },
    select: { id: true },
  });
  await controlEvent({
    level: "subject",
    action: "legal_hold_placed",
    scopeId: parsed.data.scopeId,
    tenantId: holdTenantId,
    actorId: actor.userId,
    reason: parsed.data.reason,
    outcome: "held",
    history: { reference: parsed.data.reference ?? parsed.data.dpoReference, reviewDate: reviewDate.toISOString() },
  });
  return { success: true, data: { id: hold.id } };
}

export async function extendLegalHold(input: unknown): Promise<GovernanceResponse> {
  const parsed = z
    .object({ holdId: z.string().min(1), extensionUntil: z.string().datetime(), reason: z.string().min(10) })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "An authorised extension requires a reason." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  const hold = await db.riskLegalHold.findUnique({
    where: { id: parsed.data.holdId },
    select: { tenantId: true },
  });
  if (!hold || !canAccessTenant(actor, hold.tenantId)) {
    return { success: false, error: "Legal hold not found." };
  }
  await db.riskLegalHold.update({
    where: { id: parsed.data.holdId },
    data: {
      extensionUntil: new Date(parsed.data.extensionUntil),
      extensionReason: parsed.data.reason,
    },
  });
  return { success: true };
}

export async function releaseLegalHold(input: unknown): Promise<GovernanceResponse> {
  const parsed = z
    .object({ holdId: z.string().min(1), reason: z.string().min(10).max(500) })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "A reasoned release is required." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  const hold = await db.riskLegalHold.findUnique({
    where: { id: parsed.data.holdId },
    select: { tenantId: true },
  });
  if (!hold || !canAccessTenant(actor, hold.tenantId)) {
    return { success: false, error: "Legal hold not found." };
  }
  await db.riskLegalHold.update({
    where: { id: parsed.data.holdId },
    data: { releasedAt: new Date(), releasedById: actor.userId, releaseReason: parsed.data.reason },
  });
  await controlEvent({
    level: "subject",
    action: "legal_hold_released",
    scopeId: parsed.data.holdId,
    actorId: actor.userId,
    reason: parsed.data.reason,
    outcome: "released",
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// ENG-03 — subject rights and privacy review
// ---------------------------------------------------------------------------

const rightsSchema = z.object({
  subjectUserId: z.string().min(1),
  type: z.enum(SUBJECT_RIGHT_TYPES),
  details: z.string().min(10).max(2000),
  evidenceMetadata: z.string().max(2000).nullable().optional(),
});

const myRightsSchema = z.object({
  type: z.enum(SUBJECT_RIGHT_TYPES),
  details: z.string().min(10).max(2000),
  evidenceMetadata: z.string().max(2000).nullable().optional(),
});

async function createSubjectRightsCase(input: {
  tenantId: string;
  actorId: string;
  subject: { id: string; fullName: string; phone: string };
  type: (typeof SUBJECT_RIGHT_TYPES)[number];
  details: string;
  evidenceMetadata?: string | null;
  initiatedBy: "subject" | "administrator";
}): Promise<GovernanceResponse<{ caseRef: string }>> {
  const { tenantId, actorId, subject, type, details, evidenceMetadata, initiatedBy } = input;
  const receivedAt = new Date();
  const deadlines = computeRightsDeadlines(receivedAt.toISOString());
  const caseRef = `SR-${randomBytes(8).toString("hex").toUpperCase()}`;
  const candidates = candidateSubjectKeys(subject.fullName, subject.phone);
  const primaryKey = candidates[0]?.subjectKey ?? null;

  await db.$transaction(async (tx) => {
    const request = await tx.subjectRightsRequest.create({
      data: {
        caseRef,
        tenantId,
        subjectKey: primaryKey,
        subjectUserId: subject.id,
        type,
        classification: requiresFreeze(type) ? "freeze_required" : "standard",
        status: requiresFreeze(type) ? "frozen" : "received",
        receivedAt,
        ackDeadline: new Date(deadlines.ackDeadline),
        resolutionDeadline: new Date(deadlines.resolutionDeadline),
        holidayCalendarVersion: deadlines.holidayCalendarVersion,
        evidence: evidenceMetadata ?? null,
      },
    });
    await tx.rightsRequestCommunication.create({
      data: {
        requestId: request.id,
        direction: "inbound",
        channel: "workspace",
        content: details,
        actorId,
      },
    });
    if (requiresFreeze(type) && candidates.length > 0) {
      for (const candidate of candidates) {
        await tx.riskSubjectFreeze.create({
          data: {
            subjectKey: candidate.subjectKey,
            reason: `Subject rights case ${caseRef} is under adjudication.`,
            caseRef,
            frozenById: actorId,
            notifiedTenantId: tenantId,
          },
        });
        await tx.agentRiskSignal.updateMany({
          where: { subjectKey: candidate.subjectKey, status: "open" },
          data: { status: "disputed_frozen", frozenAt: receivedAt, disputedAt: receivedAt },
        });
      }
    }
    await createAuditLogTx(tx, {
      tenantId,
      userId: actorId,
      action: "risk_rights.request_submitted",
      entityType: "subjectRightsRequest",
      entityId: request.id,
      details: { caseRef, type, initiatedBy, financialMutation: false },
    });
  });

  if (requiresFreeze(type)) {
    await notifyContributingBusinesses(
      candidates.map((candidate) => candidate.subjectKey),
      type === "challenge" ? "signal_challenged" : "signal_disputed",
      caseRef,
      actorId
    );
  }
  revalidatePath("/admin/privacy-review");
  revalidatePath("/worker/privacy-notice");
  return { success: true, data: { caseRef } };
}

export async function submitSubjectRightsRequest(
  input: unknown
): Promise<GovernanceResponse<{ caseRef: string }>> {
  const parsed = rightsSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid rights request." };
  const ctx = await requireTenantAdminMomo();
  const subject = await db.user.findFirst({
    where: { id: parsed.data.subjectUserId, tenantId: ctx.tenantId },
    select: { id: true, fullName: true, phone: true },
  });
  if (!subject) return { success: false, error: "Employee not found." };
  if (!subject.phone) {
    return { success: false, error: "A recorded phone number is needed to match shared signals." };
  }
  return createSubjectRightsCase({
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    subject: { id: subject.id, fullName: subject.fullName, phone: subject.phone },
    type: parsed.data.type,
    details: parsed.data.details,
    evidenceMetadata: parsed.data.evidenceMetadata,
    initiatedBy: "administrator",
  });
}

/**
 * A worker or agent may exercise their own rights without asking an
 * administrator to act for them. The subject identity always comes from the
 * server-verified session, never from client input.
 */
export async function submitMySubjectRightsRequest(
  input: unknown
): Promise<GovernanceResponse<{ caseRef: string }>> {
  const parsed = myRightsSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid rights request." };
  const session = (await getMomoSession()) ?? (await getSusuSession());
  if (!session?.userId || !session.tenantId || session.role === "customer") {
    return { success: false, error: "Sign in as an employee or agent to submit a rights request." };
  }
  const subject = await db.user.findFirst({
    where: { id: session.userId, tenantId: session.tenantId, status: "active" },
    select: { id: true, fullName: true, phone: true },
  });
  if (!subject) return { success: false, error: "Your employee record could not be resolved." };
  if (!subject.phone) {
    return { success: false, error: "A recorded phone number is needed to match shared signals." };
  }
  return createSubjectRightsCase({
    tenantId: session.tenantId,
    actorId: session.userId,
    subject: { id: subject.id, fullName: subject.fullName, phone: subject.phone },
    type: parsed.data.type,
    details: parsed.data.details,
    evidenceMetadata: parsed.data.evidenceMetadata,
    initiatedBy: "subject",
  });
}

const caseActionSchema = z.object({ caseRef: z.string().min(1), message: z.string().min(10).max(2000) });

export async function acknowledgeRightsRequest(input: unknown): Promise<GovernanceResponse> {
  const parsed = caseActionSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "A reasoned acknowledgement is required." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  const request = await db.subjectRightsRequest.findUnique({ where: { caseRef: parsed.data.caseRef } });
  if (!request) return { success: false, error: "Case not found." };
  if (!canAccessTenant(actor, request.tenantId)) {
    return { success: false, error: "Case not found." };
  }
  await db.$transaction(async (tx) => {
    await tx.subjectRightsRequest.update({
      where: { id: request.id },
      data: {
        acknowledgedAt: new Date(),
        status: request.status === "frozen" ? "frozen" : "acknowledged",
        reviewerId: request.reviewerId ?? actor.userId,
      },
    });
    await tx.rightsRequestCommunication.create({
      data: {
        requestId: request.id,
        direction: "outbound",
        channel: "workspace",
        content: parsed.data.message,
        actorId: actor.userId,
      },
    });
  });
  await controlEvent({
    level: "subject",
    action: "rights_request_acknowledged",
    scopeId: parsed.data.caseRef,
    tenantId: request.tenantId,
    actorId: actor.userId,
    reason: parsed.data.message,
    outcome: "acknowledged",
  });
  return { success: true };
}

export async function assignRightsReviewer(input: unknown): Promise<GovernanceResponse> {
  const parsed = z
    .object({ caseRef: z.string().min(1), reviewerId: z.string().min(1) })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid reviewer assignment." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  const request = await db.subjectRightsRequest.findUnique({
    where: { caseRef: parsed.data.caseRef },
    select: { id: true, tenantId: true },
  });
  if (!request) return { success: false, error: "Case not found." };
  if (!canAccessTenant(actor, request.tenantId)) {
    return { success: false, error: "Case not found." };
  }
  const reviewer = await db.riskPrivacyAccess.findFirst({
    where: { userId: parsed.data.reviewerId, active: true },
    select: { role: true, userId: true },
  });
  const reviewerUser = reviewer
    ? await db.user.findUnique({
        where: { id: reviewer.userId },
        select: { tenantId: true, status: true },
      })
    : null;
  if (
    !reviewer ||
    reviewerUser?.status !== "active" ||
    reviewerUser.tenantId !== request.tenantId ||
    !canAccessTenant(actor, reviewerUser.tenantId)
  ) {
    return { success: false, error: "The selected reviewer is not an active privacy reviewer in this business." };
  }
  await db.subjectRightsRequest.update({
    where: { caseRef: parsed.data.caseRef },
    data: { reviewerId: parsed.data.reviewerId, status: "in_review" },
  });
  await controlEvent({
    level: "subject",
    action: "rights_request_assigned",
    scopeId: parsed.data.caseRef,
    tenantId: request.tenantId,
    actorId: actor.userId,
    reason: "Rights case assigned to an authorised privacy reviewer.",
    outcome: parsed.data.reviewerId,
  });
  return { success: true };
}

export async function verifyRightsIdentity(input: unknown): Promise<GovernanceResponse> {
  const parsed = z
    .object({
      caseRef: z.string().min(1),
      evidenceMetadata: z.string().min(10).max(2000),
      verified: z.boolean(),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "Identity verification evidence is required." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  const request = await db.subjectRightsRequest.findUnique({
    where: { caseRef: parsed.data.caseRef },
    select: { id: true, tenantId: true },
  });
  if (!request) return { success: false, error: "Case not found." };
  if (!canAccessTenant(actor, request.tenantId)) {
    return { success: false, error: "Case not found." };
  }
  await db.subjectRightsRequest.update({
    where: { caseRef: parsed.data.caseRef },
    data: {
      identityVerified: parsed.data.verified,
      evidence: parsed.data.evidenceMetadata,
    },
  });
  await controlEvent({
    level: "subject",
    action: "rights_identity_checked",
    scopeId: parsed.data.caseRef,
    tenantId: request.tenantId,
    actorId: actor.userId,
    reason: parsed.data.evidenceMetadata,
    outcome: parsed.data.verified ? "verified" : "not_verified",
  });
  return { success: true };
}

export async function extendRightsDeadline(input: unknown): Promise<GovernanceResponse> {
  const parsed = z
    .object({ caseRef: z.string().min(1), writtenReason: z.string().min(20).max(2000) })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "A written, reasoned privacy notice is required." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  const request = await db.subjectRightsRequest.findUnique({ where: { caseRef: parsed.data.caseRef } });
  if (!request) return { success: false, error: "Case not found." };
  if (!canAccessTenant(actor, request.tenantId)) {
    return { success: false, error: "Case not found." };
  }
  if (request.extendedDeadline) return { success: false, error: "Only one extension is permitted." };
  if (isOverdue(request.resolutionDeadline.toISOString(), new Date().toISOString())) {
    return { success: false, error: "An extension must be decided before the original deadline." };
  }
  const extended = applyRightsExtension(request.resolutionDeadline.toISOString(), parsed.data.writtenReason);
  await db.subjectRightsRequest.update({
    where: { id: request.id },
    data: {
      extendedDeadline: new Date(extended),
      extensionReason: parsed.data.writtenReason,
      extensionApprovedById: actor.userId,
    },
  });
  await controlEvent({
    level: "subject",
    action: "rights_deadline_extended",
    scopeId: parsed.data.caseRef,
    tenantId: request.tenantId,
    actorId: actor.userId,
    reason: parsed.data.writtenReason,
    outcome: "one_14_day_extension",
  });
  return { success: true, data: undefined };
}

export async function recordRightsCommunication(input: unknown): Promise<GovernanceResponse> {
  const parsed = caseActionSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid communication." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  const request = await db.subjectRightsRequest.findUnique({ where: { caseRef: parsed.data.caseRef } });
  if (!request) return { success: false, error: "Case not found." };
  if (!canAccessTenant(actor, request.tenantId)) {
    return { success: false, error: "Case not found." };
  }
  await db.rightsRequestCommunication.create({
    data: {
      requestId: request.id,
      direction: "outbound",
      channel: "workspace",
      content: parsed.data.message,
      actorId: actor.userId,
    },
  });
  await controlEvent({
    level: "subject",
    action: "rights_communication_recorded",
    scopeId: parsed.data.caseRef,
    tenantId: request.tenantId,
    actorId: actor.userId,
    reason: parsed.data.message,
    outcome: "outbound",
  });
  return { success: true };
}

export async function resolveRightsRequest(input: unknown): Promise<GovernanceResponse> {
  const parsed = z
    .object({
      caseRef: z.string().min(1),
      decision: z.string().min(3).max(120),
      reason: z.string().min(20).max(2000),
      closeCase: z.boolean().optional(),
      freezeOutcome: z.enum(["upheld", "rejected", "not_applicable"]).optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "A reasoned decision is required." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  const request = await db.subjectRightsRequest.findUnique({ where: { caseRef: parsed.data.caseRef } });
  if (!request) return { success: false, error: "Case not found." };
  if (!canAccessTenant(actor, request.tenantId)) {
    return { success: false, error: "Case not found." };
  }
  const freezes = await db.riskSubjectFreeze.findMany({
    where: { caseRef: request.caseRef, status: "frozen" },
    select: { id: true, subjectKey: true },
  });
  if (freezes.length > 0 && !actor.viaPlatform) {
    return {
      success: false,
      error:
        "The linked cross-business subject freeze must be resolved by a platform administrator before this case can close.",
    };
  }
  if (freezes.length > 0 && !parsed.data.freezeOutcome) {
    return {
      success: false,
      error: "Resolve the linked subject freeze as upheld or rejected before closing this case.",
    };
  }
  if (freezes.length === 0 && parsed.data.freezeOutcome === "upheld") {
    return { success: false, error: "No linked subject freeze exists to uphold." };
  }
  const freezeKeys = Array.from(new Set(freezes.map((row) => row.subjectKey)));
  const freezeOutcome = parsed.data.freezeOutcome ?? "not_applicable";
  await db.$transaction(async (tx) => {
    if (freezeOutcome === "upheld" && freezeKeys.length > 0) {
      await tx.agentRiskSignal.updateMany({
        where: { subjectKey: { in: freezeKeys }, status: "disputed_frozen" },
        data: { status: "withdrawn", withdrawnAt: new Date(), resolvedAt: new Date() },
      });
    } else if (freezeOutcome === "rejected" && freezeKeys.length > 0) {
      await tx.agentRiskSignal.updateMany({
        where: { subjectKey: { in: freezeKeys }, status: "disputed_frozen" },
        data: { status: "open", frozenAt: null, disputedAt: null, resolvedAt: new Date() },
      });
    }
    if (freezes.length > 0) {
      await tx.riskSubjectFreeze.updateMany({
        where: { id: { in: freezes.map((row) => row.id) } },
        data: {
          status: freezeOutcome === "upheld" ? "upheld" : "restored",
          resolution: freezeOutcome,
          resolutionById: actor.userId,
          resolvedAt: new Date(),
        },
      });
    }
    await tx.subjectRightsRequest.update({
      where: { id: request.id },
      data: {
        status: parsed.data.closeCase ? "closed" : "resolved",
        decision: parsed.data.decision,
        decisionReason: parsed.data.reason,
        resolvedAt: new Date(),
        closedAt: parsed.data.closeCase ? new Date() : null,
      },
    });
    await tx.rightsRequestCommunication.create({
      data: {
        requestId: request.id,
        direction: "outbound",
        channel: "workspace",
        content: `${parsed.data.decision}: ${parsed.data.reason}`,
        actorId: actor.userId,
      },
    });
    await tx.riskControlEvent.create({
      data: {
        level: "subject",
        action: "rights_request_resolved",
        scopeId: request.subjectKey ?? request.id,
        tenantId: request.tenantId,
        actorId: actor.userId,
        reason: parsed.data.reason,
        outcome: parsed.data.decision + " · freeze " + freezeOutcome,
        history: JSON.stringify({
          decision: parsed.data.decision,
          freezeOutcome,
          freezeCount: freezes.length,
          closed: Boolean(parsed.data.closeCase),
        }),
      },
    });
  });
  if (freezeKeys.length > 0) {
    await notifyContributingBusinesses(
      freezeKeys,
      freezeOutcome === "upheld" ? "signal_withdrawn" : "signal_review_required",
      request.caseRef,
      actor.userId
    );
  }
  return { success: true };
}

/** Restricted privacy queue. No contributing business's underlying report is returned. */
export async function listSubjectRightsRequests(): Promise<
  GovernanceResponse<
    {
      caseRef: string;
      type: string;
      status: string;
      receivedAt: string;
      ackDeadline: string;
      resolutionDeadline: string;
      effectiveDeadline: string;
      overdue: boolean;
      reviewerId: string | null;
    }[]
  >
> {
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  const rows = await db.subjectRightsRequest.findMany({
    where: actor.viaPlatform ? undefined : { tenantId: actor.tenantId ?? "__no_tenant__" },
    orderBy: { receivedAt: "desc" },
    take: 100,
  });
  const now = new Date().toISOString();
  return {
    success: true,
    data: rows.map((row) => {
      const effective = row.extendedDeadline?.toISOString() ?? row.resolutionDeadline.toISOString();
      return {
        caseRef: row.caseRef,
        type: row.type,
        status: row.status,
        receivedAt: row.receivedAt.toISOString(),
        ackDeadline: row.ackDeadline.toISOString(),
        resolutionDeadline: row.resolutionDeadline.toISOString(),
        effectiveDeadline: effective,
        overdue: isOverdue(effective, now),
        reviewerId: row.reviewerId,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// ENG-06 — employee notices and attestations
// ---------------------------------------------------------------------------

export async function publishEmployeePrivacyNotice(
  input: unknown
): Promise<GovernanceResponse> {
  const parsed = z
    .object({
      version: z.string().min(3).max(80),
      title: z.string().min(3).max(160),
      documentText: z.string().min(20),
      effectiveDate: z.string().datetime(),
      policyVersion: z.string().min(1),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid notice." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  if (!actor.viaPlatform) return { success: false, error: GLOBAL_PRIVACY_ERROR };
  const hash = createHash("sha256").update(parsed.data.documentText).digest("hex");
  await db.employeePrivacyNotice.upsert({
    where: { version: parsed.data.version },
    update: {
      title: parsed.data.title,
      documentText: parsed.data.documentText,
      documentHash: hash,
      effectiveDate: new Date(parsed.data.effectiveDate),
      policyVersion: parsed.data.policyVersion,
    },
    create: {
      version: parsed.data.version,
      title: parsed.data.title,
      documentText: parsed.data.documentText,
      documentHash: hash,
      effectiveDate: new Date(parsed.data.effectiveDate),
      policyVersion: parsed.data.policyVersion,
    },
  });
  await controlEvent({
    level: "global",
    action: "privacy_notice_published",
    actorId: actor.userId,
    reason: `Notice version ${parsed.data.version} published with hash ${hash.slice(0, 12)}…`,
    outcome: "published",
  });
  return { success: true };
}

/**
 * Publish the controlled Instrument 3 text. Employee-specific facts are
 * populated when each employee reads the notice; the stored text is the
 * versioned template, never a partially completed document.
 */
export async function publishControlledEmployeeNotice(input: unknown): Promise<GovernanceResponse> {
  const parsed = z
    .object({
      version: z.string().min(3).max(80),
      effectiveDate: z.string().datetime(),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid notice version or effective date." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  if (!actor.viaPlatform) return { success: false, error: GLOBAL_PRIVACY_ERROR };
  const template = employeeNoticeTemplate();
  const hash = createHash("sha256").update(template, "utf8").digest("hex");
  await db.employeePrivacyNotice.upsert({
    where: { version: parsed.data.version },
    update: {
      title: "Employee and Agent Privacy Notice",
      documentText: template,
      documentHash: hash,
      effectiveDate: new Date(parsed.data.effectiveDate),
      policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
    },
    create: {
      version: parsed.data.version,
      title: "Employee and Agent Privacy Notice",
      documentText: template,
      documentHash: hash,
      effectiveDate: new Date(parsed.data.effectiveDate),
      policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
    },
  });
  await controlEvent({
    level: "global",
    action: "privacy_notice_published",
    actorId: actor.userId,
    reason: `Controlled Instrument 3 published as version ${parsed.data.version}.`,
    outcome: "published",
  });
  revalidatePath("/admin/privacy-review");
  revalidatePath("/worker/privacy-notice");
  return { success: true };
}

const attestationSchema = z.object({
  userId: z.string().min(1),
  noticeVersion: z.string().min(1),
  deliveryMethod: z.enum(ACCEPTED_NOTICE_DELIVERY_METHODS),
  deliveryEvidence: z.string().min(5).max(500),
  acknowledgementState: z.enum(["delivered", "acknowledged", "declined", "failed"]),
  acknowledgedAt: z.string().datetime().nullable().optional(),
  /** The recorder confirms the evidence was checked; false is stored as unverified. */
  evidenceVerified: z.boolean().optional(),
  failureReason: z.string().max(300).optional(),
});

export async function recordEmployeeNoticeAttestation(
  input: unknown
): Promise<GovernanceResponse> {
  const parsed = attestationSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid notice attestation." };
  const ctx = await requireTenantAdminMomo();
  const employee = await db.user.findFirst({
    where: { id: parsed.data.userId, tenantId: ctx.tenantId },
    select: { id: true },
  });
  if (!employee) return { success: false, error: "Employee not found." };
  let notice;
  try {
    notice = await resolveEffectiveNotice(ctx.tenantId, employee.id);
  } catch {
    return {
      success: false,
      error:
        "The exact employee notice cannot be issued until the business legal profile and the employee's name and phone number are complete.",
    };
  }
  if (notice.version !== parsed.data.noticeVersion) {
    return { success: false, error: "That is not the current notice version for this employee." };
  }
  if (notice.provisional || notice.policyVersion !== RISK_INTELLIGENCE_POLICY_VERSION) {
    return { success: false, error: "This notice version is not the current controlled policy version." };
  }
  if (parsed.data.acknowledgementState === "declined") {
    return { success: false, error: "A declined notice cannot be recorded as delivered evidence." };
  }
  if (parsed.data.acknowledgementState === "failed" && !parsed.data.failureReason?.trim()) {
    return { success: false, error: "Record why the delivery failed." };
  }
  // A failed or returned delivery is stored, but it is never verification and
  // never satisfies the contribution gate.
  const verified =
    parsed.data.acknowledgementState === "acknowledged" &&
    parsed.data.evidenceVerified !== false &&
    parsed.data.deliveryEvidence.trim().length >= 8;
  await db.employeeNoticeAttestation.upsert({
    where: {
      tenantId_userId_noticeVersion: {
        tenantId: ctx.tenantId,
        userId: parsed.data.userId,
        noticeVersion: parsed.data.noticeVersion,
      },
    },
    update: {
      deliveryMethod: parsed.data.deliveryMethod,
      deliveryEvidence: parsed.data.deliveryEvidence,
      acknowledgementState: parsed.data.acknowledgementState,
      acknowledgedAt: parsed.data.acknowledgedAt ? new Date(parsed.data.acknowledgedAt) : null,
      verified,
      verifiedAt: verified ? new Date() : null,
      failureReason: parsed.data.failureReason?.trim() || null,
      recordedById: ctx.userId,
      policyVersion: notice.policyVersion,
      documentSha256: notice.documentHash,
    },
    create: {
      tenantId: ctx.tenantId,
      userId: parsed.data.userId,
      noticeVersion: parsed.data.noticeVersion,
      issuedAt: new Date(),
      deliveryMethod: parsed.data.deliveryMethod,
      deliveryEvidence: parsed.data.deliveryEvidence,
      acknowledgementState: parsed.data.acknowledgementState,
      acknowledgedAt: parsed.data.acknowledgedAt ? new Date(parsed.data.acknowledgedAt) : null,
      verified,
      verifiedAt: verified ? new Date() : null,
      failureReason: parsed.data.failureReason?.trim() || null,
      recordedById: ctx.userId,
      policyVersion: notice.policyVersion,
      documentSha256: notice.documentHash,
    },
  });
  await createAuditLog({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    action: "risk_notice.attestation_recorded",
    entityType: "employeeNoticeAttestation",
    entityId: employee.id,
    details: {
      noticeVersion: parsed.data.noticeVersion,
      verified,
      acknowledgementState: parsed.data.acknowledgementState,
      statement: NOTICE_ACKNOWLEDGEMENT_IS_NOT_CONSENT,
      financialMutation: false,
    },
  });
  return { success: true };
}

export async function getPrivacyNotices(): Promise<
  GovernanceResponse<{ version: string; title: string; effectiveDate: string }[]>
> {
  const rows = await db.employeePrivacyNotice.findMany({
    orderBy: { effectiveDate: "desc" },
    select: { version: true, title: true, effectiveDate: true },
  });
  return {
    success: true,
    data: rows.map((row) => ({
      version: row.version,
      title: row.title,
      effectiveDate: row.effectiveDate.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// ENG-08 — electronic agreements and participation verification
// ---------------------------------------------------------------------------

const businessProfileSchema = z.object({
  legalName: z.string().min(2).max(200),
  registrationNumber: z.string().min(3).max(40),
  address: z.string().min(8).max(400),
  contactEmail: z.string().email().max(200),
  contactPhone: z.string().min(7).max(40),
  dpcRegistrationStatus: z.enum(["not_provided", "pending", "registered", "exempt"]),
  dpcRegistrationNumber: z.string().max(80).optional().nullable(),
});

/**
 * Owner-completed legal identity for this business. This never blocks account
 * creation or ordinary MaaCash use; it gates participation in the Shared
 * Register, because an agreement must name the correct legal party.
 */
export async function setBusinessLegalProfile(input: unknown): Promise<GovernanceResponse> {
  const parsed = businessProfileSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid business details." };
  }
  const ctx = await requireTenantAdminMomo();
  const missing = businessProfileCompleteness(parsed.data);
  if (missing.length > 0) {
    return { success: false, error: "Complete the following: " + missing.join(", ") + "." };
  }
  if (parsed.data.dpcRegistrationStatus === "registered" && !parsed.data.dpcRegistrationNumber?.trim()) {
    return { success: false, error: "A DPC registration number is required when the status is registered." };
  }
  const tenant = await db.businessTenant.findUnique({
    where: { id: ctx.tenantId },
    select: { legalName: true, name: true, registrationNumber: true },
  });
  if (!tenant) return { success: false, error: "Business not found." };
  const executed = await db.participationAgreement.findFirst({
    where: { tenantId: ctx.tenantId, state: { in: ["executed", "active"] } },
    select: { id: true, type: true },
  });
  const previousLegalName = (tenant.legalName ?? tenant.name).trim();
  const previousRegistration = (tenant.registrationNumber ?? "").trim();
  if (
    executed &&
    (previousRegistration !== parsed.data.registrationNumber.trim() ||
      previousLegalName.toLowerCase() !== parsed.data.legalName.trim().toLowerCase())
  ) {
    return {
      success: false,
      error:
        "The legal name or registration number is bound to an executed agreement. Contact BloomCore support to supersede and reissue the instruments.",
    };
  }
  await db.$transaction(async (tx) => {
    await tx.businessTenant.update({
      where: { id: ctx.tenantId },
      data: {
        legalName: parsed.data.legalName.trim(),
        registrationNumber: parsed.data.registrationNumber.trim(),
        address: parsed.data.address.trim(),
        contactEmail: parsed.data.contactEmail.trim().toLowerCase(),
        contactPhone: parsed.data.contactPhone.trim(),
        dpcRegistrationStatus: parsed.data.dpcRegistrationStatus,
        dpcRegistrationNumber: parsed.data.dpcRegistrationNumber?.trim() || null,
        dpcRegistrationCheckedAt: new Date(),
      },
    });
    await createAuditLogTx(tx, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "risk_onboarding.business_profile_updated",
      entityType: "businessTenant",
      entityId: ctx.tenantId,
      details: {
        dpcRegistrationStatus: parsed.data.dpcRegistrationStatus,
        registrationNumberChanged: previousRegistration !== parsed.data.registrationNumber.trim(),
        financialMutation: false,
      },
    });
  });
  revalidatePath("/admin/agreements");
  revalidatePath("/admin");
  return { success: true };
}

export interface AgreementOnboardingState {
  profileMissing: string[];
  profileComplete: boolean;
  legalName: string;
  registrationNumber: string;
  address: string;
  contactEmail: string;
  contactPhone: string;
  /** Full name of the authenticated account holder who will sign. */
  signatoryName: string;
  registeredOfficeConfirmed: boolean;
  bloomcoreSignatoryConfigured: boolean;
  dpcRegistrationStatus: DpcRegistrationState;
  dpcRegistrationNumber: string | null;
  documents: {
    type: LegalInstrumentType;
    title: string;
    version: string;
    effectiveDate: string;
    conditional: boolean;
    state: string | null;
    agreementId: string | null;
    controlledHashConfigured: boolean;
  }[];
}

export async function getAgreementOnboardingState(): Promise<
  GovernanceResponse<AgreementOnboardingState>
> {
  try {
    const ctx = await requireTenantAdminMomo();
    const [profile, bloomcore, agreements, tenant, signatory] = await Promise.all([
      getBusinessLegalProfile(ctx.tenantId),
      getRiskOrganisationConfig().then((config) => config.legal),
      db.participationAgreement.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: "desc" },
        select: { id: true, type: true, state: true, version: true },
      }),
      db.businessTenant.findUnique({
        where: { id: ctx.tenantId },
        select: {
          name: true,
          legalName: true,
          registrationNumber: true,
          address: true,
          contactEmail: true,
          contactPhone: true,
        },
      }),
      db.user.findFirst({
        where: { id: ctx.userId, tenantId: ctx.tenantId },
        select: { fullName: true },
      }),
    ]);
    const byType = new Map<string, { id: string; state: string; version: string }>();
    for (const row of agreements) {
      if (!byType.has(row.type)) byType.set(row.type, { id: row.id, state: row.state, version: row.version });
    }
    return {
      success: true,
      data: {
        profileMissing: profile.missing,
        profileComplete: profile.missing.length === 0,
        legalName: tenant?.legalName ?? tenant?.name ?? "",
        registrationNumber: tenant?.registrationNumber ?? "",
        address: tenant?.address ?? "",
        contactEmail: tenant?.contactEmail ?? "",
        contactPhone: tenant?.contactPhone ?? "",
        signatoryName: signatory?.fullName ?? "",
        registeredOfficeConfirmed: bloomcore.registeredOfficeConfirmed,
        bloomcoreSignatoryConfigured: bloomcore.signatoryConfigured,
        dpcRegistrationStatus: profile.dpcRegistrationStatus,
        dpcRegistrationNumber: profile.dpcRegistrationNumber,
        documents: AGREEMENT_CATALOGUE.map((entry) => ({
          type: entry.type,
          title: entry.title,
          version: entry.version,
          effectiveDate: entry.effectiveDate,
          conditional: entry.conditional,
          state: byType.get(entry.type)?.state ?? null,
          agreementId: byType.get(entry.type)?.id ?? null,
          // Controlled instruments are rendered from the versioned server source;
          // approval is tied to LEGAL_INSTRUMENT_VERSION, not a per-business hash.
          controlledHashConfigured: true,
        })),
      },
    };
  } catch {
    return { success: false, error: "Agreement onboarding is available to tenant administrators only." };
  }
}

const controlledAgreementSchema = z.object({
  type: z.enum(["joint_controller", "participation_terms", "processing_addendum"]),
  capacity: z.string().min(3).max(160),
  authorityBasis: z.string().min(5).max(500),
});

/**
 * Render the controlled instrument on the server from verified facts and
 * present it for acceptance. The browser never supplies clause text.
 */
export async function presentControlledAgreement(
  input: unknown
): Promise<GovernanceResponse<{ id: string; documentSha256: string; documentText: string; version: string }>> {
  const parsed = controlledAgreementSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid agreement details." };
  const ctx = await requireTenantAdminMomo();
  const catalogue = AGREEMENT_CATALOGUE.find((entry) => entry.type === parsed.data.type);
  if (!catalogue) return { success: false, error: "Agreement type is not recognised." };
  const [profile, signatory, organisation] = await Promise.all([
    getBusinessLegalProfile(ctx.tenantId),
    getSignatoryProfile(
      ctx.userId,
      ctx.tenantId,
      parsed.data.capacity,
      parsed.data.authorityBasis,
      "verified account session and password re-authentication"
    ),
    getRiskOrganisationConfig(),
  ]);
  const bloomcore = organisation.legal;
  if (!profile.profile) {
    return {
      success: false,
      error: "Complete the business legal profile first: " + profile.missing.join(", ") + ".",
    };
  }
  if (!signatory) return { success: false, error: "Signatory identity could not be confirmed." };
  if (!bloomcore.signatoryConfigured || !bloomcore.registeredOfficeConfirmed) {
    return {
      success: false,
      error:
        "BloomCore countersignatory details or the confirmed registered office are not configured. Set them under Platform → Risk access before accepting agreements.",
    };
  }
  let documentText: string;
  try {
    documentText = renderLegalInstrument(parsed.data.type, {
      business: profile.profile,
      signatory: {
        ...signatory,
        capacity: parsed.data.capacity.trim(),
        authorityBasis: parsed.data.authorityBasis.trim(),
      },
      bloomcore,
      infrastructure: organisation.infrastructure,
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "The controlled instrument could not be rendered.",
    };
  }
  const hash = instrumentSha256(documentText);
  // The controlled text is generated from the versioned source in
  // legal-instruments.ts. Its final hash is evidence of the exact document
  // presented, not a deployment-wide constant (each business has its own
  // legal name, registration number and signatory).
  if (catalogue.version !== LEGAL_INSTRUMENT_VERSION) {
    return {
      success: false,
      error: "The instrument version is not the currently approved controlled version.",
    };
  }
  const latest = await db.participationAgreement.findFirst({
    where: { tenantId: ctx.tenantId, type: parsed.data.type },
    orderBy: { createdAt: "desc" },
  });
  if (latest) {
    if (latest.state === "presented") {
      return {
        success: true,
        data: { id: latest.id, documentSha256: latest.documentSha256, documentText: latest.documentText, version: latest.version },
      };
    }
    if (["accepted", "awaiting_countersignature", "executed", "active", "superseded"].includes(latest.state)) {
      return { success: false, error: "This instrument version has already been accepted for this business." };
    }
  }
  const agreement = await db.participationAgreement.create({
    data: {
      tenantId: ctx.tenantId,
      type: parsed.data.type,
      title: catalogue.title,
      version: catalogue.version,
      effectiveDate: new Date(catalogue.effectiveDate),
      documentText,
      documentSha256: hash,
      documentRef: catalogue.sourceDocument,
      state: "presented",
      signatoryId: signatory.userId,
      signatoryName: signatory.fullName,
      signatoryRole: parsed.data.capacity.trim(),
      signatoryAuthority: parsed.data.authorityBasis.trim(),
      authenticationMethod: "verified account session; password re-authentication at acceptance",
    },
    select: { id: true, documentSha256: true, version: true },
  });
  await createAuditLog({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    action: "risk_agreement.controlled_presented",
    entityType: "participationAgreement",
    entityId: agreement.id,
    details: {
      type: parsed.data.type,
      version: catalogue.version,
      documentSha256: hash,
      financialMutation: false,
    },
  });
  return { success: true, data: { ...agreement, documentText } };
}
export async function presentParticipationAgreement(
  input: unknown
): Promise<GovernanceResponse<{ id: string; documentSha256: string }>> {
  const parsed = z
    .object({
      type: z.enum(["joint_controller", "participation_terms", "processing_addendum"]),
      version: z.string().min(1).max(80),
      effectiveDate: z.string().datetime(),
      documentText: z.string().min(20),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid agreement presentation." };
  const ctx = await requireTenantAdminMomo();
  const catalogue = AGREEMENT_CATALOGUE.find((entry) => entry.type === parsed.data.type);
  if (!catalogue) return { success: false, error: "Agreement type is not recognised." };
  const hash = createHash("sha256").update(parsed.data.documentText).digest("hex");
  const approved = approvedAgreementHash(parsed.data.type);
  if (!approved) {
    return {
      success: false,
      error:
        "No approved document hash is configured for this agreement type. Presentation is disabled until approved controlled text is configured.",
    };
  }
  if (approved !== hash) {
    return {
      success: false,
      error: "The document text does not match the approved version. Review the controlled source document.",
    };
  }
  const latest = await db.participationAgreement.findFirst({
    where: { tenantId: ctx.tenantId, type: parsed.data.type },
    orderBy: { createdAt: "desc" },
  });
  if (latest?.version === parsed.data.version) {
    return { success: false, error: "That version has already been presented for this business." };
  }
  if (latest && ["executed", "active"].includes(latest.state)) {
    // Material version change: keep the earlier executed row and its evidence.
    await db.participationAgreement.update({
      where: { id: latest.id },
      data: { state: "superseded" },
    });
  }
  const agreement = await db.participationAgreement.create({
    data: {
      tenantId: ctx.tenantId,
      type: parsed.data.type,
      title: catalogue.title,
      version: parsed.data.version,
      effectiveDate: new Date(parsed.data.effectiveDate),
      documentText: parsed.data.documentText,
      documentSha256: hash,
      documentRef: catalogue.sourceDocument,
      state: "presented",
      signatoryId: ctx.userId,
      signatoryName: "",
      signatoryRole: "",
      signatoryAuthority: "",
      authenticationMethod: "",
    },
    select: { id: true, documentSha256: true },
  });
  return { success: true, data: agreement };
}

export async function acceptParticipationAgreement(
  input: unknown
): Promise<GovernanceResponse> {
  const parsed = z
    .object({
      agreementId: z.string().min(1),
      signatoryName: z.string().min(3).max(160),
      signatoryRole: z.string().min(2).max(120),
      signatoryAuthority: z.string().min(5).max(500),
      authenticationMethod: z.string().min(3).max(120),
      authenticationEvidence: z.string().min(5).max(500).optional(),
      acceptedDocumentSha256: z.string().length(64),
      /** Current account password. Required for controlled, server-rendered instruments. */
      password: z.string().min(1).max(200).optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid acceptance details." };
  const ctx = await requireTenantAdminMomo();
  const agreement = await db.participationAgreement.findFirst({
    where: { id: parsed.data.agreementId, tenantId: ctx.tenantId },
  });
  if (!agreement) return { success: false, error: "Agreement not found." };
  if (!canTransitionAgreement(agreement.state as AgreementState, "accepted")) {
    return { success: false, error: "That agreement cannot be accepted in its current state." };
  }
  if (agreement.documentSha256 !== parsed.data.acceptedDocumentSha256) {
    return { success: false, error: "The document changed after it was presented. Review it again." };
  }
  const signatory = await db.user.findFirst({
    where: { id: ctx.userId, tenantId: ctx.tenantId },
    select: { id: true, fullName: true, passwordHash: true },
  });
  if (!signatory) return { success: false, error: "Signatory identity could not be confirmed." };
  if (signatory.fullName.trim().toLowerCase() !== parsed.data.signatoryName.trim().toLowerCase()) {
    return {
      success: false,
      error: "The signatory name must match the authenticated account holder exactly.",
    };
  }
  const controlled =
    agreement.version === LEGAL_INSTRUMENT_VERSION &&
    Boolean(agreement.documentRef && agreement.documentRef.startsWith(LEGAL_INSTRUMENT_SOURCE));
  if (controlled) {
    if (!parsed.data.password) {
      return {
        success: false,
        error: "Re-enter your account password to sign this agreement.",
      };
    }
    const passwordOk = await verifyPassword(parsed.data.password, signatory.passwordHash);
    if (!passwordOk) return { success: false, error: "The password could not be verified." };
    if (parsed.data.authenticationMethod !== "password_reauth") {
      return { success: false, error: "The authentication method must be password_reauth." };
    }
  }

  await db.$transaction(async (tx) => {
    await tx.participationAgreement.update({
      where: { id: agreement.id },
      data: {
        state: "accepted",
        signatoryId: ctx.userId,
        signatoryName: parsed.data.signatoryName,
        signatoryRole: parsed.data.signatoryRole,
        signatoryAuthority: parsed.data.signatoryAuthority,
        authenticationMethod: controlled
          ? "password_reauth"
          : parsed.data.authenticationMethod,
        authenticationEvidence: controlled
          ? "Account password verified at acceptance; session " + ctx.userId
          : parsed.data.authenticationEvidence ?? null,
        acceptedAt: new Date(),
      },
    });
    await createAuditLogTx(tx, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "risk_agreement.accepted",
      entityType: "participationAgreement",
      entityId: agreement.id,
      details: {
        type: agreement.type,
        version: agreement.version,
        documentSha256: agreement.documentSha256,
        authenticationMethod: parsed.data.authenticationMethod,
        financialMutation: false,
      },
    });
  });
  return { success: true };
}

export async function countersignParticipationAgreement(
  input: unknown
): Promise<GovernanceResponse> {
  const parsed = z.object({ agreementId: z.string().min(1) }).safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  const agreement = await db.participationAgreement.findUnique({
    where: { id: parsed.data.agreementId },
  });
  if (!agreement || !canAccessTenant(actor, agreement.tenantId)) {
    return { success: false, error: "Agreement is not awaiting countersignature." };
  }
  if (agreement.state !== "accepted") {
    return { success: false, error: "Agreement is not awaiting countersignature." };
  }
  const bloomcore = (await getRiskOrganisationConfig()).legal;
  // The owner-confirmed deployment value is authoritative even before the
  // optional database profile row exists. Do not leave countersignature
  // permanently blocked by an unpopulated local profile table.
  const officeConfigured =
    bloomcore.registeredOfficeConfirmed ||
    bloomCoreLegalProfile().registeredOfficeConfirmed;
  if (!bloomcore.signatoryConfigured || !officeConfigured) {
    return {
      success: false,
      error:
        "BloomCore countersignatory details or the confirmed registered office are not configured. Set them under Platform → Risk access.",
    };
  }
  const countersignedAt = new Date();
  const certificate = {
    certificateVersion: 1,
    agreementId: agreement.id,
    type: agreement.type,
    instrumentVersion: agreement.version,
    documentSha256: agreement.documentSha256,
    businessTenantId: agreement.tenantId,
    businessSignatoryName: agreement.signatoryName,
    businessSignatoryCapacity: agreement.signatoryRole,
    businessAcceptedAt: agreement.acceptedAt?.toISOString() ?? null,
    countersignatoryName: bloomcore.signatoryName,
    countersignatoryCapacity: bloomcore.signatoryCapacity,
    countersignedAt: countersignedAt.toISOString(),
    source: agreement.documentRef,
  };
  const executionCertificateSha256 = createHash("sha256")
    .update(JSON.stringify(certificate))
    .digest("hex");
  await db.$transaction(async (tx) => {
    await tx.participationAgreement.update({
      where: { id: agreement.id },
      data: {
        state: "executed",
        countersignedById: actor.userId,
        countersignatoryName: bloomcore.signatoryName,
        countersignatoryCapacity: bloomcore.signatoryCapacity,
        countersignedAt,
        executedAt: countersignedAt,
        executionCertificateSha256,
      },
    });
    await createAuditLogTx(tx, {
      tenantId: agreement.tenantId,
      userId: actor.userId,
      action: "risk_agreement.countersigned",
      entityType: "participationAgreement",
      entityId: agreement.id,
      details: {
        type: agreement.type,
        version: agreement.version,
        executionCertificateSha256,
        financialMutation: false,
      },
    });
  });
  await sendRiskNotification({
    eventType: "agreement_executed",
    scopeType: "agreement",
    scopeId: agreement.id,
    tenantId: agreement.tenantId,
    recipientUserId: agreement.signatoryId,
    reference: agreement.id,
    actorId: actor.userId,
  });
  return { success: true };
}

export async function activateParticipationAgreement(
  input: unknown
): Promise<GovernanceResponse> {
  const parsed = z.object({ agreementId: z.string().min(1) }).safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  const agreement = await db.participationAgreement.findUnique({
    where: { id: parsed.data.agreementId },
  });
  if (!agreement || !canAccessTenant(actor, agreement.tenantId)) {
    return { success: false, error: "Agreement cannot be activated from its current state." };
  }
  if (!canTransitionAgreement(agreement.state as AgreementState, "active")) {
    return { success: false, error: "Agreement cannot be activated from its current state." };
  }
  const activatedAt = new Date();
  await db.$transaction(async (tx) => {
    await tx.participationAgreement.update({
      where: { id: agreement.id },
      data: { state: "active", executedAt: agreement.executedAt ?? activatedAt },
    });
    await createAuditLogTx(tx, {
      tenantId: agreement.tenantId,
      userId: actor.userId,
      action: "risk_agreement.activated",
      entityType: "participationAgreement",
      entityId: agreement.id,
      details: { fromState: agreement.state, financialMutation: false },
    });
    await tx.riskControlEvent.create({
      data: {
        level: "business",
        action: "agreement_activated",
        scopeId: agreement.id,
        tenantId: agreement.tenantId,
        actorId: actor.userId,
        reason: "Executed agreement activated for live participation.",
        outcome: "active",
      },
    });
  });
  return { success: true };
}

export async function listParticipationAgreements(): Promise<
  GovernanceResponse<
    {
      id: string;
      type: string;
      title: string;
      version: string;
      state: string;
      documentSha256: string;
      executedAt: string | null;
    }[]
  >
> {
  const ctx = await requireTenantAdminMomo();
  const rows = await db.participationAgreement.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return {
    success: true,
    data: rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      version: row.version,
      state: row.state,
      documentSha256: row.documentSha256,
      executedAt: row.executedAt?.toISOString() ?? null,
    })),
  };
}

/** Exact executed document for authorised retrieval. Never exposes another tenant. */
export async function getParticipationAgreementDocument(
  input: unknown
): Promise<
  GovernanceResponse<{
    type: string;
    title: string;
    version: string;
    effectiveDate: string;
    documentText: string;
    documentSha256: string;
    state: string;
    signatoryName: string;
    signatoryRole: string;
    signatoryAuthority: string;
    authenticationMethod: string;
    authenticationEvidence: string | null;
    acceptedAt: string | null;
    countersignedAt: string | null;
    executedAt: string | null;
  }>
> {
  const parsed = z.object({ id: z.string().min(1) }).safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request." };
  const tenantCtx = await requireTenantAdminMomo().catch(() => null);
  const privacy = await requirePrivacyActor();
  const agreement = await db.participationAgreement.findUnique({
    where: { id: parsed.data.id },
  });
  if (!agreement) return { success: false, error: "Agreement not found." };
  if (
    (!privacy || !canAccessTenant(privacy, agreement.tenantId)) &&
    tenantCtx?.tenantId !== agreement.tenantId
  ) {
    return { success: false, error: "Agreement not found." };
  }
  return {
    success: true,
    data: {
      type: agreement.type,
      title: agreement.title,
      version: agreement.version,
      effectiveDate: agreement.effectiveDate.toISOString(),
      documentText: agreement.documentText,
      documentSha256: agreement.documentSha256,
      state: agreement.state,
      signatoryName: agreement.signatoryName,
      signatoryRole: agreement.signatoryRole,
      signatoryAuthority: agreement.signatoryAuthority,
      authenticationMethod: agreement.authenticationMethod,
      authenticationEvidence: agreement.authenticationEvidence,
      acceptedAt: agreement.acceptedAt?.toISOString() ?? null,
      countersignedAt: agreement.countersignedAt?.toISOString() ?? null,
      executedAt: agreement.executedAt?.toISOString() ?? null,
    },
  };
}

export async function setParticipationVerification(
  input: unknown
): Promise<GovernanceResponse> {
  const parsed = z
    .object({
      tenantId: z.string().min(1),
      eligibilityVerified: z.boolean(),
      controllerRegistrationChecked: z.boolean(),
      reason: z.string().min(10).max(500),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid verification record." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  if (!canAccessTenant(actor, parsed.data.tenantId)) {
    return { success: false, error: TENANT_SCOPE_ERROR };
  }
  await db.riskIntelligenceConsent.updateMany({
    where: { tenantId: parsed.data.tenantId, status: "active" },
    data: {
      eligibilityVerified: parsed.data.eligibilityVerified,
      controllerRegistrationChecked: parsed.data.controllerRegistrationChecked,
    },
  });
  await controlEvent({
    level: "business",
    action: "participation_verification",
    scopeId: parsed.data.tenantId,
    tenantId: parsed.data.tenantId,
    actorId: actor.userId,
    reason: parsed.data.reason,
    outcome: JSON.stringify({
      eligibilityVerified: parsed.data.eligibilityVerified,
      controllerRegistrationChecked: parsed.data.controllerRegistrationChecked,
    }),
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// ENG-05 — key rotation metadata and safe retirement
// ---------------------------------------------------------------------------

export async function recordKeyRotation(input: unknown): Promise<GovernanceResponse> {
  const parsed = z
    .object({
      newVersion: z.number().int().positive(),
      previousVersion: z.number().int().positive(),
      reason: z.string().min(10).max(500),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid rotation request." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  if (!actor.viaPlatform) return { success: false, error: GLOBAL_PRIVACY_ERROR };
  if (parsed.data.newVersion === parsed.data.previousVersion) {
    return { success: false, error: "A rotation needs two different key versions." };
  }
  const provider = getRiskSecretProvider();
  if (provider.activeVersion() !== parsed.data.newVersion) {
    return {
      success: false,
      error: "The active provider version differs from the version being recorded.",
    };
  }
  if (!provider.keyFor(parsed.data.newVersion) || !provider.keyFor(parsed.data.previousVersion)) {
    return { success: false, error: "Both versions must be available before rotation." };
  }
  await db.$transaction(async (tx) => {
    await tx.riskKeyVersion.updateMany({
      where: { status: "active" },
      data: { status: "previous" },
    });
    await tx.riskKeyVersion.upsert({
      where: { version: parsed.data.newVersion },
      update: { status: "active", retiredAt: null },
      create: { version: parsed.data.newVersion, status: "active" },
    });
    await tx.riskKeyVersion.upsert({
      where: { version: parsed.data.previousVersion },
      update: { status: "previous" },
      create: { version: parsed.data.previousVersion, status: "previous" },
    });
    await tx.riskControlEvent.create({
      data: {
        level: "global",
        action: "key_rotation",
        actorId: actor.userId,
        reason: parsed.data.reason,
        outcome: `active=${parsed.data.newVersion}, previous=${parsed.data.previousVersion}`,
        history: JSON.stringify({
          active: parsed.data.newVersion,
          previous: parsed.data.previousVersion,
        }),
      },
    });
  });
  return { success: true };
}

export async function retireKeyVersion(input: unknown): Promise<GovernanceResponse> {
  const parsed = z
    .object({ version: z.number().int().positive(), reason: z.string().min(10).max(500) })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "A reasoned retirement is required." };
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  if (!actor.viaPlatform) return { success: false, error: GLOBAL_PRIVACY_ERROR };
  const active = await db.riskKeyVersion.findFirst({ where: { status: "active" } });
  if (active?.version === parsed.data.version) {
    return { success: false, error: "The active key cannot be retired." };
  }
  await db.riskKeyVersion.update({
    where: { version: parsed.data.version },
    data: { status: "retired", retiredAt: new Date(), retiredById: actor.userId },
  });
  await controlEvent({
    level: "global",
    action: "key_retired",
    scopeId: String(parsed.data.version),
    actorId: actor.userId,
    reason: parsed.data.reason,
    outcome: "retired",
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// ENG-04 — retention sweep
// ---------------------------------------------------------------------------

/** True when an active hold still defers the deadline beyond `now`. */
function holdDefersDeletion(
  deadline: string,
  hold: { active: boolean; extensionUntil: string | null } | null,
  now: Date
): boolean {
  if (!hold?.active) return false;
  const effective = legalHoldDeadline(deadline, hold);
  return effective === null || new Date(effective).getTime() > now.getTime();
}

async function activeHold(
  scopeType: string,
  scopeId: string,
  tenantId?: string | null
): Promise<{ active: boolean; extensionUntil: string | null } | null> {
  const hold = await db.riskLegalHold.findFirst({
    where: {
      scopeType,
      scopeId,
      releasedAt: null,
      ...(tenantId ? { tenantId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  if (!hold) return null;
  return {
    active: true,
    extensionUntil: hold.extensionUntil?.toISOString() ?? null,
  };
}

/**
 * Expire open signals, then scrub or delete records whose retention deadline
 * has passed. Legal holds and open disputes block deletion. Non-identifying
 * audit metadata is preserved. Never touches MaaCash financial audit records.
 */
/**
 * Entry point for both scheduler and privacy-admin sweeps. The lease is
 * database-backed, so it serialises executions across processes and instances.
 */
export async function executeRetentionSweep(actorId: string): Promise<
  GovernanceResponse<{ expired: number; scrubbed: number; audited: number }>
> {
  const lease = await acquireJobLease(RETENTION_LEASE_KEY);
  if (!lease) {
    return {
      success: false,
      conflict: true,
      error: "Retention sweep is already running.",
    };
  }
  let outcome: "success" | "failed" | "lost" | "none" = "none";
  try {
    const result = await performRetentionMutations(actorId, lease);
    outcome = "success";
    return result;
  } catch (error) {
    if (error instanceof LeaseLostError) {
      outcome = "lost";
      return {
        success: false,
        conflict: true,
        error: "Retention execution lease was lost; no further changes were made.",
      };
    }
    outcome = "failed";
    throw error;
  } finally {
    await releaseJobLease(lease, outcome);
  }
}

/** The mutations themselves. Every destructive step is fenced first. */
async function performRetentionMutations(
  actorId: string,
  lease: JobLease
): Promise<
  GovernanceResponse<{ expired: number; scrubbed: number; audited: number }>
> {
  const assertLive = () => assertJobLease(lease);
  await assertLive();
  const now = new Date();
  const iso = now.toISOString();

  await assertLive();
  const expired = await db.agentRiskSignal.updateMany({
    where: { status: "open", expiresAt: { lte: now }, deletedAt: null },
    data: { status: "expired" },
  });

  let scrubbed = 0;
  const rows = await db.agentRiskSignal.findMany({
    where: { deletedAt: null, status: { in: ["expired", "withdrawn", "disputed_frozen", "frozen"] } },
    select: {
      id: true,
      status: true,
      expiresAt: true,
      withdrawnAt: true,
      resolvedAt: true,
      subjectKey: true,
      tenantId: true,
    },
    orderBy: { id: "asc" },
    take: 500,
  });
  for (const row of rows) {
    const deadline = signalDeletionDeadline({
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
      withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    });
    if (!deadline || new Date(deadline).getTime() > now.getTime()) continue;
    const hold = await activeHold("signal", row.id, row.tenantId);
    const subjectHold = await activeHold("subject", row.subjectKey, row.tenantId);
    if (
      holdDefersDeletion(deadline, hold, now) ||
      holdDefersDeletion(deadline, subjectHold, now)
    ) {
      continue;
    }
    // Fence every row: a stale owner must stop even mid-batch.
    await assertLive();
    // Non-identifying but unique: a fixed literal collides with the
    // (tenantId, subjectKey, sourceType, sourceId) unique constraint and aborts
    // a multi-row sweep. The signal id is not personal data.
    await db.agentRiskSignal.update({
      where: { id: row.id },
      data: {
        subjectKey: `scrubbed:${row.id}`,
        internalNote: null,
        sourceId: `scrubbed:${row.id}`,
        scrubbedAt: now,
        deletedAt: now,
      },
    });
    scrubbed += 1;
  }

  let audited = 0;
  const disclosures = await db.riskIntelligenceDisclosure.findMany({
    where: { deletedAt: null },
    select: { id: true, createdAt: true, subjectKey: true },
    orderBy: { id: "asc" },
    take: 500,
  });
  for (const disclosure of disclosures) {
    const deadline = riskAuditDeletionDeadline(disclosure.createdAt.toISOString());
    if (new Date(deadline).getTime() > now.getTime()) continue;
    await assertLive();
    await db.riskIntelligenceDisclosure.update({
      where: { id: disclosure.id },
      data: { subjectKey: "scrubbed", deletedAt: now },
    });
    audited += 1;
  }

  // Legal holds whose case closed more than 14 days ago must be reviewed.
  const dueHolds = await db.riskLegalHold.findMany({
    where: { releasedAt: null, caseClosureDate: { not: null } },
  });
  for (const hold of dueHolds) {
    if (!hold.caseClosureDate) continue;
    if (
      legalHoldReviewDue(hold.caseClosureDate.toISOString(), iso, hold.releasedAt?.toISOString() ?? null)
    ) {
      const reason = `Legal hold ${hold.dpoReference} needs review after case closure.`;
      // One open review notice per hold/case-closure cycle. Without this check
      // every duplicate sweep appended another control event (F4).
      const existing = await db.riskControlEvent.findFirst({
        where: {
          level: "subject",
          action: "legal_hold_review_due",
          scopeId: hold.scopeId,
          tenantId: hold.tenantId,
          reason,
          createdAt: { gte: hold.caseClosureDate },
        },
        select: { id: true },
      });
      if (existing) continue;
      await assertLive();
      await db.riskControlEvent.create({
        data: {
          level: "subject",
          action: "legal_hold_review_due",
          scopeId: hold.scopeId,
          tenantId: hold.tenantId,
          actorId,
          reason,
          outcome: "review_due",
        },
      });
    }
  }

  if (expired.count || scrubbed || audited) {
    await assertLive();
    await createAuditLog({
      userId: actorId,
      action: "risk_intelligence.retention_sweep",
      entityType: "agentRiskSignal",
      details: {
        expired: expired.count,
        scrubbed,
        audited,
        at: iso,
        financialMutation: false,
        // Random UUID and fencing counter; no secret or personal data.
        leaseOwner: lease.ownerId,
        fencingToken: lease.fencingToken,
      },
    });
  }
  return { success: true, data: { expired: expired.count, scrubbed, audited } };
}

/** Administrator-initiated sweep. Requires the restricted privacy grant. */
export async function runRiskRetentionSweep(): Promise<
  GovernanceResponse<{ expired: number; scrubbed: number; audited: number }>
> {
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  if (!actor.viaPlatform) return { success: false, error: GLOBAL_PRIVACY_ERROR };
  return executeRetentionSweep(actor.userId);
}

/**
 * Scheduler-triggered sweep. The token is a separate internal secret, never
 * a user credential, and the route is disabled until it is configured.
 */
export async function runSystemRiskRetentionSweep(input: unknown): Promise<
  GovernanceResponse<{ expired: number; scrubbed: number; audited: number }>
> {
  if (!verifyRiskRetentionToken(input)) {
    return { success: false, error: "Not configured or forbidden." };
  }
  return executeRetentionSweep("system:risk_retention");
}

/** Grant or revoke restricted privacy access. Owner/administrator decision. */
export async function setPrivacyAccess(input: unknown): Promise<GovernanceResponse> {
  const actor = await requirePrivacyActor();
  if (!actor) return { success: false, error: "Privacy review access is restricted." };
  const parsed = z
    .object({
      userId: z.string().min(1),
      role: z.enum(["privacy_admin", "privacy_reviewer"]),
      active: z.boolean(),
      reason: z.string().min(10).max(500),
    })
    .safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid access grant." };
  if (!isPrivacyAdministrator(actor.role)) {
    return { success: false, error: "Only a privacy administrator can change privacy access." };
  }
  const target = await db.user.findUnique({
    where: { id: parsed.data.userId },
    select: { role: true, status: true, tenantId: true },
  });
  if (!target || target.role !== "admin" || target.status !== "active") {
    return { success: false, error: "Privacy access can only be granted to an active administrator." };
  }
  if (!actor.viaPlatform && (!actor.tenantId || target.tenantId !== actor.tenantId)) {
    return { success: false, error: "A business privacy administrator can only manage access inside that business." };
  }
  await db.riskPrivacyAccess.upsert({
    where: { userId: parsed.data.userId },
    update: {
      role: parsed.data.role,
      active: parsed.data.active,
      revokedAt: parsed.data.active ? null : new Date(),
      reason: parsed.data.reason,
      grantedById: actor.userId,
    },
    create: {
      userId: parsed.data.userId,
      role: parsed.data.role,
      active: parsed.data.active,
      reason: parsed.data.reason,
      grantedById: actor.userId,
    },
  });
  await controlEvent({
    level: "global",
    action: "privacy_access_changed",
    scopeId: parsed.data.userId,
    tenantId: target.tenantId ?? undefined,
    actorId: actor.userId,
    reason: parsed.data.reason,
    outcome: parsed.data.active ? "granted" : "revoked",
    history: { role: parsed.data.role },
  });
  return { success: true };
}
