"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  getTenantContext,
  requireTenantAdmin,
  type TenantContext,
} from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import {
  DEFAULT_OPERATIONAL_POLICY,
  actorProofSummary,
  effectiveIdleLockMinutes,
  shiftPolicySummary,
  tenantPolicySchema,
  type TenantOperationalPolicyValues,
} from "@/lib/tenant-policy";

export interface PolicyActionResponse {
  success: boolean;
  error?: string;
}

export interface OperationalPolicyView extends TenantOperationalPolicyValues {
  /** Minutes the offline workspace stays unlocked when idle. */
  effectiveIdleLockMinutes: number;
  shiftSummary: string;
  actorProofSummary: string;
  updatedAt: string | null;
  updatedByName: string | null;
  /** True when the row has never been written, so the defaults are in force. */
  usingDefaults: boolean;
}

/**
 * The business-wide operational policy.
 *
 * Reading is safe for any administrator of the business and returns the
 * product defaults when no row exists, so callers never have to guess.
 */
export async function getOperationalPolicy(): Promise<OperationalPolicyView> {
  const ctx = await requireTenantAdmin();
  return loadPolicy(ctx);
}

async function loadPolicy(ctx: TenantContext): Promise<OperationalPolicyView> {
  const row = await db.tenantOperationalPolicy.findFirst({
    where: { tenantId: ctx.tenantId },
  });
  if (!row) {
    return {
      ...DEFAULT_OPERATIONAL_POLICY,
      effectiveIdleLockMinutes: effectiveIdleLockMinutes(
        DEFAULT_OPERATIONAL_POLICY.offlineIdleLockMinutes
      ),
      shiftSummary: shiftPolicySummary(DEFAULT_OPERATIONAL_POLICY.shiftsRequired),
      actorProofSummary: actorProofSummary(DEFAULT_OPERATIONAL_POLICY.actorProofForSensitiveCounts),
      updatedAt: null,
      updatedByName: null,
      usingDefaults: true,
    };
  }
  const updatedBy = row.updatedById
    ? await db.user.findFirst({
        where: { id: row.updatedById, tenantId: ctx.tenantId },
        select: { fullName: true },
      })
    : null;
  return {
    shiftsRequired: row.shiftsRequired,
    actorProofForSensitiveCounts: row.actorProofForSensitiveCounts,
    offlineIdleLockMinutes: row.offlineIdleLockMinutes,
    effectiveIdleLockMinutes: effectiveIdleLockMinutes(row.offlineIdleLockMinutes),
    note: row.note,
    shiftSummary: shiftPolicySummary(row.shiftsRequired),
    actorProofSummary: actorProofSummary(row.actorProofForSensitiveCounts),
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: updatedBy?.fullName ?? null,
    usingDefaults: false,
  };
}

/**
 * Save the operational policy.
 *
 * Both switches change what the product enforces, so the change is audited with
 * the previous and the new values. It does not touch any financial record.
 */
export async function saveOperationalPolicy(input: unknown): Promise<PolicyActionResponse> {
  const ctx = await requireTenantAdmin();
  const parsed = tenantPolicySchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the policy settings." };
  }
  const data = parsed.data;

  try {
    await db.$transaction(async (tx) => {
      const existing = await tx.tenantOperationalPolicy.findFirst({
        where: { tenantId: ctx.tenantId },
      });
      if (existing) {
        await tx.tenantOperationalPolicy.update({
          where: { id: existing.id },
          data: {
            shiftsRequired: data.shiftsRequired,
            actorProofForSensitiveCounts: data.actorProofForSensitiveCounts,
            offlineIdleLockMinutes: data.offlineIdleLockMinutes ?? null,
            note: data.note?.trim() || null,
            updatedById: ctx.userId,
          },
        });
      } else {
        await tx.tenantOperationalPolicy.create({
          data: {
            tenantId: ctx.tenantId,
            shiftsRequired: data.shiftsRequired,
            actorProofForSensitiveCounts: data.actorProofForSensitiveCounts,
            offlineIdleLockMinutes: data.offlineIdleLockMinutes ?? null,
            note: data.note?.trim() || null,
            updatedById: ctx.userId,
          },
        });
      }

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "tenant.operational_policy_changed",
        entityType: "tenantOperationalPolicy",
        entityId: ctx.tenantId,
        details: {
          shiftsRequired: {
            from: existing?.shiftsRequired ?? DEFAULT_OPERATIONAL_POLICY.shiftsRequired,
            to: data.shiftsRequired,
          },
          actorProofForSensitiveCounts: {
            from:
              existing?.actorProofForSensitiveCounts ??
              DEFAULT_OPERATIONAL_POLICY.actorProofForSensitiveCounts,
            to: data.actorProofForSensitiveCounts,
          },
          offlineIdleLockMinutes: {
            from: existing?.offlineIdleLockMinutes ?? null,
            to: data.offlineIdleLockMinutes ?? null,
          },
          note: data.note?.trim() || null,
          financialMutation: false,
        },
      });
    });
  } catch {
    return { success: false, error: "The policy could not be saved. Try again." };
  }

  revalidatePath("/admin/policy");
  revalidatePath("/admin/settings");
  revalidatePath("/worker/daily");
  revalidatePath("/admin/shifts");
  return { success: true };
}

/** Read the policy for a tenant without a session, for server-side enforcement. */
export async function readTenantPolicy(
  tenantId: string
): Promise<TenantOperationalPolicyValues> {
  const row = await db.tenantOperationalPolicy.findFirst({ where: { tenantId } });
  if (!row) return DEFAULT_OPERATIONAL_POLICY;
  return {
    shiftsRequired: row.shiftsRequired,
    actorProofForSensitiveCounts: row.actorProofForSensitiveCounts,
    offlineIdleLockMinutes: row.offlineIdleLockMinutes,
    note: row.note,
  };
}

/**
 * The idle-lock minutes for the signed-in user's business.
 *
 * Any authenticated module may read this: it is a lock duration, not a secret,
 * and the device needs it before it can hold customer data. It never redirects —
 * a background bootstrap must not navigate the tab — so a missing session simply
 * leaves the product default in force.
 */
export async function getOfflineIdleLockMinutes(): Promise<number> {
  const ctx =
    (await getTenantContext("susu", "susu")) ??
    (await getTenantContext("momo", "momo")) ??
    (await getTenantContext("admin", "momo")) ??
    (await getTenantContext("admin", "susu"));
  if (!ctx) return effectiveIdleLockMinutes(null);
  const policy = await readTenantPolicy(ctx.tenantId);
  return effectiveIdleLockMinutes(policy.offlineIdleLockMinutes);
}
