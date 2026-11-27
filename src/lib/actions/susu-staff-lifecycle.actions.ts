/**
 * Phase 8 — staff onboarding, lifecycle and offboarding for Susu administrators.
 *
 * This module adds the lifecycle that the existing staff directory did not
 * have. It deliberately reuses every existing control: the tenant admin guard,
 * the branch-scope model, the status policy, step-up reauthentication, the
 * audit log and the SessionRecord/tokenVersion revocation mechanism.
 *
 * Offboarding never deletes a person or rewrites their history. It:
 *   - refuses to proceed while the person still owns work that must move;
 *   - marks the account inactive and invalidates its sessions;
 *   - deactivates branch memberships and the collector record;
 *   - records exactly what was done, by whom and why.
 *
 * The "blockers" are responsibilities the departing person still holds. They
 * are reported with a resolution path instead of being silently transferred,
 * because a blind transfer of customer or cash responsibility is exactly how
 * money goes missing during a handover.
 */

"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getAdminSession } from "@/lib/auth";
import { createAuditLogTx } from "@/lib/audit";
import { requireTenantAdminSusu, type TenantContext } from "@/lib/tenant";
import { assertBranchAccess, isCompanyWideAdmin } from "@/lib/branch";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import {
  claimStepUpGrant,
  stepUpSessionBinding,
  StepUpDeniedError,
} from "@/lib/security/step-up";

const BRANCH_ROLES = ["branch_manager", "finance"] as const;
type BranchRole = (typeof BRANCH_ROLES)[number];
const ASSIGNABLE_STAFF_ROLES = ["worker", "collector"] as const;
type AssignableStaffRole = (typeof ASSIGNABLE_STAFF_ROLES)[number];

export interface StaffBlocker {
  key: string;
  label: string;
  count: number;
  resolution: string;
  samples: string[];
}

export interface StaffMembershipView {
  id: string;
  locationId: string;
  locationName: string;
  locationStatus: string;
  role: string;
  status: string;
  createdAt: string;
}

export interface StaffLifecycleRow {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: string;
  status: string;
  createdAt: string;
  collectorId: string | null;
  collectorStatus: string | null;
  collectorBranchId: string | null;
  memberships: StaffMembershipView[];
  activeSessions: number;
  blockers: StaffBlocker[];
  readyToOffboard: boolean;
  isLastActiveAdmin: boolean;
}

export interface StaffLifecycleOverview {
  rows: StaffLifecycleRow[];
  companyWideActor: boolean;
  canManageRoles: boolean;
  canGrantFinance: boolean;
  branches: { id: string; name: string; status: string }[];
}

export interface StaffOffboardingReadiness {
  userId: string;
  fullName: string;
  role: string;
  status: string;
  blockers: StaffBlocker[];
  ready: boolean;
  autoHandled: { label: string; count: number }[];
}

export interface StaffLifecycleResult {
  success: boolean;
  error?: string;
  blockers?: StaffBlocker[];
}

interface StaffUserRecord {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: string;
  status: string;
  createdAt: Date;
  collector: { id: string; status: string; branchId: string | null } | null;
}

const BLOCKER_LABELS: Record<string, { label: string; resolution: string }> = {
  active_assignments: {
    label: "Active customer assignments",
    resolution: "Reassign each account to another collector in Collectors before offboarding.",
  },
  outstanding_remittances: {
    label: "Outstanding remittances",
    resolution: "Settle or verify the money handed in, or reverse it with a reason, before offboarding.",
  },
  owned_exception_cases: {
    label: "Open reconciliation cases they own",
    resolution: "Reassign each case to another owner in Reconciliation, or resolve it.",
  },
  pending_offline_actions: {
    label: "Pending offline requests they raised",
    resolution: "Decide each request in Offline Requests before offboarding.",
  },
  pending_approvals: {
    label: "Pending approvals they requested",
    resolution: "Approve or reject each pending approval first; do not leave a departing person in an approval chain.",
  },
};

function emptyCounts(): Record<string, number> {
  return {
    active_assignments: 0,
    outstanding_remittances: 0,
    owned_exception_cases: 0,
    pending_offline_actions: 0,
    pending_approvals: 0,
  };
}

