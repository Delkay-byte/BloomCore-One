"use server";

import { db } from "@/lib/db";
import { requireTenantAdminMomo } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import {
  buildEvidenceForFinding,
  DRAFT_VERSIONS,
  externalGenerationAllowed,
  generateDraftForEvidence,
  investigationDisabled,
} from "@/lib/zeli/investigation/service";
import type { InvestigationEvidence } from "@/lib/zeli/investigation/evidence";
import {
  decideReview,
  DRAFT_STATUS_LABELS,
  type DraftStatus,
  type ReviewDecision,
} from "@/lib/zeli/investigation/review";
import { validateDraft, type InvestigationDraftPayload } from "@/lib/zeli/investigation/schema";
import {
  AI_INVESTIGATION_DEFAULT_MONTHLY_LIMIT,
  consumeAiInvestigationAllowance,
  resolveAiInvestigationAccess,
  type AiInvestigationAccess,
} from "@/lib/zeli/investigation/entitlement";

/**
 * The AI investigation layer under the owner's package-only approval.
 *
 * External processing needs a genuinely paid AI Investigation package, a live Super
 * Admin activation, an authorised role and an unused allowance — all read from the
 * database on each request. Everything here produces an explanation for a person to
 * review. No function can change a finding, a transaction, a count or a balance, and
 * accepting a draft records a decision about wording, not about money.
 */

export interface AiInvestigationState {
  /** The single switch that stops generation everywhere. */
  disabled: boolean;
  /** True when this deployment may call an external provider at all. */
  externalApproved: boolean;
  /** The live per-business decision: paid package, activation, quota, role. */
  access: AiInvestigationAccess;
  promptVersion: string;
  schemaVersion: string;
  aiCreatesFinancialRecords: false;
  aiResolvesFindings: false;
}

export interface DraftView {
  id: string;
  anomalyId: string;
  evidenceHash: string;
  promptVersion: string;
  schemaVersion: string;
  source: string;
  model: string;
  status: DraftStatus;
  statusLabel: string;
  generatedById: string | null;
  generatedByName: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewReason: string | null;
  createdAt: string;
  payload: InvestigationDraftPayload;
  /** True when the stored payload no longer validates against its own evidence. */
  payloadValid: boolean;
}

export interface InvestigationAiResponse {
  success: boolean;
  error?: string;
  data?: {
    /** Only returned when the package gates allow this business to use the feature. */
    evidence: InvestigationEvidence | null;
    drafts: DraftView[];
    state: AiInvestigationState;
  };
}

