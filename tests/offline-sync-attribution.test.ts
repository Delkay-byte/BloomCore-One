/**
 * Offline contribution synchronization — attribution and atomic evidence.
 *
 * Exercises the real route against SQLite. A synced offline collection must
 * carry the verified device into the ledger, and the contribution, audit row and
 * queue acknowledgement must commit together.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  prisma,
  cleanDatabase,
  createTestTenant,
} from "./setup";

const state = vi.hoisted(() => ({
  userId: "",
  tenantId: "",
}));

vi.mock("@/lib/tenant", () => ({
  getApiTenantContext: async () => ({
    userId: state.userId,
    tenantId: state.tenantId,
    tenantCode: "W03",
    tenantName: "W03 Tenant",
    role: "admin",
    modules: ["susu"],
    momoEnabled: false,
    susuEnabled: true,
  }),
}));

vi.mock("@/lib/security/same-origin", () => ({
  isSameOriginRequest: () => true,
  crossOriginDenied: () => new Response("denied", { status: 403 }),
}));

import { POST } from "@/app/api/offline/sync-contribution/route";

async function seed() {
  const tenant = await createTestTenant({ susu: true, momo: false });
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `w03-admin-${Date.now()}@test.invalid`,
      fullName: "Offline Collector",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
      susuEnabled: true,
    },
  });
  const customer = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      customerId: `W03-C-${Date.now()}`,
      fullName: "Offline Customer",
      status: "active",
    },
  });
  const account = await prisma.susuAccount.create({
    data: {
      tenantId: tenant.id,
      accountId: `W03-S-${Date.now()}`,
      customerId: customer.id,
      dailyContribution: 10,
      status: "active",
    },
  });
  const cycle = await prisma.susuCycle.create({
    data: {
      tenantId: tenant.id,
      accountId: account.id,
      cycleNumber: 1,
      startDate: new Date("2026-11-01T00:00:00Z"),
      endDate: new Date("2026-11-30T23:59:59Z"),
      dailyContribution: 10,
      status: "active",
    },
  });
  const device = await prisma.deviceEnrollment.create({
    data: {
      tenantId: tenant.id,
      userId: admin.id,
      deviceId: `w03-device-${Date.now()}`,
      deviceName: "Counter tablet",
      module: "susu",
      status: "active",
      authorizedAt: new Date(),
    },
  });
  state.userId = admin.id;
  state.tenantId = tenant.id;
  return { tenant, admin, account, cycle, device };
}

function requestFor(body: Record<string, unknown>) {
  return new NextRequest("https://example.com/api/offline/sync-contribution", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify(body),
  });
}

function payload(accountId: string, amount = 20) {
  return JSON.stringify({ accountId, amount, channel: "direct_office" });
}

async function blockAuditWrites() {
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER fail_offline_audit
    BEFORE INSERT ON "AuditLog"
    BEGIN
      SELECT RAISE(ABORT, 'audit storage unavailable');
    END;
  `);
}

async function dropAuditBlock() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS fail_offline_audit`);
}

beforeEach(async () => {
  await cleanDatabase();
  await dropAuditBlock();
});

afterEach(async () => {
  await dropAuditBlock();
});

describe("offline sync attribution", () => {
  it("stores the verified device, actor snapshot and one atomic audit row", async () => {
    const { tenant, admin, account, device } = await seed();
    const key = `W03-KEY-${Date.now()}`;
    const body = {
      idempotencyKey: key,
      payload: payload(account.id),
      deviceId: device.deviceId,
    };

    const first = await POST(requestFor(body));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.success).toBe(true);

    const contribution = await prisma.contribution.findUniqueOrThrow({
      where: { referenceId: `CON-${key}` },
    });
    expect(contribution.recordedById).toBe(admin.id);
    expect(contribution.recordedDeviceId).toBe(device.deviceId);
    expect(contribution.recordedDeviceName).toBe("Counter tablet");

    const audit = await prisma.auditLog.findMany({
      where: { tenantId: tenant.id, entityId: contribution.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "susu.contribution_recorded",
      actorName: "Offline Collector",
      actorRole: "admin",
      actorType: "user",
    });
    expect(JSON.parse(audit[0].details ?? "{}")).toMatchObject({
      source: "offline_sync",
      deviceId: device.deviceId,
      deviceName: "Counter tablet",
    });

    const queued = await prisma.offlineTransaction.findUniqueOrThrow({
      where: { idempotencyKey: key },
    });
    expect(queued.status).toBe("synced");
    expect(queued.syncedAt).not.toBeNull();

    const retry = await POST(requestFor(body));
    expect(retry.status).toBe(200);
    expect((await retry.json()).message).toBe("Transaction already processed");
    expect(
      await prisma.contribution.count({ where: { referenceId: `CON-${key}` } })
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { tenantId: tenant.id, entityId: contribution.id },
      })
    ).toBe(1);
  });

  it("does not post a contribution when its audit evidence cannot be written", async () => {
    const { tenant, account, device } = await seed();
    const key = `W03-FAIL-${Date.now()}`;

    await blockAuditWrites();
    const response = await POST(
      requestFor({
        idempotencyKey: key,
        payload: payload(account.id),
        deviceId: device.deviceId,
      })
    );

    expect(response.status).toBe(500);
    expect(
      await prisma.contribution.count({ where: { tenantId: tenant.id } })
    ).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { tenantId: tenant.id } })
    ).toBe(0);
    const queued = await prisma.offlineTransaction.findUniqueOrThrow({
      where: { idempotencyKey: key },
    });
    expect(queued.status).not.toBe("synced");
  });
});