function buildBlockers(counts: Record<string, number>, samples?: Record<string, string[]>): StaffBlocker[] {
  const out: StaffBlocker[] = [];
  for (const key of Object.keys(BLOCKER_LABELS)) {
    const count = counts[key] ?? 0;
    if (count <= 0) continue;
    out.push({
      key,
      label: BLOCKER_LABELS[key].label,
      count,
      resolution: BLOCKER_LABELS[key].resolution,
      samples: samples?.[key] ?? [],
    });
  }
  return out;
}

/**
 * Count every responsibility that must move before an account can be closed.
 * Written as grouped queries over the whole set so a staff list never runs one
 * query per person.
 */
async function countResponsibilities(
  tx: Prisma.TransactionClient,
  tenantId: string,
  users: StaffUserRecord[]
): Promise<Map<string, Record<string, number>>> {
  const userIds = users.map((user) => user.id);
  const collectorIds = users
    .map((user) => user.collector?.id)
    .filter((id): id is string => Boolean(id));

  const result = new Map<string, Record<string, number>>();
  for (const id of userIds) result.set(id, emptyCounts());

  const [assignments, remittances, ownedCases, offline, approvals] = await Promise.all([
    collectorIds.length
      ? tx.collectorCustomerAssignment.groupBy({
          by: ["collectorId"],
          where: { collectorId: { in: collectorIds }, active: true },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    collectorIds.length
      ? tx.collectorRemittance.groupBy({
          by: ["collectorId"],
          where: {
            tenantId,
            collectorId: { in: collectorIds },
            reversedAt: null,
            outstandingAmount: { gt: 0 },
          },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    tx.reconciliationExceptionCase.groupBy({
      by: ["ownerId"],
      where: {
        tenantId,
        ownerId: { in: userIds },
        status: { notIn: ["resolved", "closed"] },
      },
      _count: { _all: true },
    }),
    tx.offlineActionRequest.groupBy({
      by: ["requestedById"],
      where: {
        tenantId,
        requestedById: { in: userIds },
        status: { in: ["pending", "needs_review"] },
      },
      _count: { _all: true },
    }),
    tx.financialApproval.groupBy({
      by: ["requestedBy"],
      where: { tenantId, requestedBy: { in: userIds }, status: "pending" },
      _count: { _all: true },
    }),
  ]);

  const collectorToUser = new Map<string, string>();
  for (const user of users) {
    if (user.collector) collectorToUser.set(user.collector.id, user.id);
  }

  for (const row of assignments) {
    const userId = collectorToUser.get(row.collectorId);
    if (userId) result.get(userId)!.active_assignments = row._count._all;
  }
  for (const row of remittances) {
    const userId = collectorToUser.get(row.collectorId);
    if (userId) result.get(userId)!.outstanding_remittances = row._count._all;
  }
  for (const row of ownedCases) {
    if (row.ownerId) result.get(row.ownerId)!.owned_exception_cases = row._count._all;
  }
  for (const row of offline) {
    if (row.requestedById) {
      result.get(row.requestedById)!.pending_offline_actions = row._count._all;
    }
  }
  for (const row of approvals) {
    if (row.requestedBy) result.get(row.requestedBy)!.pending_approvals = row._count._all;
  }

  return result;
}

async function countActiveSessions(
  tx: Prisma.TransactionClient,
  userIds: string[]
): Promise<Map<string, number>> {
  const rows = await tx.sessionRecord.groupBy({
    by: ["subjectId"],
    where: {
      subjectType: "user",
      subjectId: { in: userIds },
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    _count: { _all: true },
  });
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.subjectId, row._count._all);
  return map;
}

async function loadStaffUsers(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<StaffUserRecord[]> {
  return tx.user.findMany({
    where: { tenantId, role: { in: ["admin", "worker", "collector"] } },
    orderBy: [{ status: "asc" }, { fullName: "asc" }],
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      role: true,
      status: true,
      createdAt: true,
      collector: { select: { id: true, status: true, branchId: true } },
    },
  });
}

async function loadMemberships(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userIds: string[]
): Promise<Map<string, StaffMembershipView[]>> {
  const rows = await tx.branchMembership.findMany({
    where: { tenantId, userId: { in: userIds } },
    orderBy: { createdAt: "asc" },
  });
  const locationIds = Array.from(new Set(rows.map((row) => row.locationId)));
  const locations = locationIds.length
    ? await tx.location.findMany({
        where: { tenantId, id: { in: locationIds } },
        select: { id: true, name: true, status: true },
      })
    : [];
  const locationById = new Map(locations.map((row) => [row.id, row]));

  const byUser = new Map<string, StaffMembershipView[]>();
  for (const row of rows) {
    const list = byUser.get(row.userId) ?? [];
    const location = locationById.get(row.locationId);
    list.push({
      id: row.id,
      locationId: row.locationId,
      locationName: location?.name ?? "Unknown branch",
      locationStatus: location?.status ?? "unknown",
      role: row.role,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    });
    byUser.set(row.userId, list);
  }
  return byUser;
}

async function describeBlockers(
  tx: Prisma.TransactionClient,
  tenantId: string,
  user: StaffUserRecord,
  counts: Record<string, number>
): Promise<StaffBlocker[]> {
  const samples: Record<string, string[]> = {};

  if (counts.active_assignments > 0 && user.collector) {
    const rows = await tx.collectorCustomerAssignment.findMany({
      where: { collectorId: user.collector.id, active: true },
      take: 5,
      orderBy: { assignedAt: "asc" },
      select: { customerId: true, accountId: true },
    });
    const [customers, accounts] = await Promise.all([
      tx.customer.findMany({
        where: { id: { in: rows.map((row) => row.customerId) } },
        select: { id: true, fullName: true },
      }),
      tx.susuAccount.findMany({
        where: { id: { in: rows.map((row) => row.accountId) } },
        select: { id: true, accountId: true },
      }),
    ]);
    const customerNames = new Map(customers.map((row) => [row.id, row.fullName]));
    const accountNumbers = new Map(accounts.map((row) => [row.id, row.accountId]));
    samples.active_assignments = rows.map(
      (row) =>
        (customerNames.get(row.customerId) ?? "Customer") +
        " (" +
        (accountNumbers.get(row.accountId) ?? "account") +
        ")"
    );
  }

  if (counts.outstanding_remittances > 0 && user.collector) {
    const rows = await tx.collectorRemittance.findMany({
      where: {
        tenantId,
        collectorId: user.collector.id,
        reversedAt: null,
        outstandingAmount: { gt: 0 },
      },
      take: 5,
      orderBy: { createdAt: "asc" },
      select: { referenceId: true, outstandingAmount: true },
    });
    samples.outstanding_remittances = rows.map(
      (row) => row.referenceId + " (" + row.outstandingAmount.toString() + " outstanding)"
    );
  }

  if (counts.owned_exception_cases > 0) {
    const rows = await tx.reconciliationExceptionCase.findMany({
      where: { tenantId, ownerId: user.id, status: { notIn: ["resolved", "closed"] } },
      take: 5,
      orderBy: { openedAt: "asc" },
      select: { caseNumber: true, title: true },
    });
    samples.owned_exception_cases = rows.map(
      (row) => row.caseNumber + " — " + row.title
    );
  }

  if (counts.pending_offline_actions > 0) {
    const rows = await tx.offlineActionRequest.findMany({
      where: { tenantId, requestedById: user.id, status: { in: ["pending", "needs_review"] } },
      take: 5,
      orderBy: { requestedAt: "asc" },
      select: { kind: true, status: true, requestedAt: true },
    });
    samples.pending_offline_actions = rows.map(
      (row) => row.kind + " (" + row.status + ", " + row.requestedAt.toISOString().slice(0, 10) + ")"
    );
  }

  if (counts.pending_approvals > 0) {
    const rows = await tx.financialApproval.findMany({
      where: { tenantId, requestedBy: user.id, status: "pending" },
      take: 5,
      orderBy: { createdAt: "asc" },
      select: { action: true, targetType: true, createdAt: true },
    });
    samples.pending_approvals = rows.map(
      (row) => row.action + " (" + row.targetType + ", " + row.createdAt.toISOString().slice(0, 10) + ")"
    );
  }

  return buildBlockers(counts, samples);
}

function isBranchRole(value: unknown): value is BranchRole {
  return typeof value === "string" && (BRANCH_ROLES as readonly string[]).includes(value);
}

function isAssignableRole(value: unknown): value is AssignableStaffRole {
  return typeof value === "string" && (ASSIGNABLE_STAFF_ROLES as readonly string[]).includes(value);
}

function requireReason(value: unknown, min: number): string | null {
  const reason = String(value ?? "").trim();
  return reason.length >= min ? reason.slice(0, 500) : null;
}

/**
 * The staff lifecycle list: one row per person with their branch access,
 * active sessions and the work that would block an offboarding. Read-only.
 */
export async function getStaffLifecycleOverview(): Promise<StaffLifecycleOverview> {
  const ctx = await requireTenantAdminSusu();
  const companyWide = await isCompanyWideAdmin(ctx);

  return db.$transaction(async (tx) => {
    const users = await loadStaffUsers(tx, ctx.tenantId);
    const userIds = users.map((user) => user.id);
    const [counts, sessions, memberships, branches, activeAdmins] = await Promise.all([
      countResponsibilities(tx, ctx.tenantId, users),
      countActiveSessions(tx, userIds),
      loadMemberships(tx, ctx.tenantId, userIds),
      tx.location.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, status: true },
      }),
      tx.user.count({ where: { tenantId: ctx.tenantId, role: "admin", status: "active" } }),
    ]);

    const rows: StaffLifecycleRow[] = users.map((user) => {
      const userCounts = counts.get(user.id) ?? emptyCounts();
      const blockers = buildBlockers(userCounts);
      const membershipList = memberships.get(user.id) ?? [];
      return {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt.toISOString(),
        collectorId: user.collector?.id ?? null,
        collectorStatus: user.collector?.status ?? null,
        collectorBranchId: user.collector?.branchId ?? null,
        memberships: membershipList,
        activeSessions: sessions.get(user.id) ?? 0,
        blockers,
        readyToOffboard: user.status === "active" && blockers.length === 0,
        isLastActiveAdmin:
          user.role === "admin" && user.status === "active" && activeAdmins <= 1,
      };
    });

    const scopedBranches = companyWide
      ? branches
      : (
          await Promise.all(
            branches.map(async (branch) =>
              (await assertBranchAccess(ctx, branch.id, "write")) ? branch : null
            )
          )
        ).filter((branch): branch is { id: string; name: string; status: string } => Boolean(branch));

    return {
      rows,
      companyWideActor: companyWide,
      canManageRoles: companyWide,
      canGrantFinance: companyWide,
      branches: scopedBranches,
    };
  });
}

/** Detailed readiness for one person, including what offboarding will do. */
export async function getStaffOffboardingReadiness(
  userId: string
): Promise<StaffOffboardingReadiness> {
  const ctx = await requireTenantAdminSusu();
  const id = String(userId ?? "");
  return db.$transaction(async (tx) => {
    const user = await tx.user.findFirst({
      where: { id, tenantId: ctx.tenantId, role: { in: ["admin", "worker", "collector"] } },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true,
        collector: { select: { id: true, status: true, branchId: true } },
      },
    });
    if (!user) {
      return {
        userId: id,
        fullName: "",
        role: "",
        status: "",
        blockers: [],
        ready: false,
        autoHandled: [],
      };
    }

    const counts = await countResponsibilities(tx, ctx.tenantId, [user]);
    const userCounts = counts.get(user.id) ?? emptyCounts();
    const blockers = await describeBlockers(tx, ctx.tenantId, user, userCounts);
    const sessions = await countActiveSessions(tx, [user.id]);
    const memberships = await tx.branchMembership.count({
      where: { tenantId: ctx.tenantId, userId: user.id, status: "active" },
    });

    return {
      userId: user.id,
      fullName: user.fullName,
      role: user.role,
      status: user.status,
      blockers,
      ready: user.status === "active" && blockers.length === 0,
      autoHandled: [
        { label: "Active sessions revoked", count: sessions.get(user.id) ?? 0 },
        { label: "Branch memberships deactivated", count: memberships },
        {
          label: "Collector record marked inactive",
          count: user.collector && user.collector.status === "active" ? 1 : 0,
        },
      ],
    };
  });
}

