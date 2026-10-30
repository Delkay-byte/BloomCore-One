import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getApiTenantContext, type TenantContext } from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";

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

    // 3. Idempotency — scoped to this tenant.
    const existing = await db.offlineTransaction.findFirst({
      where: { idempotencyKey, tenantId: ctx.tenantId },
    });
    if (existing && existing.status === "synced") {
      return NextResponse.json({
        success: true,
        serverResult: existing.serverResult
          ? JSON.parse(existing.serverResult)
          : null,
        message: "Transaction already processed",
      });
    }

    // 4. Parse payload
    let txPayload: {
      accountId: string;
      amount: number;
      channel: string;
      notes?: string;
      collectorId?: string;
    };
    try {
      txPayload = JSON.parse(payload);
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid transaction payload" },
        { status: 400 }
      );
    }

    const { accountId, amount, channel, notes } = txPayload;

    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid amount" },
        { status: 400 }
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

    // 7. Contribution + allocations, all stamped with the tenant.
    const result = await db.$transaction(async (tx) => {
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
          referenceId: idempotencyKey,
          notes,
        },
      });

      const daysCovered = Math.floor(amount / dailyContribution);
      const allocatedAmount = daysCovered * dailyContribution;

      const existingAllocations = await tx.contributionAllocation.findMany({
        where: { contribution: { cycleId: cycle.id }, tenantId: ctx.tenantId },
      });
      const paidDays = new Set(existingAllocations.map((a) => a.cycleDay));

      const allocations: {
        tenantId: string;
        contributionId: string;
        cycleDay: number;
        amount: number;
      }[] = [];
      let daysAllocated = 0;
      for (let day = 1; day <= 31 && daysAllocated < daysCovered; day++) {
        if (!paidDays.has(day)) {
          allocations.push({
            tenantId: ctx.tenantId,
            contributionId: contribution.id,
            cycleDay: day,
            amount: dailyContribution,
          });
          daysAllocated++;
        }
      }
      if (allocations.length > 0) {
        await tx.contributionAllocation.createMany({ data: allocations });
      }

      return {
        contributionId: contribution.id,
        daysAllocated,
        allocatedAmount: Number(allocatedAmount),
      };
    });

    // 8. Record the offline transaction as synced (tenant scoped)
    await db.offlineTransaction.upsert({
      where: { idempotencyKey },
      create: {
        tenantId: ctx.tenantId,
        deviceId,
        userId: ctx.userId,
        type: "contribution",
        idempotencyKey,
        payload: JSON.stringify(txPayload),
        status: "synced",
        retryCount: 0,
        maxRetries: 5,
        localTimestamp: new Date(),
        syncedAt: new Date(),
        serverResult: JSON.stringify(result),
      },
      update: {
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

    // 10. Audit
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

    return NextResponse.json({
      success: true,
      contributionId: result.contributionId,
      daysAllocated: result.daysAllocated,
      allocatedAmount: result.allocatedAmount,
    });
  } catch (err) {
    console.error("[offline-sync]", err);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
