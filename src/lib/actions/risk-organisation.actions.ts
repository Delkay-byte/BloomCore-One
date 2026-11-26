"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getAdminSession } from "@/lib/auth";
import { createPlatformAuditLog } from "@/lib/platform-audit";
import { requirePlatformAdmin } from "@/lib/platform-auth";

export interface OrganisationResponse<T = undefined> {
  success: boolean;
  error?: string;
  data?: T;
}

async function tenantPrivacyActor(): Promise<{
  userId: string;
  role: string;
  tenantId: string | null;
} | null> {
  try {
    const session = await getAdminSession();
    if (!session?.userId) return null;
    const grant = await db.riskPrivacyAccess.findFirst({
      where: { userId: session.userId, active: true },
      select: { role: true },
    });
    return grant
      ? { userId: session.userId, role: grant.role, tenantId: session.tenantId ?? null }
      : null;
  } catch {
    return null;
  }
}

async function platformActor(): Promise<{ adminId: string; email: string } | null> {
  try {
    const session = await requirePlatformAdmin();
    return { adminId: session.adminId, email: session.email };
  } catch {
    return null;
  }
}

async function organisationEditor(): Promise<
  | { kind: "tenant"; userId: string; role: string }
  | { kind: "platform"; adminId: string; email: string }
  | null
> {
  const privacy = await tenantPrivacyActor();
  if (privacy) return { kind: "tenant", ...privacy };
  const platform = await platformActor();
  if (platform) return { kind: "platform", ...platform };
  return null;
}

function revalidateOrganisation() {
  revalidatePath("/privacy");
  revalidatePath("/admin/privacy-review");
  revalidatePath("/admin/agreements");
  revalidatePath("/platform/risk-access");
}

const settingsSchema = z.object({
  registeredOffice: z.string().trim().max(300).default(""),
  registeredOfficeConfirmed: z.boolean().default(false),
  privacyEmail: z.union([z.literal(""), z.string().trim().email().max(200)]).default(""),
  signatoryName: z.string().trim().max(200).default(""),
  signatoryCapacity: z.string().trim().max(200).default(""),
  hostingProviders: z.string().trim().max(500).default(""),
  hostingRegions: z.string().trim().max(500).default(""),
  reason: z.string().trim().min(10).max(500),
});

export async function setRiskOrganisationSettings(
  input: unknown
): Promise<OrganisationResponse> {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Check each field and give a reason of at least 10 characters." };
  }
  const actor = await organisationEditor();
  if (!actor) {
    return { success: false, error: "Only an authorised privacy administrator or a platform administrator can change these details." };
  }
  const data = parsed.data;
  if (data.registeredOfficeConfirmed && !data.registeredOffice) {
    return { success: false, error: "Confirm the registered office only when an address is entered." };
  }
  if (Boolean(data.signatoryName) !== Boolean(data.signatoryCapacity)) {
    return { success: false, error: "Enter both the authorised signatory name and capacity, or neither." };
  }
  if (Boolean(data.hostingProviders) !== Boolean(data.hostingRegions)) {
    return { success: false, error: "Enter both the hosting providers and their regions, or neither." };
  }

  const actorId = actor.kind === "tenant" ? actor.userId : actor.adminId;
  const now = new Date();
  try {
    await db.$transaction(async (tx) => {
      await tx.riskOrganisationProfile.upsert({
        where: { id: "bloomcore" },
        update: {
          registeredOffice: data.registeredOffice || null,
          registeredOfficeConfirmed: Boolean(data.registeredOffice && data.registeredOfficeConfirmed),
          privacyEmail: data.privacyEmail || null,
          signatoryName: data.signatoryName || null,
          signatoryCapacity: data.signatoryCapacity || null,
          hostingProviders: data.hostingProviders || null,
          hostingRegions: data.hostingRegions || null,
          updatedById: actorId,
        },
        create: {
          id: "bloomcore",
          registeredOffice: data.registeredOffice || null,
          registeredOfficeConfirmed: Boolean(data.registeredOffice && data.registeredOfficeConfirmed),
          privacyEmail: data.privacyEmail || null,
          signatoryName: data.signatoryName || null,
          signatoryCapacity: data.signatoryCapacity || null,
          hostingProviders: data.hostingProviders || null,
          hostingRegions: data.hostingRegions || null,
          updatedById: actorId,
        },
      });
      await tx.riskControlEvent.create({
        data: {
          level: "global",
          action: "organisation_profile_updated",
          actorId,
          reason: data.reason,
          outcome: "updated",
          history: JSON.stringify({
            source: actor.kind,
            signatoryConfigured: Boolean(data.signatoryName && data.signatoryCapacity),
            officeConfirmed: Boolean(data.registeredOffice && data.registeredOfficeConfirmed),
            privacyEmailConfigured: Boolean(data.privacyEmail),
            hostingConfigured: Boolean(data.hostingProviders && data.hostingRegions),
            changedAt: now.toISOString(),
          }),
        },
      });
    });
  } catch {
    return {
      success: false,
      error: "The organisation profile table is unavailable. Apply the additive 20261224 migration and retry.",
    };
  }
  if (actor.kind === "platform") {
    await createPlatformAuditLog({
      actorId: actor.adminId,
      actorEmail: actor.email,
      action: "risk.organisation_profile_updated",
      entityType: "RiskOrganisationProfile",
      entityId: "bloomcore",
      reason: data.reason,
      details: { signatoryConfigured: Boolean(data.signatoryName && data.signatoryCapacity) },
    });
  }
  revalidateOrganisation();
  return { success: true };
}

const accessSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["privacy_admin", "privacy_reviewer"]),
  reason: z.string().trim().min(20).max(500),
});

/**
 * Platform-owner grant of a restricted privacy role to an existing active
 * tenant administrator. This is not a DPO/DPS appointment: no account is
 * created, no external approval is required, and participation does not wait
 * for a grant. The grant only exposes the least-privilege privacy console.
 */
export async function grantRiskPrivacyAccess(
  input: unknown
): Promise<OrganisationResponse<{ userId: string; role: string }>> {
  const parsed = accessSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Select an active administrator, a role and give a reason of at least 20 characters." };
  }
  const platform = await platformActor();
  if (!platform) {
    return { success: false, error: "Only a platform administrator can grant privacy access." };
  }
  const target = await db.user.findUnique({
    where: { id: parsed.data.userId },
    select: { id: true, role: true, status: true, tenantId: true },
  });
  if (!target || !target.tenantId || target.role !== "admin" || target.status !== "active") {
    return { success: false, error: "Privacy access can only be granted to an existing active tenant administrator." };
  }
  await db.$transaction(async (tx) => {
    await tx.riskPrivacyAccess.upsert({
      where: { userId: target.id },
      update: {
        role: parsed.data.role,
        grantedById: platform.adminId,
        reason: parsed.data.reason,
        active: true,
        revokedAt: null,
      },
      create: {
        userId: target.id,
        role: parsed.data.role,
        grantedById: platform.adminId,
        reason: parsed.data.reason,
      },
    });
    await tx.riskControlEvent.create({
      data: {
        level: "global",
        action: "privacy_access_granted",
        scopeId: target.id,
        tenantId: target.tenantId,
        actorId: platform.adminId,
        reason: parsed.data.reason,
        outcome: parsed.data.role,
        history: JSON.stringify({ source: "platform_owner" }),
      },
    });
  });
  await createPlatformAuditLog({
    actorId: platform.adminId,
    actorEmail: platform.email,
    action: "risk.privacy_access_granted",
    tenantId: target.tenantId,
    entityType: "RiskPrivacyAccess",
    entityId: target.id,
    reason: parsed.data.reason,
    details: { role: parsed.data.role },
  });
  revalidateOrganisation();
  revalidatePath("/platform/audit");
  return { success: true, data: { userId: target.id, role: parsed.data.role } };
}

const revokeSchema = z.object({
  userId: z.string().min(1),
  reason: z.string().trim().min(10).max(500),
});

export async function revokeRiskPrivacyAccess(
  input: unknown
): Promise<OrganisationResponse> {
  const parsed = revokeSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "A reasoned revocation is required." };
  const platform = await platformActor();
  if (!platform) {
    return { success: false, error: "Only a platform administrator can revoke privacy access." };
  }
  const target = await db.riskPrivacyAccess.findUnique({
    where: { userId: parsed.data.userId },
    select: { userId: true, role: true, active: true },
  });
  if (!target || !target.active) return { success: false, error: "No active grant was found." };
  await db.$transaction(async (tx) => {
    await tx.riskPrivacyAccess.update({
      where: { userId: target.userId },
      data: { active: false, revokedAt: new Date() },
    });
    await tx.riskControlEvent.create({
      data: {
        level: "global",
        action: "privacy_access_revoked",
        scopeId: target.userId,
        actorId: platform.adminId,
        reason: parsed.data.reason,
        outcome: target.role,
      },
    });
  });
  await createPlatformAuditLog({
    actorId: platform.adminId,
    actorEmail: platform.email,
    action: "risk.privacy_access_revoked",
    entityType: "RiskPrivacyAccess",
    entityId: target.userId,
    reason: parsed.data.reason,
    details: { role: target.role },
  });
  revalidateOrganisation();
  revalidatePath("/platform/audit");
  return { success: true };
}