/**
 * Offboard one staff member. Refuses while they hold live responsibilities,
 * requires step-up reauthentication, and writes the whole change plus its audit
 * record in one transaction.
 */
export async function offboardStaff(params: {
  userId: string;
  reason: string;
  stepUpToken?: string;
}): Promise<StaffLifecycleResult> {
  const ctx = await requireTenantAdminSusu();
  const session = await getAdminSession();
  const userId = String(params?.userId ?? "");
  const reason = requireReason(params?.reason, 10);
  if (!userId) return { success: false, error: "Choose a staff member to offboard." };
  if (!reason) {
    return { success: false, error: "Record why this person is being offboarded (at least 10 characters)." };
  }
  if (userId === ctx.userId) {
    return { success: false, error: "You cannot offboard your own account." };
  }

  const rate = await consumeRateLimit(
    "admin:staff_lifecycle",
    ctx.tenantId + ":" + ctx.userId,
    RATE_LIMITS.adminSensitive
  );
  if (!rate.allowed) {
    return { success: false, error: "Too many staff changes. Please wait and try again." };
  }

  try {
    return await db.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: {
          id: userId,
          tenantId: ctx.tenantId,
          role: { in: ["admin", "worker", "collector"] },
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          status: true,
          createdAt: true,
          collector: { select: { id: true, status: true, branchId: true } },
        },
      });
      if (!user) return { success: false, error: "Staff member not found in this business." };
      if (user.status !== "active") {
        return { success: false, error: "This account is already inactive." };
      }

      if (user.role === "admin") {
        const activeAdmins = await tx.user.count({
          where: { tenantId: ctx.tenantId, role: "admin", status: "active" },
        });
        if (activeAdmins <= 1) {
          return {
            success: false,
            error: "This is the last active administrator. Promote another administrator before offboarding this one.",
          };
        }
      }

      const counts = (await countResponsibilities(tx, ctx.tenantId, [user])).get(user.id) ?? emptyCounts();
      const blockers = await describeBlockers(tx, ctx.tenantId, user, counts);
      if (blockers.length > 0) {
        return {
          success: false,
          error: "Transfer the responsibilities below before offboarding this person.",
          blockers,
        };
      }

      const grant = await claimStepUpGrant(tx, {
        token: params.stepUpToken,
        subjectType: "user",
        subjectId: ctx.userId,
        sessionId: stepUpSessionBinding(session, ctx.userId),
        purpose: "staff.lifecycle",
        targetType: "user",
        targetId: user.id,
      });
      if (!grant.ok) throw new StepUpDeniedError(grant.error);

      const now = new Date();
      await tx.user.update({
        where: { id: user.id },
        data: {
          status: "inactive",
          tokenVersion: { increment: 1 },
          forcePasswordReset: true,
        },
      });

      let collectorChanged = false;
      if (user.collector) {
        await tx.collector.update({
          where: { id: user.collector.id },
          data: {
            status: "inactive",
            statusReason: ("Offboarded: " + reason).slice(0, 500),
            statusChangedAt: now,
            statusChangedById: ctx.userId,
          },
        });
        collectorChanged = user.collector.status !== "inactive";
      }

      const memberships = await tx.branchMembership.updateMany({
        where: { tenantId: ctx.tenantId, userId: user.id, status: "active" },
        data: { status: "inactive" },
      });

      const sessions = await tx.sessionRecord.updateMany({
        where: { subjectType: "user", subjectId: user.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: "staff_offboarded" },
      });

      await tx.stepUpGrant.updateMany({
        where: { subjectType: "user", subjectId: user.id, consumedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "user.staff_offboarded",
        entityType: "user",
        entityId: user.id,
        details: {
          reason,
          fullName: user.fullName,
          email: user.email,
          previousRole: user.role,
          collectorDeactivated: collectorChanged,
          membershipsDeactivated: memberships.count,
          sessionsRevoked: sessions.count,
        },
      });

      return { success: true };
    });
  } catch (error) {
    if (error instanceof StepUpDeniedError) return { success: false, error: error.message };
    throw error;
  } finally {
    revalidatePath("/susu/admin/staff");
    revalidatePath("/admin/staff");
  }
}

