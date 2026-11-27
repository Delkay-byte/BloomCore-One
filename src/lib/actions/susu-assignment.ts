"use server";

/**
 * Customer-to-collector assignment integrity for MaaCash Susu.
 *
 * Every operation resolves the tenant from the verified session and asserts
 * tenant ownership on the collector, customer and account. A transfer records
 * append-only history (previous collector, new collector, actor, timestamp,
 * reason) and never rewrites the historical collector attribution of past
 * contributions — contributions stay stamped with the collector who actually
 * collected them.
 *
 * Atomic transfer uses `activeAccountKey`: exactly one active assignment per
 * account may exist at any time (database unique index on a non-null key),
 * so concurrent reassignments cannot both pass a pre-check.
 *
 * Created by Agent 2 (Phase 2: Collector Management and Field Operations).
 */

import { db } from "@/lib/db";
import { createAuditLogTx } from "@/lib/audit";
import {
  requireTenantAdminSusu,
  assertTenantEntity,
} from "@/lib/tenant";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";

interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface AssignmentView {
  id: string;
  collectorId: string;
  customerId: string;
  accountId: string;
  active: boolean;
  assignedAt: Date;
  unassignedAt?: Date | null;
  assignedById?: string | null;
  customer: { id: string; customerId: string; fullName: string; status: string };
  account: { id: string; accountId: string; status: string };
}

export interface AssignmentHistoryRow {
  id: string;
  kind: string;
  reason?: string | null;
  actorId: string;
  createdAt: Date;
  previousCollectorId?: string | null;
  newCollectorId?: string | null;
  collectorId?: string | null;
}

/**
 * Assign a customer account to a collector inside the same tenant.
 *
 * Validations:
 *   1. Customer, collector and account all belong to the same tenant.
 *   2. The collector is active and eligible to receive assignments.
 *   3. No conflicting active assignment exists for the account (database
 *      invariant via `activeAccountKey`).
 *   4. Assignment is atomic: one row is inserted inside the transaction.
 */
export async function assignCustomerToCollector(params: {
  collectorId: string;
  customerId: string;
  accountId: string;
  reason?: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  const { collectorId, customerId, accountId, reason } = params;

  for (const [model, id] of [
    ["collector", collectorId],
    ["customer", customerId],
    ["susuAccount", accountId],
  ] as const) {
    if (!(await assertTenantEntity(model, id, ctx))) {
      return { success: false, error: "Record not found or not in your tenant" };
    }
  }

  const collector = await db.collector.findFirst({
    where: { id: collectorId, tenantId: ctx.tenantId },
    include: { user: { select: { id: true, status: true } } },
  });
  if (!collector) return { success: false, error: "Collector not found" };
  if (collector.user.status !== "active") {
    return {
      success: false,
      error: `Collector is ${collector.user.status} and cannot receive new assignments`,
    };
  }

  const rate = await consumeRateLimit(
    "finance:collector_assignment",
    `${ctx.tenantId}:${ctx.userId}`,
    RATE_LIMITS.financeMutation
  );
  if (!rate.allowed) {
    return { success: false, error: "Too many assignment actions. Please wait and try again." };
  }

  let assignmentId = "";
  let created = false;

  try {
    await db.$transaction(async (tx) => {
      // Re-check inside the transaction so two concurrent assignments cannot
      // both observe "no active assignment" and insert twice.
      const current = await tx.collectorCustomerAssignment.findFirst({
        where: { accountId, tenantId: ctx.tenantId, active: true },
      });
      if (current) {
        if (current.collectorId === collectorId) {
          throw new Error("ALREADY_ASSIGNED");
        }
        throw new Error("ACCOUNT_ASSIGNED_ELSEWHERE");
      }

      const assignment = await tx.collectorCustomerAssignment.create({
        data: {
          tenantId: ctx.tenantId,
          collectorId,
          customerId,
          accountId,
          active: true,
          activeAccountKey: accountId,
          assignedById: ctx.userId,
        },
      });
      assignmentId = assignment.id;
      created = true;

      await tx.collectorAssignmentEvent.create({
        data: {
          tenantId: ctx.tenantId,
          assignmentId,
          customerId,
          accountId,
          collectorId,
          previousCollectorId: null,
          newCollectorId: collectorId,
          kind: "assigned",
          reason: reason?.trim() ?? null,
          actorId: ctx.userId,
        },
      });

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "susu.customer_assigned_to_collector",
        entityType: "collector_assignment",
        entityId: assignmentId,
        details: { collectorId, customerId, accountId, reason: reason?.trim() ?? null },
      });
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "ALREADY_ASSIGNED") {
        return { success: false, error: "Customer is already assigned to this collector" };
      }
      if (error.message === "ACCOUNT_ASSIGNED_ELSEWHERE") {
        return { success: false, error: "Account already has an active assignment. Use transfer to reassign." };
      }
    }
    throw error;
  }

  return { success: true, data: { assignmentId, created } };
}

