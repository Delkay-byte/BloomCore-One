import { db } from "./db";
import type { TenantContext } from "./tenant";

/**
 * Phase 1 — branch scope for Susu operations.
 *
 * Scope comes from persisted server-side state only:
 *   - an administrator without an active branch membership keeps the existing
 *     company-wide authority;
 *   - an administrator with an active branch_manager/finance membership is
 *     restricted to those branches;
 *   - a collector is restricted to their own Collector.branchId.
 *
 * A client-supplied branch id is never proof of authorisation. It is validated
 * against the tenant and the resolved scope before use.
 */

export const LEGACY_UNASSIGNED_BRANCH = "LEGACY_UNASSIGNED";

export type BranchScope =
  | { kind: "all" }
  | { kind: "limited"; branchIds: string[]; roles: string[] };

export async function resolveBranchScope(ctx: TenantContext): Promise<BranchScope> {
  return resolveUserBranchScope(ctx.tenantId, ctx.userId, ctx.role);
}

/**
 * Branch scope for an arbitrary tenant user.
 *
 * Reconciliation reassigns cases to another staff member, so the assignee's
 * scope must be resolved without a session context. The rules are identical to
 * the acting-user path above; this function is the single implementation.
 */
export async function resolveUserBranchScope(
  tenantId: string,
  userId: string,
  role: string
): Promise<BranchScope> {
  if (role === "admin") {
    const memberships = await db.branchMembership.findMany({
      where: {
        tenantId,
        userId,
        status: "active",
        role: { in: ["branch_manager", "finance"] },
      },
      select: { locationId: true, role: true },
    });
    if (memberships.length === 0) return { kind: "all" };
    return {
      kind: "limited",
      branchIds: [...new Set(memberships.map((m) => m.locationId))],
      roles: [...new Set(memberships.map((m) => m.role))],
    };
  }

  if (role === "collector") {
    const collector = await db.collector.findFirst({
      where: { tenantId, userId, status: "active" },
      select: { branchId: true },
    });
    return {
      kind: "limited",
      branchIds: collector?.branchId ? [collector.branchId] : [],
      roles: ["collector"],
    };
  }

  // Workers and other non-admin roles have no implicit Susu branch authority.
  // They may hold an explicit finance membership; otherwise scope is empty and
  // every access check fails closed.
  const memberships = await db.branchMembership.findMany({
    where: { tenantId, userId, status: "active", role: "finance" },
    select: { locationId: true, role: true },
  });
  return {
    kind: "limited",
    branchIds: [...new Set(memberships.map((m) => m.locationId))],
    roles: [...new Set(memberships.map((m) => m.role))],
  };
}

/** True when the user holds this active branch role. Never trusts the client. */
export async function hasActiveBranchRole(
  tenantId: string,
  userId: string,
  branchId: string,
  role: "branch_manager" | "finance"
): Promise<boolean> {
  const membership = await db.branchMembership.findFirst({
    where: { tenantId, userId, locationId: branchId, status: "active", role },
    select: { id: true },
  });
  return Boolean(membership);
}

/**
 * True when this identity may access the branch.
 *
 * Read access includes deactivated branches so historical records stay visible.
 * Write access requires an active branch and an in-scope branch id. A legacy
 * unassigned historical record is readable by the tenant, never writable.
 */
export async function assertBranchAccess(
  ctx: TenantContext,
  branchId: string | null | undefined,
  mode: "read" | "write" = "read"
): Promise<boolean> {
  if (!branchId || branchId === LEGACY_UNASSIGNED_BRANCH) return mode === "read";

  const location = await db.location.findFirst({
    where: { id: branchId, tenantId: ctx.tenantId },
    select: { status: true },
  });
  if (!location) return false;
  if (mode === "write" && location.status !== "active") return false;

  const scope = await resolveBranchScope(ctx);
  if (scope.kind === "all") return true;
  return scope.branchIds.includes(branchId);
}

/**
 * Resolve the branch for a new financial record. Never trusts a raw client
 * branch id: the value must be a tenant-owned, active, in-scope branch.
 *
 * With no explicit choice, a single available branch is used. A wide admin
 * with several branches must choose explicitly; a scoped manager with exactly
 * one membership gets that branch.
 */
export async function resolveWriteBranch(
  ctx: TenantContext,
  requestedBranchId?: string | null
): Promise<string | null> {
  if (requestedBranchId === LEGACY_UNASSIGNED_BRANCH) return null;
  if (requestedBranchId) {
    return (await assertBranchAccess(ctx, requestedBranchId, "write"))
      ? requestedBranchId
      : null;
  }

  const scope = await resolveBranchScope(ctx);
  if (scope.kind === "limited") {
    if (scope.branchIds.length !== 1) return null;
    const branchIds = scope.branchIds;
    return (await assertBranchAccess(ctx, branchIds[0], "write")) ? branchIds[0] : null;
  }

  const active = await db.location.findMany({
    where: { tenantId: ctx.tenantId, status: "active" },
    select: { id: true },
  });
  if (active.length !== 1) return null;
  return active[0].id;
}

/** True when a tenant has no configured branch at all (legacy single office). */
export async function isBranchlessTenant(ctx: TenantContext): Promise<boolean> {
  const count = await db.location.count({ where: { tenantId: ctx.tenantId } });
  return count === 0;
}

/**
 * Branch responsible for a customer's savings account. Uses the newest
 * attributed contribution, with a single active branch as a safe fallback.
 * Never guesses when several branches exist.
 */
export async function resolveCustomerRequestBranch(
  ctx: TenantContext,
  accountId: string
): Promise<string | null> {
  const last = await db.contribution.findFirst({
    where: { tenantId: ctx.tenantId, accountId, branchId: { not: null } },
    orderBy: { collectionDate: "desc" },
    select: { branchId: true },
  });
  if (last?.branchId) return last.branchId;
  const active = await db.location.findMany({
    where: { tenantId: ctx.tenantId, status: "active" },
    select: { id: true },
  });
  return active.length === 1 ? active[0].id : null;
}

/** True only for an administrator with no scope-reducing membership. */
export async function isCompanyWideAdmin(ctx: TenantContext): Promise<boolean> {
  return ctx.role === "admin" && (await resolveBranchScope(ctx)).kind === "all";
}

/** Branch label used when a historical record predates branch attribution. */
export function branchLabel(branchId: string | null | undefined): string {
  return branchId && branchId !== LEGACY_UNASSIGNED_BRANCH
    ? branchId
    : LEGACY_UNASSIGNED_BRANCH;
}
