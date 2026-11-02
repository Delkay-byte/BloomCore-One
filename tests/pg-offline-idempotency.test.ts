/**
 * PostgreSQL offline-sync integration tests.
 *
 * Run against an isolated PostgreSQL database:
 *   DATABASE_URL=<rehearsal> PG_DATABASE_URL=<rehearsal> \
 *     npx vitest run --config vitest.pg.config.ts tests/pg-offline-idempotency.test.ts
 *
 * Covers: concurrent submission of one idempotency key, retry after a timeout,
 * cross-user key reuse, acknowledged-record status, and the HTTP 429 contract.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";

const state = vi.hoisted(() => ({
  userId: "",
  tenantId: "",
}));

vi.mock("@/lib/tenant", () => ({
  getApiTenantContext: async () => ({
    userId: state.userId,
    tenantId: state.tenantId,
    tenantCode: "PG",
    tenantName: "PG Tenant",
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
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";

const prisma = new PrismaClient();

async function resetDatabase() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "AccountRecoveryRequest","SessionRecord","TurnstileTokenUse",
      "AuthThrottle","RateLimitCounter","PlatformAuditLog","PlatformSuperAdmin",
      "OfflineTransaction","DeviceEnrollment","PasswordResetToken","AuditLog",
      "Expense","DailyAccount","ContributionAllocation","Commission","CardFee",
      "Withdrawal","Contribution","SusuCycle","SusuAccount","CollectorRemittance",
      "CollectorCustomerAssignment","Collector","Customer","Location","User",
      "BusinessTenant" CASCADE
  `);
}

async function seed() {
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `PG-${Date.now()}`,
      name: "PG Offline Tenant",
      status: "ACTIVE",
      susuEnabled: true,
      onboardingStatus: "COMPLETED",
    },
  });
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `pg-admin-${Date.now()}@example.com`,
      fullName: "PG Offline Admin",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
      susuEnabled: true,
    },
  });
  const customer = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      customerId: `PG-C-${Date.now()}`,
      fullName: "PG Offline Customer",
      status: "active",
    },
  });
  const account = await prisma.susuAccount.create({
    data: {
      tenantId: tenant.id,
      accountId: `PG-S-${Date.now()}`,
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
  await prisma.deviceEnrollment.create({
    data: {
      tenantId: tenant.id,
      userId: admin.id,
      deviceId: `pg-device-${Date.now()}`,
      module: "susu",
      status: "active",
      authorizedAt: new Date(),
    },
  });
  state.userId = admin.id;
  state.tenantId = tenant.id;
  return { tenant, admin, account, cycle };
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

describe("offline sync on PostgreSQL", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("posts a retried idempotency key exactly once", async () => {
    const { account } = await seed();
    const device = await prisma.deviceEnrollment.findFirstOrThrow();
    const body = {
      idempotencyKey: `offline-${Date.now()}`,
      payload: payload(account.id),
      deviceId: device.deviceId,
    };

    const first = await POST(requestFor(body));
    expect(first.status).toBe(200);
    expect((await first.json()).success).toBe(true);

    // Same key again, as a client retry after not seeing the response.
    const retry = await POST(requestFor(body));
    expect(retry.status).toBe(200);
    const retryBody = await retry.json();
    expect(retryBody.success).toBe(true);
    expect(retryBody.message).toBe("Transaction already processed");

    expect(await prisma.contribution.count({ where: { referenceId: `CON-${body.idempotencyKey}` } })).toBe(1);
    const queued = await prisma.offlineTransaction.findUnique({
      where: { idempotencyKey: body.idempotencyKey },
    });
    expect(queued?.status).toBe("synced");
  });

  it("allows only one posting when two identical requests race", async () => {
    const { account } = await seed();
    const device = await prisma.deviceEnrollment.findFirstOrThrow();
    const body = {
      idempotencyKey: `offline-race-${Date.now()}`,
      payload: payload(account.id),
      deviceId: device.deviceId,
    };

    const responses = await Promise.all([
      POST(requestFor(body)),
      POST(requestFor(body)),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses.every((status) => status === 200 || status === 409)).toBe(true);
    expect(statuses).toContain(200);

    expect(await prisma.contribution.count({ where: { referenceId: `CON-${body.idempotencyKey}` } })).toBe(1);
    expect(
      await prisma.contributionAllocation.count({
        where: { contribution: { referenceId: `CON-${body.idempotencyKey}` } },
      })
    ).toBe(2);
  });

  it("rejects an idempotency key owned by another user", async () => {
    const { tenant, account } = await seed();
    const firstDevice = await prisma.deviceEnrollment.findFirstOrThrow();
    const key = `offline-owned-${Date.now()}`;

    const first = await POST(
      requestFor({
        idempotencyKey: key,
        payload: payload(account.id),
        deviceId: firstDevice.deviceId,
      })
    );
    expect(first.status).toBe(200);

    const secondUser = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `pg-other-${Date.now()}@example.com`,
        fullName: "Other User",
        role: "admin",
        status: "active",
        passwordHash: "not-used",
        susuEnabled: true,
      },
    });
    const secondDevice = await prisma.deviceEnrollment.create({
      data: {
        tenantId: tenant.id,
        userId: secondUser.id,
        deviceId: `pg-device-other-${Date.now()}`,
        module: "susu",
        status: "active",
        authorizedAt: new Date(),
      },
    });
    state.userId = secondUser.id;

    const second = await POST(
      requestFor({
        idempotencyKey: key,
        payload: payload(account.id),
        deviceId: secondDevice.deviceId,
      })
    );
    expect(second.status).toBe(409);
    expect(await prisma.contribution.count({ where: { referenceId: `CON-${key}` } })).toBe(1);
  });

  it("returns HTTP 429 with Retry-After when the sync budget is exhausted", async () => {
    const { account, admin } = await seed();
    const device = await prisma.deviceEnrollment.findFirstOrThrow();
    for (let index = 0; index < RATE_LIMITS.offlineSync.limit; index += 1) {
      await consumeRateLimit("offline:sync", admin.id, RATE_LIMITS.offlineSync);
    }

    const response = await POST(
      requestFor({
        idempotencyKey: `offline-limited-${Date.now()}`,
        payload: payload(account.id),
        deviceId: device.deviceId,
      })
    );
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await response.json();
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });
});