function state(access: AiInvestigationAccess): AiInvestigationState {
  return {
    disabled: investigationDisabled(),
    externalApproved: externalGenerationAllowed(),
    access,
    promptVersion: DRAFT_VERSIONS.promptVersion,
    schemaVersion: DRAFT_VERSIONS.schemaVersion,
    aiCreatesFinancialRecords: false,
    aiResolvesFindings: false,
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function draftViews(
  tenantId: string,
  anomalyId: string,
  evidence: InvestigationEvidence
): Promise<DraftView[]> {
  const rows = await db.anomalyInvestigationDraft.findMany({
    where: { tenantId, anomalyId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const ids = Array.from(
    new Set(
      rows
        .flatMap((row) => [row.generatedById, row.reviewedById])
        .filter((id): id is string => Boolean(id))
    )
  );
  const people =
    ids.length > 0
      ? await db.user.findMany({
          where: { tenantId, id: { in: ids } },
          select: { id: true, fullName: true },
        })
      : [];
  const names = new Map(people.map((row) => [row.id, row.fullName]));

  return rows.map((row) => {
    const raw = safeJson(row.payload);
    const validation = validateDraft({ raw, evidence });
    return {
      id: row.id,
      anomalyId: row.anomalyId,
      evidenceHash: row.evidenceHash,
      promptVersion: row.promptVersion,
      schemaVersion: row.schemaVersion,
      source: row.source,
      model: row.model,
      status: row.status as DraftStatus,
      statusLabel:
        DRAFT_STATUS_LABELS[row.status as DraftStatus] ?? row.status,
      generatedById: row.generatedById,
      generatedByName: names.get(row.generatedById) ?? null,
      reviewedByName: row.reviewedById ? names.get(row.reviewedById) ?? null : null,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      reviewReason: row.reviewReason,
      createdAt: row.createdAt.toISOString(),
      payload: validation.payload ?? (raw as InvestigationDraftPayload),
      payloadValid: validation.ok,
    };
  });
}

/** The evidence an explanation would be written from, plus any existing drafts. */
/**
 * Read the feature state for one business and finding.
 *
 * The evidence pack and any drafts are returned only when the paid package gates
 * allow it. Otherwise the caller gets the guidance a tenant administrator can act on
 * — purchase the package, wait for payment, or ask a Super Admin to activate — and no
 * evidence at all.
 */
export async function getInvestigationAi(anomalyId: string): Promise<InvestigationAiResponse> {
  const ctx = await requireTenantAdminMomo();
  const access = await resolveAiInvestigationAccess(ctx.tenantId, ctx.role, {
    operatorDisabled: investigationDisabled(),
  });

  if (!access.allowed) {
    const exists = await db.operationalAnomaly.findFirst({
      where: { id: anomalyId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!exists) return { success: false, error: "Finding not found." };
    return {
      success: true,
      data: { evidence: null, drafts: [], state: state(access) },
    };
  }

  const built = await buildEvidenceForFinding(ctx.tenantId, anomalyId);
  if (!built.success || !built.data) {
    return { success: false, error: built.error ?? "The evidence could not be assembled." };
  }
  const drafts = await draftViews(ctx.tenantId, anomalyId, built.data);
  return { success: true, data: { evidence: built.data, drafts, state: state(access) } };
}

/**
 * Generate a draft for one finding.
 *
 * The evidence is rebuilt here rather than trusted from the browser, so a caller
 * cannot ask for an explanation of another business's finding or of an evidence pack
 * it assembled itself.
 */
export async function generateInvestigationDraft(anomalyId: string): Promise<{
  success: boolean;
  error?: string;
  data?: { draftId: string; source: "deterministic" | "external"; fallbackReason: string | null };
}> {
  const ctx = await requireTenantAdminMomo();
  if (investigationDisabled()) {
    return { success: false, error: "AI investigation is switched off for this deployment." };
  }

  // The gates are resolved here, on this request, from the database. Nothing from the
  // browser and nothing cached can stand in for them.
  const access = await resolveAiInvestigationAccess(ctx.tenantId, ctx.role, {
    operatorDisabled: investigationDisabled(),
  });
  if (!access.allowed) {
    return { success: false, error: access.guidance };
  }

  const built = await buildEvidenceForFinding(ctx.tenantId, anomalyId);
  if (!built.success || !built.data) {
    return { success: false, error: built.error ?? "The evidence could not be assembled." };
  }
  const generated = await generateDraftForEvidence(built.data, { allowExternal: true });
  if (!generated.success || !generated.data) {
    return { success: false, error: generated.error ?? "The draft was rejected." };
  }

  const draft = await db.$transaction(async (tx) => {
    const created = await tx.anomalyInvestigationDraft.create({
      data: {
        tenantId: ctx.tenantId,
        anomalyId,
        evidenceHash: generated.data!.evidenceHash,
        evidence: JSON.stringify(built.data),
        promptVersion: DRAFT_VERSIONS.promptVersion,
        schemaVersion: DRAFT_VERSIONS.schemaVersion,
        source: generated.data!.source,
        model: generated.data!.model,
        payload: JSON.stringify(generated.data!.payload),
        generatedById: ctx.userId,
      },
      select: { id: true },
    });
    await tx.anomalyFindingEvent.create({
      data: {
        tenantId: ctx.tenantId,
        anomalyId,
        kind: "commented",
        note: `An explanation draft was generated from evidence ${generated.data!.evidenceHash.slice(0, 16)}.`,
        actorId: ctx.userId,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "anomaly.ai_draft_generated",
      entityType: "anomalyInvestigationDraft",
      entityId: created.id,
      details: {
        anomalyId,
        evidenceHash: generated.data!.evidenceHash,
        promptVersion: DRAFT_VERSIONS.promptVersion,
        schemaVersion: DRAFT_VERSIONS.schemaVersion,
        source: generated.data!.source,
        model: generated.data!.model,
        planCode: access.planCode,
        activationStatus: access.activationStatus,
        fallbackReason: generated.data!.fallbackReason,
        aiCreatedFinancialRecord: false,
      },
    });
    return created;
  });

  await consumeAiInvestigationAllowance(
    ctx.tenantId,
    access.allowance ?? AI_INVESTIGATION_DEFAULT_MONTHLY_LIMIT
  );

  return {
    success: true,
    data: {
      draftId: draft.id,
      source: generated.data!.source,
      fallbackReason: generated.data!.fallbackReason,
    },
  };
}

/**
 * Review a draft: accept, reject or ask for changes.
 *
 * The reviewer must not be the person who generated it, a reason is required, and
 * the decision is written to the finding history and the audit log. Accepting never
 * resolves the finding — the money decision stays with the investigation.
 */
export async function reviewInvestigationDraft(input: {
  draftId: string;
  decision: ReviewDecision;
  reason: string;
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await requireTenantAdminMomo();
  const draft = await db.anomalyInvestigationDraft.findFirst({
    where: { id: input.draftId, tenantId: ctx.tenantId },
    select: {
      id: true,
      anomalyId: true,
      status: true,
      generatedById: true,
      evidence: true,
      evidenceHash: true,
    },
  });
  if (!draft) return { success: false, error: "That draft was not found." };

  const transition = decideReview({
    status: draft.status as DraftStatus,
    decision: input.decision,
    reason: input.reason ?? "",
    reviewerIsAuthor: draft.generatedById === ctx.userId,
  });
  if (!transition.allowed || !transition.nextStatus) {
    return { success: false, error: transition.error ?? "That decision is not allowed." };
  }

  const evidence = safeJson(draft.evidence);
  const stillMatches =
    evidence && typeof evidence === "object"
      ? (evidence as InvestigationEvidence).packHash === draft.evidenceHash
      : false;
  if (!stillMatches) {
    return {
      success: false,
      error: "The stored evidence does not match its hash, so this draft cannot be accepted.",
    };
  }

  await db.$transaction(async (tx) => {
    await tx.anomalyInvestigationDraft.update({
      where: { id: draft.id },
      data: {
        status: transition.nextStatus,
        reviewedById: ctx.userId,
        reviewedAt: new Date(),
        reviewReason: input.reason.trim(),
      },
    });
    await tx.anomalyFindingEvent.create({
      data: {
        tenantId: ctx.tenantId,
        anomalyId: draft.anomalyId,
        kind: "commented",
        note: `An explanation draft was ${transition.nextStatus} by a reviewer: ${input.reason.trim().slice(0, 200)}`,
        actorId: ctx.userId,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "anomaly.ai_draft_reviewed",
      entityType: "anomalyInvestigationDraft",
      entityId: draft.id,
      details: {
        anomalyId: draft.anomalyId,
        decision: input.decision,
        status: transition.nextStatus,
        evidenceHash: draft.evidenceHash,
        reason: input.reason.trim().slice(0, 500),
        findingChanged: false,
      },
    });
    // Accepting an explanation must not close the finding. This is asserted here so
    // a later refactor has to delete the line rather than silently change behaviour.
    if (transition.affectsFinding !== false) {
      throw new Error("A draft decision must never change a finding.");
    }
  });

  return { success: true };
}