/** Reactivate a previously offboarded account. History is preserved. */
export async function reactivateStaff(params: {
  userId: string;
  reason: string;
  stepUpToken?: string;
}): Promise<StaffLifecycleResult> {
  const ctx = await requireTenantAdminSusu();
  const session = await getAdminSession();
  const userId = String(params?.userId ?? "");
  const reason = requireReason(params?.reason, 5);
  if (!userId) return { success: false, error: "Choose a staff member to reactivate." };
  if (!reason) return { success: false, error: "Record a reason of at least 5 characters." };
  if (userId === ctx.userId) {
    return { success: false, error: "You cannot reactivate your own account here." };
  }

  const rate = await consumeRateLimit(
    "admin:staff_lifecycle",
    ctx.tenantId + ":" + ctx.userId,
    RATE_LIMITS.adminSensitive
  );
  if (!rate.allowed) {
    return { success: false, error: "Too many staff changes. Please wait and try again." };
  }

  try {
    return await db.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: userId, tenantId: ctx.tenantId, role: { in: ["admin", "worker", "collector"] } },
        select: {
          id: true,
          fullName: true,
          role: true,
          status: true,
          collector: { select: { id: true, status: true } },
        },
      });
      if (!user) return { success: false, error: "Staff member not found in this business." };
      if (user.status === "active") {
        return { success: false, error: "This account is already active." };
      }
      if (user.collector?.status === "suspended") {
        return {
          success: false,
          error: "This collector is suspended. Clear the suspension in Collectors first.",
        };
      }

      const grant = await claimStepUpGrant(tx, {
        token: params.stepUpToken,
        subjectType: "user",
        subjectId: ctx.userId,
        sessionId: stepUpSessionBinding(session, ctx.userId),
        purpose: "staff.lifecycle",
        targetType: "user",
        targetId: user.id,
      });
      if (!grant.ok) throw new StepUpDeniedError(grant.error);

      await tx.user.update({
        where: { id: user.id },
        data: { status: "active", tokenVersion: { increment: 1 } },
      });

      if (user.collector) {
        await tx.collector.update({
          where: { id: user.collector.id },
          data: {
            status: "active",
            statusReason: ("Reactivated: " + reason).slice(0, 500),
            statusChangedAt: new Date(),
            statusChangedById: ctx.userId,
          },
        });
      }

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "user.staff_reactivated",
        entityType: "user",
        entityId: user.id,
        details: { reason, role: user.role, collectorReactivated: Boolean(user.collector) },
      });

      return { success: true };
    });
  } catch (error) {
    if (error instanceof StepUpDeniedError) return { success: false, error: error.message };
    throw error;
  } finally {
    revalidatePath("/susu/admin/staff");
    revalidatePath("/admin/staff");
  }
}

