"use server";

/**
 * Collector lifecycle management for MaaCash Susu.
 *
 * All mutations resolve the tenant from the verified session and assert tenant
 * ownership before touching any record. A collector's lifecycle status
 * (active | inactive | suspended) is preserved together with who changed it,
 * why, and when — suspended and inactive collectors must not perform new
 * collection operations.
 *
 * Created by Agent 2 (Phase 2: Collector Management and Field Operations).
 * Compatible with Agent 1's Phase 1 branch model: no duplicate branch model,
 * no client-trusted branch ids.
 */

import { db } from "@/lib/db";
import { getAdminSession } from "@/lib/auth";
import { createAuditLogTx } from "@/lib/audit";
import {
  requireTenantAdminSusu,
  assertTenantEntity,
} from "@/lib/tenant";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { claimStepUpGrant, StepUpDeniedError } from "@/lib/security/step-up";
import { stepUpSessionBinding } from "@/lib/security/step-up";

interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface CollectorLifecycleView {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  phone?: string | null;
  status: string;
  statusReason?: string | null;
  statusChangedAt?: Date | null;
  statusChangedById?: string | null;
  createdAt: Date;
  assignments: Array<{ id: string; customerId: string; accountId: string; active: boolean }>;
}

/**
 * Documented collector lifecycle states.
 *
 *   active     — may perform new collection operations.
 *   inactive   — employment state; may not collect. Preserved as a distinct
 *                state from suspension; either way collection is blocked.
 *   suspended  — control action (e.g. pending investigation); may not collect.
 *
 * Permitted transitions: active <-> inactive, active <-> suspended.
 *   inactive <-> suspended directly is NOT permitted: an administrator must
 *   reactivate to active first, keeping the reason explicit.
 */
const LIFECYCLE_STATUSES = ["active", "inactive", "suspended"] as const;

function isLifecycleStatus(
  value: unknown
): value is (typeof LIFECYCLE_STATUSES)[number] {
  return LIFECYCLE_STATUSES.includes(
    value as (typeof LIFECYCLE_STATUSES)[number]
  );
}

function canTransitionLifecycle(from: string, to: string): boolean {
  if (from === to) return true;
  if (from === "active" && (to === "inactive" || to === "suspended")) return true;
  if ((from === "inactive" || from === "suspended") && to === "active") return true;
  return false;
}

function validateLifecycleTransition(
  from: string,
  requested: unknown
): { ok: true; status: string } | { ok: false; error: string } {
  if (!isLifecycleStatus(requested)) {
    return { ok: false, error: "Invalid collector status" };
  }
  if (!canTransitionLifecycle(from, requested)) {
    return { ok: false, error: `Collector status cannot move from ${from} to ${requested}` };
  }
  return { ok: true, status: requested };
}

function requireStatusReason(status: string, reason?: string | null): string | null {
  const trimmed = reason?.trim() ?? null;
  if (status === "suspended" && (!trimmed || trimmed.length < 5)) {
    return null;
  }
  return trimmed;
}

/**
 * Change a collector's lifecycle status inside one transaction, with audit.
 * Admin-only; step-up reauthentication required.
 *
 * Current status is read from the user row (the authoritative account state)
 * and mirrored onto the Collector record. Both stay in sync, so every
 * collection path that checks either field observes the same result.
 */
