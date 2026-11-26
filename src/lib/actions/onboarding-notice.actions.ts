"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { getMomoSession, getSusuSession } from "@/lib/auth";
import { createAuditLog } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { NOTICE_ACKNOWLEDGEMENT_IS_NOT_CONSENT } from "@/lib/risk-intelligence/notices";
import {
  resolveEffectiveNotice,
  type EffectiveNotice,
} from "@/lib/risk-intelligence/notice-resolution";

/**
 * Agent-facing notice workflow. The agent reads the exact notice text and
 * records an explicit acknowledgement. Delivery evidence was recorded when the
 * account was created; acknowledgement is a separate act by the agent.
 */

async function agentSession() {
  const momo = await getMomoSession();
  if (momo && (momo.role === "worker" || momo.role === "collector")) return momo;
  const susu = await getSusuSession();
  if (susu && (susu.role === "worker" || susu.role === "collector")) return susu;
  return null;
}

export interface OnboardingNoticeView {
  version: string;
  title: string;
  documentText: string;
  documentHash: string;
  policyVersion: string;
  statement: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  /** True when no owner-published notice exists and the statutory fallback is shown. */
  provisional: boolean;
}

export async function getMyOnboardingNotice(): Promise<{
  success: boolean;
  error?: string;
  data?: OnboardingNoticeView;
}> {
  const session = await agentSession();
  if (!session?.userId) return { success: false, error: "Not authenticated." };
  let effective: EffectiveNotice;
  try {
    effective = await resolveEffectiveNotice(session.tenantId, session.userId);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "The privacy notice is not ready.",
    };
  }
  const attestation = await db.employeeNoticeAttestation.findFirst({
    where: {
      tenantId: session.tenantId ?? "",
      userId: session.userId,
      noticeVersion: effective.version,
      acknowledgementState: "acknowledged",
    },
    select: { acknowledgedAt: true, policyVersion: true, documentSha256: true },
  });
  const acknowledged = Boolean(
    attestation?.acknowledgedAt &&
      attestation.policyVersion === effective.policyVersion &&
      attestation.documentSha256 === effective.documentHash
  );
  return {
    success: true,
    data: {
      ...effective,
      statement: NOTICE_ACKNOWLEDGEMENT_IS_NOT_CONSENT,
      acknowledged,
      acknowledgedAt: acknowledged ? attestation!.acknowledgedAt!.toISOString() : null,
      provisional: effective.provisional,
    },
  };
}

const acknowledgeSchema = z.object({
  version: z.string().min(1),
  confirmed: z.boolean().refine((value) => value === true, {
    message: "You must confirm that you have read the notice.",
  }),
});

export async function acknowledgeOnboardingNotice(
  input: unknown
): Promise<{ success: boolean; error?: string }> {
  const parsed = acknowledgeSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid acknowledgement." };
  }
  const session = await agentSession();
  if (!session?.userId || !session.tenantId) {
    return { success: false, error: "Not authenticated." };
  }
  let effective: EffectiveNotice;
  try {
    effective = await resolveEffectiveNotice(session.tenantId, session.userId);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "The privacy notice is not ready.",
    };
  }
  if (effective.version !== parsed.data.version) {
    return { success: false, error: "The notice changed. Read the current version again." };
  }
  await db.employeeNoticeAttestation.upsert({
    where: {
      tenantId_userId_noticeVersion: {
        tenantId: session.tenantId,
        userId: session.userId,
        noticeVersion: effective.version,
      },
    },
    update: {
      acknowledgementState: "acknowledged",
      acknowledgedAt: new Date(),
      deliveryMethod: "portal_acknowledgement",
      deliveryEvidence: "first_login_portal_acknowledgement",
      verified: true,
      verifiedAt: new Date(),
      recordedById: session.userId,
      policyVersion: effective.policyVersion,
      documentSha256: effective.documentHash,
    },
    create: {
      tenantId: session.tenantId ?? "",
      userId: session.userId,
      noticeVersion: effective.version,
      acknowledgementState: "acknowledged",
      acknowledgedAt: new Date(),
      deliveryMethod: "portal_acknowledgement",
      issuedAt: new Date(),
      deliveryEvidence: "first_login_portal_acknowledgement",
      verified: true,
      verifiedAt: new Date(),
      recordedById: session.userId,
      policyVersion: effective.policyVersion,
      documentSha256: effective.documentHash,
    },
  });
  await createAuditLog({
    tenantId: session.tenantId,
    userId: session.userId,
    action: "risk_notice.agent_acknowledged",
    entityType: "employeeNoticeAttestation",
    entityId: session.userId,
    details: {
      noticeVersion: effective.version,
      documentSha256: effective.documentHash,
      provisional: effective.provisional,
      statement: NOTICE_ACKNOWLEDGEMENT_IS_NOT_CONSENT,
      financialMutation: false,
    },
  });
  revalidatePath("/worker/first-login");
  revalidatePath("/worker/privacy-notice");
  return { success: true };
}