/**
 * Change a staff member between the two assignable operational roles. Tenant
 * administrators cannot create another administrator here: that stays a
 * platform provisioning action, which keeps tenant privilege escalation out of
 * the tenant console entirely.
 */
export async function changeStaffRole(params: {
  userId: string;
  role: string;
  stepUpToken?: string;
}): Promise<StaffLifecycleResult> {
  const ctx = await requireTenantAdminSusu();
  const session = await getAdminSession();
  const userId = String(params?.userId ?? "");
  const role = String(params?.role ?? "");
  if (!isAssignableRole(role)) {
    return { success: false, error: "Choose the worker or collector role. Administrator accounts are provisioned by platform support." };
  }
  if (!userId) return { success: false, error: "Choose a staff member." };
  if (userId === ctx.userId) {
    return { success: false, error: "You cannot change your own role." };
  }
  if (!(await isCompanyWideAdmin(ctx))) {
    return { success: false, error: "Only a company-wide administrator can change a staff role." };
  }
  if (role === "collector" && !ctx.susuEnabled) {
    return { success: false, error: "This business is not enrolled for the Susu module." };
  }

  try {
    return await db.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: userId, tenantId: ctx.tenantId, role: { in: ["worker", "collector"] } },
        select: { id: true, fullName: true, role: true, status: true, collector: true },
      });
      if (!user) {
        return { success: false, error: "Only worker or collector accounts can change role here." };
      }
      if (user.role === role) {
        return { success: false, error: "This person already holds that role." };
      }

      const grant = await claimStepUpGrant(tx, {
        token: params.stepUpToken,
        subjectType: "user",
        subjectId: ctx.userId,
        sessionId: stepUpSessionBinding(session, ctx.userId),
        purpose: "staff.assignment",
        targetType: "user",
        targetId: user.id,
      });
      if (!grant.ok) throw new StepUpDeniedError(grant.error);

      let collectorCreated = false;
      let collectorDeactivated = false;

      if (role === "collector") {
        if (!user.collector) {
          await tx.collector.create({
            data: { tenantId: ctx.tenantId, userId: user.id, status: "active" },
          });
          collectorCreated = true;
        } else if (user.collector.status !== "active") {
          await tx.collector.update({
            where: { id: user.collector.id },
            data: {
              status: "active",
              statusReason: "Role changed to collector",
              statusChangedAt: new Date(),
              statusChangedById: ctx.userId,
            },
          });
        }
      } else if (user.collector && user.collector.status === "active") {
        await tx.collector.update({
          where: { id: user.collector.id },
          data: {
            status: "inactive",
            statusReason: "Role changed to worker",
            statusChangedAt: new Date(),
            statusChangedById: ctx.userId,
          },
        });
        collectorDeactivated = true;
      }

      await tx.user.update({
        where: { id: user.id },
        data: { role, tokenVersion: { increment: 1 } },
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "user.staff_role_changed",
        entityType: "user",
        entityId: user.id,
        details: {
          fromRole: user.role,
          toRole: role,
          collectorCreated,
          collectorDeactivated,
        },
      });

      return { success: true };
    });
  } catch (error) {
    if (error instanceof StepUpDeniedError) return { success: false, error: error.message };
    throw error;
  } finally {
    revalidatePath("/susu/admin/staff");
    revalidatePath("/admin/staff");
  }
}

