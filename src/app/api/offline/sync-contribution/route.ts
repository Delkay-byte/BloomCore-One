import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getApiTenantContext, type TenantContext } from "@/lib/tenant";
import { createAuditLog, createAuditLogTx } from "@/lib/audit";
import { isSameOriginRequest, crossOriginDenied } from "@/lib/security/same-origin";
import { lockAccountForUpdate } from "@/lib/db-lock";
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
    public reasonCode: string,
    public reason: string,
    public retryable: boolean
  ) {
    super(reason);
    this.name = "SyncRejected";
  }
}

/**
 * Record an offline sync attempt for authorized administrative visibility.
 * Safe context only — no encrypted payload, no device key, no authentication
 * material. Collectors cannot write these rows. `tenantId` is null when the
 * request could not be authenticated to a tenant.
 */
async function recordSyncAttempt(args: {
  tenantId: string | null;
  userId: string;
  deviceId?: string | null;
  idempotencyKey?: string | null;
  accountId?: string | null;
  collectorId?: string | null;
  amount?: number | null;
  capturedAt?: Date | null;
  payloadDigest?: string | null;
  outcome: "accepted" | "already_synced" | "rejected" | "failed";
  reasonCode?: string | null;
  reason?: string | null;
  retryable?: boolean;
  httpStatus?: number | null;
}) {
  try {
    await db.offlineSyncAttempt.create({
      data: {
        tenantId: args.tenantId ?? undefined,
        kind: "contribution",
        outcome: args.outcome,
        reasonCode: args.reasonCode ?? null,
        reason: args.reason ?? null,
        retryable: args.retryable ?? false,
        httpStatus: args.httpStatus ?? null,
        userId: args.userId,
        deviceId: args.deviceId ?? null,
        idempotencyKey: args.idempotencyKey ?? null,
        accountId: args.accountId ?? null,
        collectorId: args.collectorId ?? null,
        amount: args.amount == null ? null : args.amount,
        capturedAt: args.capturedAt ?? null,
        payloadDigest: args.payloadDigest ?? null,
      },
    });
  } catch {
    // Observability must never break the sync path itself.
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
 *
 * Phase 2 additions:
 *   * `capturedAt` from the normalized payload is stored on the contribution
 *     as evidence only — collectionDate remains the server posting time used
 *     for financial ordering and period reporting.
 *   * Every rejection/failure is traced in OfflineSyncAttempt so authorized
 *     administrators can review failed syncs (reason, retryability, collector
 *     and device context, timestamps) without exposing payloads.
 *   * A collector cannot alter the administrative synchronization history.
 */
export async function POST(request: NextRequest) {
  let deviceId = "unknown";
  let idempotencyKey: string | undefined;
  let ctx: TenantContext | null = null;
  try {
    if (!isSameOriginRequest(request)) return crossOriginDenied();
    const body = await request.json();
    const { idempotencyKey: incomingKey, payload, deviceId: incomingDeviceId } = body;
    deviceId = typeof incomingDeviceId === "string" ? incomingDeviceId : "unknown";
    idempotencyKey = typeof incomingKey === "string" ? incomingKey : undefined;

    if (!idempotencyKey || !payload || deviceId === "unknown") {
      await recordSyncAttempt({
        tenantId: null,
        userId: "unknown",
        deviceId,
        outcome: "rejected",
        reasonCode: "missing_fields",
        reason: "Missing required fields",
        httpStatus: 400,
      });
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      );
    }

    // 1. Authenticate + resolve tenant (Susu module required).
    ctx =
      (await getApiTenantContext("susu", "susu")) ??
      (await getApiTenantContext("admin", "susu")) ??
      // A dual-role user may have switched to the Susu dashboard locally while
      // offline; the tab's server session can still be the MoMo module. The
      // requiredModule check still proves the user and tenant are authorized
      // for Susu, so this is not a browser-selected role.
      (await getApiTenantContext("momo", "susu"));
    if (!ctx) {
      await recordSyncAttempt({
        tenantId: null,
        userId: "unknown",
        deviceId,
        outcome: "rejected",
        reasonCode: "not_authenticated",
        reason: "Not authenticated",
        httpStatus: 401,
      });
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
      await recordSyncAttempt({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        deviceId,
        outcome: "rejected",
        reasonCode: "rate_limited",
        reason: "Too many synchronization attempts",
        httpStatus: 429,
      });
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
      await recordSyncAttempt({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        deviceId,
        outcome: "rejected",
        reasonCode: "device_revoked",
        reason: "Device not enrolled or revoked",
        httpStatus: 403,
      });
      return NextResponse.json(
        {
          success: false,
          error: "Device not enrolled or revoked",
          code: "device_revoked",
        },
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
      await recordSyncAttempt({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        deviceId,
        outcome: "rejected",
        reasonCode: "offline_auth_expired",
        reason: "Offline authorization expired",
        httpStatus: 403,
      });
      return NextResponse.json(
        {
          success: false,
          error: "Offline authorization expired. Please reconnect and sign in again.",
          code: "offline_auth_expired",
        },
        { status: 403 }
      );
    }

    // 3. Idempotency key format. The key is globally unique and immutable.
    if (!idempotencyKeyIsValid(idempotencyKey)) {
      await recordSyncAttempt({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        deviceId,
        idempotencyKey,
        outcome: "rejected",
        reasonCode: "invalid_idempotency_key",
        reason: "Invalid idempotency key",
        httpStatus: 400,
      });
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
      await recordSyncAttempt({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        deviceId,
        idempotencyKey,
        outcome: "rejected",
        reasonCode: "invalid_payload",
        reason: "Invalid transaction payload",
        httpStatus: 400,
      });
      return NextResponse.json(
        { success: false, error: "Invalid transaction payload" },
        { status: 400 }
      );
    }

    const normalized = normalizeContributionPayload(rawPayload);
    if (!normalized.ok) {
      await recordSyncAttempt({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        deviceId,
        idempotencyKey,
        outcome: "rejected",
        reasonCode: "invalid_payload",
        reason: normalized.error,
        httpStatus: 400,
      });
      return NextResponse.json(
        { success: false, error: normalized.error },
        { status: 400 }
      );
    }

    const { accountId, amount, channel, notes, capturedAt } =
      normalized.payload;

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
        await recordSyncAttempt({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          deviceId,
          idempotencyKey,
          accountId,
          amount,
          capturedAt,
          payloadDigest: normalized.hash,
          outcome: "rejected",
          reasonCode: "key_not_available",
          reason: "Transaction key is not available",
          httpStatus: 409,
        });
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
        await recordSyncAttempt({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          deviceId,
          idempotencyKey,
          accountId,
          amount,
          capturedAt,
          payloadDigest: normalized.hash,
          outcome: "rejected",
          reasonCode: "payload_mismatch",
          reason: "This transaction key was already used for a different transaction",
          httpStatus: 409,
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

        await recordSyncAttempt({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          deviceId,
          idempotencyKey,
          accountId,
          amount,
          capturedAt,
          payloadDigest: normalized.hash,
          outcome: "already_synced",
          reason: "Transaction already processed",
          httpStatus: 200,
        });

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
      await recordSyncAttempt({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        deviceId,
        idempotencyKey,
        accountId,
        amount,
        capturedAt,
        payloadDigest: normalized.hash,
        outcome: "rejected",
        reasonCode: "not_authorized_channel",
        reason: "Not authorized for this collection channel",
        httpStatus: 403,
      });
      return NextResponse.json(
        { success: false, error: "Not authorized for this collection channel" },
        { status: 403 }
      );
    }

    // 6. Fetch the account — TENANT SCOPED. A foreign account id resolves to
    //    null here and is reported as "not found", never as another tenant's data.
    const account = await db.susuAccount.findFirst({
      where: { id: accountId, tenantId: ctx.tenantId },
      include: {
        cycles: { where: { status: "active" }, take: 1 },
        customer: true,
      },
    });
    if (!account) {
      await recordSyncAttempt({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        deviceId,
        idempotencyKey,
        accountId,
        amount,
        capturedAt,
        payloadDigest: normalized.hash,
        outcome: "rejected",
        reasonCode: "account_not_found",
        reason: "Account not found",
        httpStatus: 404,
      });
      return NextResponse.json(
        { success: false, error: "Account not found" },
        { status: 404 }
      );
    }
    if (account.status !== "active") {
      await recordSyncAttempt({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        deviceId,
        idempotencyKey,
        accountId,
        amount,
        capturedAt,
        payloadDigest: normalized.hash,
        outcome: "rejected",
        reasonCode: "account_inactive",
        reason: "Account is not active",
        httpStatus: 400,
      });
      return NextResponse.json(
        { success: false, error: "Account is not active" },
        { status: 400 }
      );
    }
    if (!account.cycles.length) {
      await recordSyncAttempt({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        deviceId,
        idempotencyKey,
        accountId,
        amount,
        capturedAt,
        payloadDigest: normalized.hash,
        outcome: "rejected",
        reasonCode: "no_active_cycle",
        reason: "No active cycle",
        httpStatus: 400,
      });
      return NextResponse.json(
        { success: false, error: "No active cycle" },
        { status: 400 }
      );
    }

    // 7. Collector authorization (tenant scoped)
    let effectiveCollectorId: string | null = null;
    if (channel === "collector") {
      const userCollector = await db.collector.findFirst({
        where: { userId: ctx.userId, tenantId: ctx.tenantId, status: "active" },
        select: { id: true },
      });
      if (!userCollector) {
        await recordSyncAttempt({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          deviceId,
          idempotencyKey,
          accountId,
          amount,
          capturedAt,
          payloadDigest: normalized.hash,
          outcome: "rejected",
          reasonCode: "collector_not_found",
          reason: "Collector record not found",
          httpStatus: 403,
        });
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
        await recordSyncAttempt({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          deviceId,
          idempotencyKey,
          accountId,
          amount,
          capturedAt,
          collectorId: effectiveCollectorId,
          payloadDigest: normalized.hash,
          outcome: "rejected",
          reasonCode: "assignment_not_found",
          reason: "Customer not assigned to this collector",
          httpStatus: 403,
        });
        return NextResponse.json(
          { success: false, error: "Customer not assigned to this collector" },
          { status: 403 }
        );
      }
    }

    const cycle = account.cycles[0];
    const dailyContribution = Number(cycle.dailyContribution);
    if (!Number.isFinite(dailyContribution) || dailyContribution <= 0) {
      await recordSyncAttempt({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        deviceId,
        idempotencyKey,
        accountId,
        amount,
        capturedAt,
        payloadDigest: normalized.hash,
        outcome: "rejected",
        reasonCode: "invalid_rate",
        reason: "Account has an invalid contribution rate",
        httpStatus: 400,
      });
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
      await recordSyncAttempt({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        deviceId,
        idempotencyKey,
        accountId,
        amount,
        capturedAt,
        payloadDigest: normalized.hash,
        outcome: "rejected",
        reasonCode: "invalid_amount",
        reason: "Amount must equal a whole number of contribution days",
        httpStatus: 400,
      });
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
            capturedAt,
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
            await recordSyncAttempt({
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              deviceId,
              idempotencyKey,
              accountId,
              amount,
              capturedAt,
              payloadDigest: normalized.hash,
              outcome: "rejected",
              reasonCode: "key_race",
              reason: "Transaction is already being processed",
              httpStatus: 409,
            });
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

    // 8. Contribution + allocations, all stamped with the tenant.
    let reconciled = false;
    let result: {
      contributionId: string;
      daysAllocated: number;
      allocatedAmount: number;
    };
    // ctx and idempotencyKey are both non-null here: the caller returned early
    // if the tenant could not be resolved or the idempotency key was absent.
    const tenantId = ctx!.tenantId;
    const userId = ctx!.userId;
    const key = idempotencyKey!;
    try {
      result = await db.$transaction(async (tx) => {
      // Serialize day allocation for this Susu account, exactly like the
      // online contribution path. Without the lock two offline syncs with
      // different idempotency keys can both observe the same unpaid days and
      // allocate them twice.
      await lockAccountForUpdate(tx, accountId);
      const existingAllocations = await tx.contributionAllocation.findMany({
        where: { contribution: { cycleId: cycle.id, reversedAt: null }, tenantId },
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
            tenantId,
            contributionId: "",
            cycleDay: day,
            amount: dailyContribution,
          });
        }
      }

      if (allocations.length < daysCovered) {
        throw new SyncRejected(
          400,
          "insufficient_days",
          "This cycle does not have enough unpaid days for that amount",
          false
        );
      }

      const contribution = await tx.contribution.create({
        data: {
          tenantId,
          accountId,
          cycleId: cycle.id,
          amount,
          collectionDate: new Date(),
          channel,
          collectorId: effectiveCollectorId,
          recordedById: userId,
          recordedDeviceId: device.deviceId,
          recordedDeviceName: device.deviceName,
          capturedAt,
          referenceId: contributionReference(key),
          notes,
        },
      });

      await tx.contributionAllocation.createMany({
        data: allocations.map((allocation) => ({
          ...allocation,
          contributionId: contribution.id,
        })),
      });

      const outcome = {
        contributionId: contribution.id,
        daysAllocated: allocations.length,
        allocatedAmount: Number(allocatedAmount),
      };

      // The posting, its audit evidence and the local queue acknowledgement are
      // one unit. A crash can no longer leave a posted contribution without an
      // audit row, or a synced queue item without a posting.
      await createAuditLogTx(tx, {
        userId,
        tenantId,
        action: "susu.contribution_recorded",
        entityType: "contribution",
        entityId: contribution.id,
        details: {
          accountId,
          amount,
          channel,
          daysAllocated: outcome.daysAllocated,
          idempotencyKey: key,
          source: "offline_sync",
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          recordedById: userId,
          capturedAt,
        },
      });

      const acknowledged = await tx.offlineTransaction.updateMany({
        where: {
          idempotencyKey: key,
          tenantId,
          userId,
          deviceId: device.deviceId,
        },
        data: {
          status: "synced",
          syncedAt: new Date(),
          serverResult: JSON.stringify(outcome),
        },
      });
      if (acknowledged.count !== 1) {
        throw new Error("OFFLINE_QUEUE_RESERVATION_MISSING");
      }

      return outcome;
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

    // 9. A reconciled duplicate already has the original posting and audit.
    //    Its queue row still needs the stored result so the device can clear it.
    if (reconciled) {
      await db.offlineTransaction.update({
        where: { idempotencyKey: key },
        data: {
          status: "synced",
          syncedAt: new Date(),
          serverResult: JSON.stringify(result),
        },
      });
    }

    // 10. Extend the offline window. The response carries the server timestamp so
    // the device can reconcile its local expiry without another request.
    const renewedAt = new Date();
    await db.deviceEnrollment.update({
      where: { id: device.id },
      data: { lastSyncAt: renewedAt, authorizedAt: renewedAt },
    });

    await recordSyncAttempt({
      tenantId,
      userId,
      deviceId,
      idempotencyKey: key,
      accountId,
      amount,
      collectorId: effectiveCollectorId,
      capturedAt,
      payloadDigest: normalized.hash,
      outcome: "accepted",
      reason: "Transaction processed",
      httpStatus: 200,
    });

    return NextResponse.json({
      success: true,
      contributionId: result.contributionId,
      daysAllocated: result.daysAllocated,
      allocatedAmount: result.allocatedAmount,
      reconciled,
      authorizedAt: renewedAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof SyncRejected) {
      await recordSyncAttempt({
        tenantId: ctx ? ctx.tenantId : null,
        userId: ctx ? ctx.userId : "unknown",
        deviceId,
        idempotencyKey,
        outcome: "rejected",
        reasonCode: err.reasonCode,
        reason: err.reason,
        retryable: err.retryable,
        httpStatus: err.status,
      });
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
      await recordSyncAttempt({
        tenantId: ctx ? ctx.tenantId : null,
        userId: ctx ? ctx.userId : "unknown",
        deviceId,
        idempotencyKey,
        outcome: "rejected",
        reasonCode: "key_race",
        reason: "Transaction is already being processed",
        httpStatus: 409,
      });
      return NextResponse.json(
        { success: false, error: "Transaction is already being processed" },
        { status: 409 }
      );
    }
    await recordSyncAttempt({
      tenantId: ctx ? ctx.tenantId : null,
      userId: ctx ? ctx.userId : "unknown",
      deviceId,
      idempotencyKey,
      outcome: "failed",
      reasonCode: "internal_error",
      reason: "Internal server error",
      retryable: true,
      httpStatus: 500,
    });
    console.error("[offline-sync]", err instanceof Error ? err.name : "UnknownError", (err as { code?: unknown })?.code ?? "no-code");
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