/**
 * Atomically transfer an account from its current active collector to a new
 * collector within the same tenant.
 *
 *   - Both collectors must belong to the same tenant and be active.
 *   - The transfer must be initiated against the account's current active
 *     assignment (validates the `fromCollectorId`).
 *   - A mandatory transfer reason is required.
 *   - Previous collector, new collector, actor, timestamp and reason recorded
 *     in append-only history.
 *   - Historical contribution collector attribution is never altered.
 */
export async function transferCustomerAssignment(params: {
  collectorId: string;   // new collector
  customerId: string;
  accountId: string;
  fromCollectorId: string; // current active collector (must match the assignment)
  reason: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  const { collectorId, customerId, accountId, fromCollectorId, reason } = params;

  const trimmedReason = reason?.trim();
  if (!trimmedReason || trimmedReason.length < 5) {
    return { success: false, error: "A transfer reason of at least 5 characters is required" };
  }

  if (collectorId === fromCollectorId) {
    return { success: false, error: "New collector must differ from the current collector" };
  }

  for (const [model, id] of [
    ["collector", collectorId],
    ["collector", fromCollectorId],
    ["customer", customerId],
    ["susuAccount", accountId],
  ] as const) {
    if (!(await assertTenantEntity(model, id, ctx))) {
      return { success: false, error: "Record not found or not in your tenant" };
    }
  }

  const rate = await consumeRateLimit(
    "finance:collector_assignment",
    `${ctx.tenantId}:${ctx.userId}`,
    RATE_LIMITS.financeMutation
  );
  if (!rate.allowed) {
    return { success: false, error: "Too many assignment actions. Please wait and try again." };
  }

  const result = await (async () => {
    try {
      return await db.$transaction(async (tx) => {
        const current = await tx.collectorCustomerAssignment.findFirst({
          where: { accountId, tenantId: ctx.tenantId, active: true },
          include: { collector: { include: { user: { select: { id: true } } } } },
        });

        if (!current) {
          throw new Error("NO_ACTIVE_ASSIGNMENT");
        }
        if (current.collectorId !== fromCollectorId) {
          throw new Error("WRONG_CURRENT_COLLECTOR");
        }

        const newCollector = await tx.collector.findFirst({
          where: { id: collectorId, tenantId: ctx.tenantId },
          include: { user: { select: { id: true, status: true } } },
        });
        if (!newCollector) throw new Error("NEW_COLLECTOR_NOT_FOUND");
        if (newCollector.user.status !== "active") {
          throw new Error("NEW_COLLECTOR_NOT_ACTIVE");
        }

        // Release the current assignment. The unique index on activeAccountKey
        // (NULL rows never collide) lets us clear the old key before claiming the
        // new one in the same transaction.
        await tx.collectorCustomerAssignment.update({
          where: { id: current.id },
          data: {
            active: false,
            unassignedAt: new Date(),
            activeAccountKey: null,
          },
        });

        await tx.collectorAssignmentEvent.create({
          data: {
            tenantId: ctx.tenantId,
            assignmentId: current.id,
            customerId,
            accountId,
            collectorId: null,
            previousCollectorId: fromCollectorId,
            newCollectorId: null,
            kind: "unassigned",
            reason: trimmedReason,
            actorId: ctx.userId,
          },
        });

        const next = await tx.collectorCustomerAssignment.create({
          data: {
            tenantId: ctx.tenantId,
            collectorId,
            customerId,
            accountId,
            active: true,
            activeAccountKey: accountId,
            assignedById: ctx.userId,
          },
        });

        await tx.collectorAssignmentEvent.create({
          data: {
            tenantId: ctx.tenantId,
            assignmentId: next.id,
            customerId,
            accountId,
            collectorId,
            previousCollectorId: fromCollectorId,
            newCollectorId: collectorId,
            kind: "transferred",
            reason: trimmedReason,
            actorId: ctx.userId,
          },
        });

        await createAuditLogTx(tx, {
          userId: ctx.userId,
          tenantId: ctx.tenantId,
          action: "susu.customer_transferred_between_collectors",
          entityType: "collector_assignment",
          entityId: next.id,
          details: {
            accountId,
            customerId,
            previousCollectorId: fromCollectorId,
            newCollectorId: collectorId,
            reason: trimmedReason,
            actor: ctx.userId,
          },
        });

        return { success: true, data: { assignmentId: next.id } };
      }) as
        | { success: true; data: { assignmentId: string } }
        | Error;
    } catch (error) {
      if (error instanceof Error) return error;
      throw error;
    }
  })();

  if (result instanceof Error) {
    if (result.message === "NO_ACTIVE_ASSIGNMENT") {
      return { success: false, error: "No active assignment exists for this account" };
    }
    if (result.message === "WRONG_CURRENT_COLLECTOR") {
      return {
        success: false,
        error: "Transfer must be initiated against the account's current active collector",
      };
    }
    if (result.message === "NEW_COLLECTOR_NOT_FOUND") {
      return { success: false, error: "New collector not found" };
    }
    if (result.message === "NEW_COLLECTOR_NOT_ACTIVE") {
      return { success: false, error: "New collector is not active and cannot receive assignments" };
    }
    throw result;
  }

  return result;
}

/**
 * Deactivate an active assignment (unassign a customer from a collector).
 * History is preserved; contributions retain their original collector.
 */
export async function removeCustomerFromCollector(params: {
  assignmentId: string;
  reason?: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  if (!(await assertTenantEntity("collectorCustomerAssignment", params.assignmentId, ctx))) {
    return { success: false, error: "Assignment not found" };
  }

  const row = await db.collectorCustomerAssignment.findFirst({
    where: { id: params.assignmentId, tenantId: ctx.tenantId },
  });
  if (!row || !row.active) {
    return { success: false, error: "Assignment not found or already inactive" };
  }

  await db.$transaction(async (tx) => {
    await tx.collectorCustomerAssignment.update({
      where: { id: params.assignmentId },
      data: { active: false, unassignedAt: new Date(), activeAccountKey: null },
    });

    await tx.collectorAssignmentEvent.create({
      data: {
        tenantId: ctx.tenantId,
        assignmentId: params.assignmentId,
        customerId: row.customerId,
        accountId: row.accountId,
        collectorId: null,
        previousCollectorId: row.collectorId,
        newCollectorId: null,
        kind: "unassigned",
        reason: params.reason?.trim() ?? null,
        actorId: ctx.userId,
      },
    });

    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "susu.customer_removed_from_collector",
      entityType: "collector_assignment",
      entityId: params.assignmentId,
      details: {
        customerId: row.customerId,
        accountId: row.accountId,
        reason: params.reason?.trim() ?? null,
      },
    });
  });

  return { success: true };
}