/**
 * Grant branch-scoped access (branch manager or finance) to a staff member.
 * A branch-limited administrator may only grant branch-manager access inside
 * their own branches, and may never grant the finance role: separation of
 * duties is not a permission a scoped manager can hand out.
 */
export async function assignStaffBranch(params: {
  userId: string;
  locationId: string;
  role: string;
  stepUpToken?: string;
}): Promise<StaffLifecycleResult> {
  const ctx = await requireTenantAdminSusu();
  const session = await getAdminSession();
  const userId = String(params?.userId ?? "");
  const locationId = String(params?.locationId ?? "");
  const role = String(params?.role ?? "");
  if (!isBranchRole(role)) return { success: false, error: "Choose the branch manager or finance role." };
  if (!userId || !locationId) return { success: false, error: "Choose a staff member and a branch." };
  if (userId === ctx.userId) {
    return { success: false, error: "You cannot change your own branch access." };
  }

  const companyWide = await isCompanyWideAdmin(ctx);
  if (role === "finance" && !companyWide) {
    return { success: false, error: "Only a company-wide administrator can grant the finance branch role." };
  }
  if (!(await assertBranchAccess(ctx, locationId, "write"))) {
    return { success: false, error: "That branch is not available to you." };
  }

  try {
    return await db.$transaction(async (tx) => {
      const target = await tx.user.findFirst({
        where: { id: userId, tenantId: ctx.tenantId, status: "active", role: { in: ["admin", "worker", "collector"] } },
        select: { id: true, fullName: true, role: true },
      });
      if (!target) return { success: false, error: "Only an active staff member can receive branch access." };

      const branch = await tx.location.findFirst({
        where: { id: locationId, tenantId: ctx.tenantId, status: "active" },
        select: { id: true, name: true },
      });
      if (!branch) return { success: false, error: "That branch is not active in this business." };

      const grant = await claimStepUpGrant(tx, {
        token: params.stepUpToken,
        subjectType: "user",
        subjectId: ctx.userId,
        sessionId: stepUpSessionBinding(session, ctx.userId),
        purpose: "staff.assignment",
        targetType: "user",
        targetId: target.id,
      });
      if (!grant.ok) throw new StepUpDeniedError(grant.error);

      const existing = await tx.branchMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId: target.id, locationId, role },
      });
      let reactivated = false;
      if (existing?.status === "active") {
        return { success: false, error: "This person already holds that branch role." };
      }
      if (existing) {
        await tx.branchMembership.update({
          where: { id: existing.id },
          data: { status: "active" },
        });
        reactivated = true;
      } else {
        await tx.branchMembership.create({
          data: { tenantId: ctx.tenantId, userId: target.id, locationId, role, status: "active" },
        });
      }

      await tx.user.update({
        where: { id: target.id },
        data: { tokenVersion: { increment: 1 } },
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        branchId: locationId,
        action: "user.staff_branch_access_granted",
        entityType: "user",
        entityId: target.id,
        details: { role, branchName: branch.name, reactivated },
      });

      return { success: true };
    });
  } catch (error) {
    if (error instanceof StepUpDeniedError) return { success: false, error: error.message };
    throw error;
  } finally {
    revalidatePath("/susu/admin/staff");
    revalidatePath("/admin/staff");
  }
}

