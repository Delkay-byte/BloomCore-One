/**
 * Server-side authorization for Phase 5.
 *
 * The client never supplies a tenant, role, branch or collector identity that
 * is trusted. Every action resolves the session actor here, loads the case from
 * the database by id, and re-checks the tenant + branch + collector boundary.
 *
 * Authority model:
 *   company admin     -> every branch in the tenant, including LEGACY_UNASSIGNED
 *   branch-restricted -> only branches in BranchMembership scope; a null-branch
 *                        (legacy) case is never visible to a restricted user
 *   collector         -> only cases whose collectorId is their own profile
 *   finance authority -> company admin, or an active finance membership in the
 *                        case branch; a branch_manager is NOT finance authority
 */

import { db } from "@/lib/db";
import {
  assertBranchAccess,
  hasActiveBranchRole,
  resolveBranchScope,
  resolveUserBranchScope,
  type BranchScope,
} from "@/lib/branch";
import {
  requireTenantAdminSusu,
  requireTenantCollector,
  type TenantContext,
} from "@/lib/tenant";

export class ReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationError";
  }
}

export type ReconciliationActorKind = "admin" | "collector";

export interface ReconciliationActor {
  ctx: TenantContext;
  kind: ReconciliationActorKind;
  collectorId: string | null;
  collectorStatus: string | null;
  scope: BranchScope;
  branchIds: string[];
  isCompanyWide: boolean;
  roles: string[];
}

async function loadCollector(tenantId: string, userId: string) {
  return db.collector.findFirst({
    where: { tenantId, userId },
    select: { id: true, branchId: true, status: true },
  });
}

/** Resolve the acting administrator or collector without trusting any input. */
export async function resolveReconciliationActor(): Promise<ReconciliationActor> {
  let ctx: TenantContext;
  try {
    ctx = await requireTenantAdminSusu();
  } catch (adminError) {
    try {
      ctx = await requireTenantCollector();
    } catch {
      throw adminError;
    }
  }

  if (ctx.role === "admin") {
    const scope = await resolveBranchScope(ctx);
    return {
      ctx,
      kind: "admin",
      collectorId: null,
      collectorStatus: null,
      scope,
      branchIds: scope.kind === "all" ? [] : scope.branchIds,
      isCompanyWide: scope.kind === "all",
      roles: scope.kind === "all" ? ["admin"] : scope.roles,
    };
  }

  if (ctx.role === "collector") {
    const collector = await loadCollector(ctx.tenantId, ctx.userId);
    return {
      ctx,
      kind: "collector",
      collectorId: collector?.id ?? null,
      collectorStatus: collector?.status ?? null,
      scope: {
        kind: "limited",
        branchIds: collector?.branchId ? [collector.branchId] : [],
        roles: ["collector"],
      },
      branchIds: collector?.branchId ? [collector.branchId] : [],
      isCompanyWide: false,
      roles: ["collector"],
    };
  }

  throw new ReconciliationError(
    "Susu reconciliation is available to administrators and collectors only."
  );
}

/** Administrator-only actions. Collectors are rejected here, explicitly. */
export async function requireReconciliationAdmin(): Promise<ReconciliationActor> {
  const actor = await resolveReconciliationActor();
  if (actor.kind !== "admin") {
    throw new ReconciliationError("This action requires an administrator");
  }
  return actor;
}

export function actorAllowsBranch(
  actor: ReconciliationActor,
  branchId: string | null | undefined
): boolean {
  if (actor.kind === "collector") {
    return Boolean(branchId && actor.branchIds.includes(branchId));
  }
  if (!branchId) return actor.isCompanyWide;
  if (actor.isCompanyWide) return true;
  return actor.branchIds.includes(branchId);
}

/** Use the canonical branch helper for writes; no branch helper is duplicated. */
export async function assertActorBranchWrite(
  actor: ReconciliationActor,
  branchId: string | null | undefined
): Promise<void> {
  if (actor.kind !== "admin") {
    throw new ReconciliationError("This action requires an administrator");
  }
  if (!branchId) {
    if (actor.isCompanyWide) return;
    throw new ReconciliationError("Choose a branch inside your scope");
  }
  if (!(await assertBranchAccess(actor.ctx, branchId, "write"))) {
    throw new ReconciliationError("That branch is outside your scope");
  }
}

/** Finance authority is separate from branch management authority. */
export async function actorHasFinanceAuthority(
  actor: ReconciliationActor,
  branchId: string | null | undefined
): Promise<boolean> {
  if (actor.kind !== "admin") return false;
  if (actor.isCompanyWide) return true;
  if (!branchId) return false;
  if (actor.branchIds.includes(branchId)) {
    return hasActiveBranchRole(
      actor.ctx.tenantId,
      actor.ctx.userId,
      branchId,
      "finance"
    );
  }
  return false;
}

export async function assertFinanceAuthority(
  actor: ReconciliationActor,
  branchId: string | null | undefined
): Promise<void> {
  if (!(await actorHasFinanceAuthority(actor, branchId))) {
    throw new ReconciliationError(
      "A company administrator or this branch's finance user must approve this resolution"
    );
  }
}

export interface CaseScopeRecord {
  id: string;
  tenantId: string | null;
  branchId: string | null;
  collectorId: string | null;
  ownerId: string | null;
  status: string;
}

export function canReadCase(
  actor: ReconciliationActor,
  record: CaseScopeRecord
): boolean {
  if (record.tenantId !== actor.ctx.tenantId) return false;
  if (actor.kind === "collector") {
    return Boolean(actor.collectorId && record.collectorId === actor.collectorId);
  }
  return actorAllowsBranch(actor, record.branchId);
}

export function canManageCase(
  actor: ReconciliationActor,
  record: CaseScopeRecord
): boolean {
  return actor.kind === "admin" && canReadCase(actor, record);
}

export function assertCanReadCase(
  actor: ReconciliationActor,
  record: CaseScopeRecord
): void {
  if (!canReadCase(actor, record)) {
    throw new ReconciliationError("That case was not found.");
  }
}

export function assertCanManageCase(
  actor: ReconciliationActor,
  record: CaseScopeRecord
): void {
  if (!canManageCase(actor, record)) {
    throw new ReconciliationError("You are not authorised to manage that case.");
  }
}

/**
 * An assignee must be an active administrator in this tenant and must have
 * access to the case branch. A company-wide admin can be assigned anywhere.
 */
export async function validateCaseOwner(params: {
  tenantId: string;
  ownerId: string;
  branchId: string | null;
}): Promise<{ id: string; fullName: string }> {
  const owner = await db.user.findFirst({
    where: {
      id: params.ownerId,
      tenantId: params.tenantId,
      role: "admin",
      status: "active",
    },
    select: { id: true, fullName: true, role: true },
  });
  if (!owner) {
    throw new ReconciliationError("Choose an active administrator at this business");
  }
  const scope = await resolveUserBranchScope(
    params.tenantId,
    owner.id,
    owner.role
  );
  if (params.branchId) {
    if (scope.kind === "limited" && !scope.branchIds.includes(params.branchId)) {
      throw new ReconciliationError(
        "That administrator does not have access to the case branch"
      );
    }
  } else if (scope.kind === "limited") {
    throw new ReconciliationError(
      "Only a company-wide administrator can own a legacy unassigned case"
    );
  }
  return { id: owner.id, fullName: owner.fullName };
}
