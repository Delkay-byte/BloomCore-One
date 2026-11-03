import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getApiTenantContext, type TenantContext } from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";
import { isSameOriginRequest, crossOriginDenied } from "@/lib/security/same-origin";
import { consumeRateLimit, retryAfterSeconds } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import {
  idempotencyKeyIsValid,
  normalizeContributionPayload,
  payloadDigestForStored,
} from "@/lib/offline/payload";

/**
 * The online contribution action stores `CON-<key>` as its reference. The
 * offline route uses the same convention so a request that timed out after the
 * server committed is reconciled by the retry instead of posted twice.
 */
function contributionReference(idempotencyKey: string): string {
  return idempotencyKey.startsWith("CON-")
    ? idempotencyKey
    : `CON-${idempotencyKey}`;
}

class SyncRejected extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * POST /api/offline/sync-contribution
 *
 * Receives an offline contribution transaction and processes it idempotently.
 *
 * Isolation: the tenant is resolved from the session, and every referenced
 * entity (device, account, collector, cycle) is verified to belong to that
 * tenant before use. The account id arrives from the client, so it is treated
 * as untrusted input — a collector from one business cannot post a
 * contribution against another business's account by supplying its id.
 */
export async function POST(request: NextRequest) {
  try {
    if (!isSameOriginRequest(request)) return crossOriginDenied();
    const body = await request.json();
    const { idempotencyKey, payload, deviceId } = body;

    if (!idempotencyKey || !payload || !deviceId) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      );
    }

    // 1. Authenticate + resolve tenant (Susu module required).
    const ctx: TenantContext | null =
      (await getApiTenantContext("susu", "susu")) ??
      (await getApiTenantContext("admin", "susu"));
    if (!ctx) {
      return NextResponse.json(
        { success: false, error: "Not authenticated" },
        { status: 401 }
      );
    }

    // 1b. Persistent per-user rate limit. A queued batch is allowed to drain
    //     (120 records/minute) while a runaway client or replay loop receives a
    //     real 429 with Retry-After instead of hammering the ledger.
    const rate = await consumeRateLimit(
      "offline:sync",
      ctx.userId,
      RATE_LIMITS.offlineSync
    );
    if (!rate.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: "Too many synchronization attempts. Please wait and try again.",
          retryAfterSeconds: rate.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": retryAfterSeconds(rate) },
        }
      );
    }

    // 2. Verify device enrollment for THIS tenant + offline authorization window
    const device = await db.deviceEnrollment.findFirst({
      where: {
        deviceId,
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        status: "active",
      },
    });
    if (!device) {
      await createAuditLog({
        userId: ctx.userId,
        action: "offline.sync_rejected",
        entityType: "device",
        entityId: deviceId,
        details: { reason: "Device not enrolled or revoked", deviceId },
      });
      return NextResponse.json(
        { success: false, error: "Device not enrolled or revoked" },
        { status: 403 }
      );
    }

    const OFFLINE_AUTH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
    const authorizedAt = device.authorizedAt ?? device.createdAt;
    const timeSinceAuth = Date.now() - new Date(authorizedAt).getTime();
    if (timeSinceAuth > OFFLINE_AUTH_TIMEOUT_MS) {
      await createAuditLog({
        userId: ctx.userId,
        action: "offline.sync_rejected",
        entityType: "device",
        entityId: device.id,
        details: { reason: "Offline authorization expired", deviceId },
      });
      return NextResponse.json(
        {
          success: false,
          error: "Offline authorization expired. Please reconnect and sign in again.",
        },
        { status: 403 }
      );
    }

    // 3. Idempotency key format. The key is globally unique and immutable.
    if (!idempotencyKeyIsValid(idempotencyKey)) {
      return NextResponse.json(
        { success: false, error: "Invalid idempotency key" },
        { status: 400 }
      );
    }

    // 4. Normalize and validate the payload BEFORE consulting the stored key.
    //    An existing key may only ever return or continue the exact original
    //    instruction. Validation also runs first so a malformed retry can never
    //    be mistaken for a match.
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(payload);
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid transaction payload" },
        { status: 400 }
      );
    }

    const normalized = normalizeContributionPayload(rawPayload);
    if (!normalized.ok) {
      return NextResponse.json(
        { success: false, error: normalized.error },
        { status: 400 }
      );
    }

    const { accountId, amount, channel, notes } = normalized.payload;

    // 5. Bind the key to the original normalized payload. The check runs for
    //    every state (pending, syncing, failed, synced), so a changed payload is
    //    never processed under an existing key and never receives the original
    //    success result. Ownership is checked first so a foreign key never
    //    reveals whether its payload matches.
    const existing = await db.offlineTransaction.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      if (
        existing.tenantId !== ctx.tenantId ||
        existing.userId !== ctx.userId ||
        existing.deviceId !== deviceId
      ) {
        return NextResponse.json(
          { success: false, error: "Transaction key is not available" },
          { status: 409 }
        );
      }

      const storedDigest = payloadDigestForStored(existing.payload);
      if (!storedDigest || storedDigest !== normalized.hash) {
        await createAuditLog({
          userId: ctx.userId,
          tenantId: ctx.tenantId,
          action: "offline.sync_rejected",
          entityType: "offline_transaction",
          entityId: existing.id,
          details: {
            reason: "Idempotency key reused with a different payload",
            idempotencyKey,
            deviceId,
          },
        });
        return NextResponse.json(
          {
            success: false,
            error:
              "This transaction key was already used for a different transaction.",
          },
          { status: 409 }
        );
      }

      if (existing.status === "synced") {
        let storedResult: unknown = null;
        if (existing.serverResult) {
          try {
            storedResult = JSON.parse(existing.serverResult);
          } catch {
            storedResult = null;
          }
        }

        // A crash between the ledger commit and the queue update can leave a
        // synced row without a stored result. Reconcile from the unique ledger
        // reference instead of returning an empty success.
        if (!storedResult) {
          const posted = await db.contribution.findFirst({
            where: {
              tenantId: ctx.tenantId,
              referenceId: contributionReference(idempotencyKey),
            },
            include: { allocations: true },
          });
          if (posted) {
            storedResult = {
              contributionId: posted.id,
              daysAllocated: posted.allocations.length,
              allocatedAmount: posted.allocations.reduce(
                (total, allocation) => total + Number(allocation.amount),
                0
              ),
            };
            await db.offlineTransaction.update({
              where: { idempotencyKey },
              data: { serverResult: JSON.stringify(storedResult) },
            });
          }
        }

        return NextResponse.json({
          success: true,
          serverResult: storedResult,
          message: "Transaction already processed",
        });
      }
    }

    // A collector session may only file collector collections (and only for an
    // assigned customer). Office collections require a tenant administrator.
    if (channel !== "collector" && ctx.role !== "admin") {
      return NextResponse.json(
        { success: false, error: "Not authorized for this collection channel" },
        { status: 403 }
      );
    }

    // 5. Fetch the account — TENANT SCOPED. A foreign account id resolves to
    //    null here and is reported as "not found", never as another tenant's data.
    const account = await db.susuAccount.findFirst({
      where: { id: accountId, tenantId: ctx.tenantId },
      include: {
        cycles: { where: { status: "active" }, take: 1 },
        customer: true,
      },
    });
    if (!account) {
      return NextResponse.json(
        { success: false, error: "Account not found" },
        { status: 404 }
      );
    }
    if (account.status !== "active") {
      return NextResponse.json(
        { success: false, error: "Account is not active" },
        { status: 400 }
      );
    }
    if (!account.cycles.length) {
      return NextResponse.json(
        { success: false, error: "No active cycle" },
        { status: 400 }
      );
    }

    // 6. Collector authorization (tenant scoped)
    let effectiveCollectorId: string | null = null;
    if (channel === "collector") {
      const userCollector = await db.collector.findFirst({
        where: { userId: ctx.userId, tenantId: ctx.tenantId, status: "active" },
        select: { id: true },
      });
      if (!userCollector) {
        return NextResponse.json(
          { success: false, error: "Collector record not found" },
          { status: 403 }
        );
      }
      effectiveCollectorId = userCollector.id;

      const assignment = await db.collectorCustomerAssignment.findFirst({
        where: {
          collectorId: effectiveCollectorId,
          accountId,
          tenantId: ctx.tenantId,
          active: true,
        },
      });
      if (!assignment) {
        return NextResponse.json(
          { success: false, error: "Customer not assigned to this collector" },
          { status: 403 }
        );
      }
    }

    const cycle = account.cycles[0];
    const dailyContribution = Number(cycle.dailyContribution);
    if (!Number.isFinite(dailyContribution) || dailyContribution <= 0) {
      return NextResponse.json(
        { success: false, error: "Account has an invalid contribution rate" },
        { status: 400 }
      );
    }

    // Money is validated as a whole number of contribution days. A partial or
    // fractional amount is rejected instead of being silently rounded, which
    // previously credited more than the allocations represented.
    const daysCovered = amount / dailyContribution;
    if (
      !Number.isInteger(daysCovered) ||
      daysCovered < 1 ||
      daysCovered > 31
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Amount must equal a whole number of contribution days",
        },
        { status: 400 }
      );
    }
    const allocatedAmount =
      Math.round(daysCovered * dailyContribution * 100) / 100;

    // Reserve the idempotency key BEFORE moving money. A concurrent or replayed
    // request then loses the unique-key race instead of double-crediting.
    if (!existing) {
      try {
        await db.offlineTransaction.create({
          data: {
            tenantId: ctx.tenantId,
            deviceId,
            userId: ctx.userId,
            type: "contribution",
            idempotencyKey,
            payload: normalized.canonical,
            status: "syncing",
            retryCount: 0,
            maxRetries: 5,
            localTimestamp: new Date(),
          },
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: string }).code === "P2002"
        ) {
          // A concurrent identical request reserved the key first. It is safe
          // to continue only when the raced row has the same owner and the same
          // canonical payload; the unique ledger reference still guarantees one
          // posting. Anything else is rejected.
          const raced = await db.offlineTransaction.findUnique({
            where: { idempotencyKey },
          });
          const racedDigest = raced ? payloadDigestForStored(raced.payload) : null;
          if (
            !raced ||
            raced.tenantId !== ctx.tenantId ||
            raced.userId !== ctx.userId ||
            raced.deviceId !== deviceId ||
            racedDigest !== normalized.hash
          ) {
            return NextResponse.json(
              { success: false, error: "Transaction is already being processed" },
              { status: 409 }
            );
          }
        } else {
          throw error;
        }
      }
    }

    // 7. Contribution + allocations, all stamped with the tenant.
    let reconciled = false;
    let result: {
      contributionId: string;
      daysAllocated: number;
      allocatedAmount: number;
    };
    try {
      result = await db.$transaction(async (tx) => {
      const existingAllocations = await tx.contributionAllocation.findMany({
        where: { contribution: { cycleId: cycle.id, reversedAt: null }, tenantId: ctx.tenantId },
      });
      const paidDays = new Set(existingAllocations.map((a) => a.cycleDay));

      const allocations: {
        tenantId: string;
        contributionId: string;
        cycleDay: number;
        amount: number;
      }[] = [];
      for (let day = 1; day <= 31 && allocations.length < daysCovered; day++) {
        if (!paidDays.has(day)) {
          allocations.push({
            tenantId: ctx.tenantId,
            contributionId: "",
            cycleDay: day,
            amount: dailyContribution,
          });
        }
      }

      if (allocations.length < daysCovered) {
        throw new SyncRejected(
          400,
          "This cycle does not have enough unpaid days for that amount"
        );
      }

      const contribution = await tx.contribution.create({
        data: {
          tenantId: ctx.tenantId,
          accountId,
          cycleId: cycle.id,
          amount,
          collectionDate: new Date(),
          channel,
          collectorId: effectiveCollectorId,
          recordedById: ctx.userId,
          referenceId: contributionReference(idempotencyKey),
          notes,
        },
      });

      await tx.contributionAllocation.createMany({
        data: allocations.map((allocation) => ({
          ...allocation,
          contributionId: contribution.id,
        })),
      });

      return {
        contributionId: contribution.id,
        daysAllocated: allocations.length,
        allocatedAmount: Number(allocatedAmount),
      };
      });
    } catch (error) {
      // The unique `referenceId` is the ledger's idempotency guard. If an
      // earlier attempt posted the contribution but crashed before marking the
      // local queue row, reconcile to that row instead of posting again.
      const duplicate =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "P2002";
      if (!duplicate) throw error;

      const existingContribution = await db.contribution.findFirst({
        where: {
          tenantId: ctx.tenantId,
          referenceId: { in: [contributionReference(idempotencyKey), idempotencyKey] },
        },
        include: { allocations: true },
      });
      if (!existingContribution || existingContribution.tenantId !== ctx.tenantId) {
        throw error;
      }

      reconciled = true;
      result = {
        contributionId: existingContribution.id,
        daysAllocated: existingContribution.allocations.length,
        allocatedAmount: existingContribution.allocations.reduce(
          (total, allocation) => total + Number(allocation.amount),
          0
        ),
      };
    }

    // 8. Record the offline transaction as synced (tenant scoped)
    await db.offlineTransaction.update({
      where: { idempotencyKey },
      data: {
        status: "synced",
        syncedAt: new Date(),
        serverResult: JSON.stringify(result),
      },
    });

    // 9. Extend the offline window
    await db.deviceEnrollment.update({
      where: { id: device.id },
      data: { lastSyncAt: new Date(), authorizedAt: new Date() },
    });

    // 10. Audit (a reconciled retry already recorded the original posting)
    if (!reconciled) {
      await createAuditLog({
        userId: ctx.userId,
        action: "susu.contribution_recorded",
        entityType: "contribution",
        entityId: result.contributionId,
        details: {
          accountId,
          amount,
          channel,
          daysAllocated: result.daysAllocated,
          idempotencyKey,
          source: "offline_sync",
          deviceId,
        },
      });
    }

    return NextResponse.json({
      success: true,
      contributionId: result.contributionId,
      daysAllocated: result.daysAllocated,
      allocatedAmount: result.allocatedAmount,
      reconciled,
    });
  } catch (err) {
    if (err instanceof SyncRejected) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.status }
      );
    }
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { success: false, error: "Transaction is already being processed" },
        { status: 409 }
      );
    }
    console.error("[offline-sync]", err);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