/** Revoke one branch membership. The row is deactivated, never deleted. */
export async function revokeStaffBranchMembership(params: {
  membershipId: string;
  reason: string;
  stepUpToken?: string;
}): Promise<StaffLifecycleResult> {
  const ctx = await requireTenantAdminSusu();
  const session = await getAdminSession();
  const membershipId = String(params?.membershipId ?? "");
  const reason = requireReason(params?.reason, 5);
  if (!membershipId) return { success: false, error: "Choose a branch membership to revoke." };
  if (!reason) return { success: false, error: "Record a reason of at least 5 characters." };

  const companyWide = await isCompanyWideAdmin(ctx);

  try {
    return await db.$transaction(async (tx) => {
      const membership = await tx.branchMembership.findFirst({
        where: { id: membershipId, tenantId: ctx.tenantId },
      });
      if (!membership) return { success: false, error: "Branch membership not found in this business." };
      if (membership.status !== "active") {
        return { success: false, error: "That branch access is already inactive." };
      }
      if (membership.userId === ctx.userId) {
        return { success: false, error: "You cannot revoke your own branch access." };
      }
      if (membership.role === "finance" && !companyWide) {
        return { success: false, error: "Only a company-wide administrator can revoke the finance branch role." };
      }
      if (!(await assertBranchAccess(ctx, membership.locationId, "write"))) {
        return { success: false, error: "That branch is not available to you." };
      }

      const grant = await claimStepUpGrant(tx, {
        token: params.stepUpToken,
        subjectType: "user",
        subjectId: ctx.userId,
        sessionId: stepUpSessionBinding(session, ctx.userId),
        purpose: "staff.assignment",
        targetType: "user",
        targetId: membership.userId,
      });
      if (!grant.ok) throw new StepUpDeniedError(grant.error);

      await tx.branchMembership.update({
        where: { id: membership.id },
        data: { status: "inactive" },
      });
      await tx.user.update({
        where: { id: membership.userId },
        data: { tokenVersion: { increment: 1 } },
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        branchId: membership.locationId,
        action: "user.staff_branch_access_revoked",
        entityType: "user",
        entityId: membership.userId,
        details: { role: membership.role, reason },
      });

      return { success: true };
    });
  } catch (error) {
    if (error instanceof StepUpDeniedError) return { success: false, error: error.message };
    throw error;
  } finally {
    revalidatePath("/susu/admin/staff");
    revalidatePath("/admin/staff");
  }
}