/**
 * List assignments for a tenant, optionally scoped to one collector or account.
 */
export async function listAssignments(params?: {
  collectorId?: string;
  accountId?: string;
  activeOnly?: boolean;
}) {
  const ctx = await requireTenantAdminSusu();

  const where: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (params?.collectorId) where.collectorId = params.collectorId;
  if (params?.accountId) where.accountId = params.accountId;
  if (params?.activeOnly !== undefined) where.active = params.activeOnly;

  return db.collectorCustomerAssignment.findMany({
    where,
    include: {
      collector: { include: { user: { select: { fullName: true, status: true } } } },
      customer: { select: { customerId: true, fullName: true, status: true } },
      account: { select: { accountId: true, status: true } },
    },
    orderBy: { assignedAt: "desc" },
  });
}

/**
 * Append-only assignment history for one account, most recent first.
 * Returns null when the account does not belong to the tenant.
 */
export async function getAssignmentHistory(accountId: string) {
  const ctx = await requireTenantAdminSusu();

  if (!(await assertTenantEntity("susuAccount", accountId, ctx))) {
    return null;
  }

  return db.collectorAssignmentEvent.findMany({
    where: { accountId, tenantId: ctx.tenantId },
    include: {
      assignment: {
        include: { customer: { select: { fullName: true } } },
      },
      collector: { select: { id: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}