export async function changeCollectorLifecycleStatus(params: {
  collectorId: string;
  newStatus: string;
  reason?: string;
  stepUpToken?: string;
  approvalId?: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const session = await getAdminSession();

  const { collectorId, newStatus, reason } = params;

  if (!(await assertTenantEntity("collector", collectorId, ctx))) {
    return { success: false, error: "Collector not found" };
  }

  const statusReason = requireStatusReason(newStatus, reason);
  if (newStatus === "suspended" && !statusReason) {
    return { success: false, error: "A suspension reason of at least 5 characters is required" };
  }

  const collector = await db.collector.findFirst({
    where: { id: collectorId, tenantId: ctx.tenantId },
    include: { user: { select: { id: true, status: true, fullName: true } } },
  });
  if (!collector) return { success: false, error: "Collector not found" };

  const fromStatus = collector.user.status;
  const transitioned = validateLifecycleTransition(fromStatus, newStatus);
  if (!transitioned.ok) {
    return { success: false, error: transitioned.error };
  }

  const rate = await consumeRateLimit(
    "finance:collector_lifecycle",
    `${ctx.tenantId}:${ctx.userId}`,
    RATE_LIMITS.financeMutation
  );
  if (!rate.allowed) {
    return { success: false, error: "Too many financial actions. Please wait and try again." };
  }

  // Note: collector lifecycle changes are authorized by the tenant administrator
  // session plus step-up reauthentication below. They are not financial ledger
  // postings, so they do not go through the financial dual-control action set.

  let applied = false;
  try {
    await db.$transaction(async (tx) => {
      const grant = await claimStepUpGrant(tx, {
        token: params.stepUpToken,
        subjectType: "user",
        subjectId: ctx.userId,
        sessionId: stepUpSessionBinding(session, ctx.userId),
        purpose: "collector.lifecycle",
        targetType: "collector",
        targetId: collectorId,
      });
      if (!grant.ok) throw new StepUpDeniedError(grant.error || "step_up_denied");

      await tx.collector.update({
        where: { id: collectorId },
        data: {
          status: transitioned.status,
          statusReason,
          statusChangedAt: new Date(),
          statusChangedById: ctx.userId,
        },
      });
      await tx.user.update({
        where: { id: collector.userId },
        data: {
          status: transitioned.status,
          tokenVersion: { increment: 1 }, // invalidates existing sessions
        },
      });
      applied = true;

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: `susu.collector_${newStatus}`,
        entityType: "collector",
        entityId: collectorId,
        details: {
          collectorId,
          previousStatus: fromStatus,
          newStatus: transitioned.status,
          reason: reason?.trim() ?? null,
          actor: ctx.userId,
        },
      });
    });
  } catch (error) {
    if (error instanceof StepUpDeniedError) {
      return {
        success: false,
        error: "Reauthentication expired or does not match this operation. Confirm your password again.",
      };
    }
    throw error;
  }

  if (!applied) {
    return {
      success: false,
      error: "Reauthentication expired or does not match this operation. Confirm your password again.",
    };
  }

  return { success: true, data: { collectorId, status: newStatus } };
}

/**
 * Resolve one collector by id, tenant-scoped, with current lifecycle metadata.
 */
export async function getCollectorLifecycle(collectorId: string): Promise<CollectorLifecycleView | null> {
  const ctx = await requireTenantAdminSusu();

  if (!(await assertTenantEntity("collector", collectorId, ctx))) {
    return null;
  }

  const row = await db.collector.findFirst({
    where: { id: collectorId, tenantId: ctx.tenantId },
    include: {
      user: { select: { id: true, fullName: true, email: true, phone: true, status: true } },
      assignments: {
        where: { tenantId: ctx.tenantId },
        select: { id: true, customerId: true, accountId: true, active: true },
      },
    },
  });
  if (!row) return null;

  return {
    id: row.id,
    userId: row.userId,
    fullName: row.user.fullName,
    email: row.user.email,
    phone: row.user.phone ?? null,
    status: row.status,
    statusReason: row.statusReason ?? null,
    statusChangedAt: row.statusChangedAt ?? null,
    statusChangedById: row.statusChangedById ?? null,
    createdAt: row.createdAt,
    assignments: row.assignments,
  };
}

/**
 * List every collector in the tenant with lifecycle state, for admin screens.
 */
export async function listCollectorsWithLifecycle() {
  const ctx = await requireTenantAdminSusu();

  return db.collector.findMany({
    where: { tenantId: ctx.tenantId },
    include: {
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          status: true,
          susuEnabled: true,
        },
      },
      assignments: { where: { active: true, tenantId: ctx.tenantId }, select: { id: true, accountId: true } },
      _count: { select: { contributions: { where: { tenantId: ctx.tenantId, reversedAt: null } } } },
    },
    orderBy: { createdAt: "asc" },
  });
}