/** Revoke every active session for one staff member (lost device, suspicion). */
export async function revokeStaffSessions(params: {
  userId: string;
  reason: string;
  stepUpToken?: string;
}): Promise<StaffLifecycleResult> {
  const ctx = await requireTenantAdminSusu();
  const session = await getAdminSession();
  const userId = String(params?.userId ?? "");
  const reason = requireReason(params?.reason, 5);
  if (!userId) return { success: false, error: "Choose a staff member." };
  if (!reason) return { success: false, error: "Record a reason of at least 5 characters." };

  try {
    return await db.$transaction(async (tx) => {
      const target = await tx.user.findFirst({
        where: { id: userId, tenantId: ctx.tenantId, role: { in: ["admin", "worker", "collector"] } },
        select: { id: true, fullName: true },
      });
      if (!target) return { success: false, error: "Staff member not found in this business." };

      const grant = await claimStepUpGrant(tx, {
        token: params.stepUpToken,
        subjectType: "user",
        subjectId: ctx.userId,
        sessionId: stepUpSessionBinding(session, ctx.userId),
        purpose: "staff.lifecycle",
        targetType: "user",
        targetId: target.id,
      });
      if (!grant.ok) throw new StepUpDeniedError(grant.error);

      const now = new Date();
      const sessions = await tx.sessionRecord.updateMany({
        where: { subjectType: "user", subjectId: target.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: "admin_session_revoked" },
      });
      await tx.user.update({
        where: { id: target.id },
        data: { tokenVersion: { increment: 1 } },
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "user.staff_sessions_revoked",
        entityType: "user",
        entityId: target.id,
        details: { reason, sessionsRevoked: sessions.count },
      });

      return { success: true };
    });
  } catch (error) {
    if (error instanceof StepUpDeniedError) return { success: false, error: error.message };
    throw error;
  } finally {
    revalidatePath("/susu/admin/staff");
    revalidatePath("/admin/staff");
  }
}

/** Small read used by the staff page to offer a branch chooser per person. */
export async function getStaffBranchOptions(): Promise<{ id: string; name: string }[]> {
  const ctx: TenantContext = await requireTenantAdminSusu();
  return db.location.findMany({
    where: { tenantId: ctx.tenantId, status: "active" },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}
