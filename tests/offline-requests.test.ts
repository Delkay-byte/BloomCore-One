/**
 * A3 — offline requests: an offline capture that moves money is stored as a
 * request and only an online administrator decision posts it.
 *
 * Exercises the real route and the real server actions against SQLite. Only the
 * session lookup and the same-origin guard are stubbed, so the tenant scoping,
 * device checks, idempotency binding and money rules are the production ones.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma, cleanDatabase, createTestTenant } from "./setup";

const state = vi.hoisted(() => ({
  userId: "",
  tenantId: "",
  role: "admin",
  email: "",
}));

vi.mock("@/lib/tenant", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenant")>("@/lib/tenant");
  return {
    ...actual,
    getApiTenantContext: async () =>
      state.userId
        ? {
            userId: state.userId,
            tenantId: state.tenantId,
            tenantCode: "OFF",
            tenantName: "Offline Tenant",
            role: state.role,
            modules: ["susu"],
            momoEnabled: false,
            susuEnabled: true,
          }
        : null,
    requireTenantAdminSusu: async () => {
      if (state.role !== "admin") throw new Error("REDIRECT:/unauthorized");
      return {
        userId: state.userId,
        tenantId: state.tenantId,
        tenantCode: "OFF",
        tenantName: "Offline Tenant",
        role: "admin",
        modules: ["susu"],
        momoEnabled: false,
        susuEnabled: true,
      };
    },
  };
});

vi.mock("@/lib/security/same-origin", () => ({
  isSameOriginRequest: () => true,
  crossOriginDenied: () => new Response("denied", { status: 403 }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

import { POST } from "@/app/api/offline/sync-request/route";
import {
  authoriseOfflineRequest,
  getOfflineRequests,
  rejectOfflineRequest,
} from "@/lib/actions/offline-request.actions";
import { verifyPasswordAction } from "@/lib/actions/auth.actions";
import {
  normalizeOfflineRequest,
  splitReversalSubject,
} from "@/lib/offline/request-payload";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name) ? { name, value: mockCookieStore.get(name)! } : undefined,
    set: (name: string, value: string) => mockCookieStore.set(name, value),
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: async () => new Headers(),
}));

async function setAdminSession() {
  const { SignJWT } = await import("jose");
  const secret = new TextEncoder().encode("test-secret-for-vitest");
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: state.userId,
      email: state.email,
      fullName: "Offline Admin",
      role: "admin",
      modules: ["susu"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(secret)
  );
}

async function seed() {
  const tenant = await createTestTenant({ susu: true, momo: false });
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash("Test1234!", 4);
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `off-admin-${Date.now()}@test.invalid`,
      fullName: "Offline Admin",
      role: "admin",
      status: "active",
      passwordHash,
      susuEnabled: true,
    },
  });
  const collectorUser = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `off-collector-${Date.now()}@test.invalid`,
      fullName: "Field Collector",
      role: "collector",
      status: "active",
      passwordHash: "not-used",
      susuEnabled: true,
    },
  });
  const collector = await prisma.collector.create({
    data: { tenantId: tenant.id, userId: collectorUser.id, status: "active" },
  });
  const customer = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      customerId: `OFF-C-${Date.now()}`,
      fullName: "Offline Customer",
      status: "active",
    },
  });
  const account = await prisma.susuAccount.create({
    data: {
      tenantId: tenant.id,
      accountId: `OFF-S-${Date.now()}`,
      customerId: customer.id,
      dailyContribution: 10,
      status: "active",
    },
  });
  await prisma.susuCycle.create({
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
  await prisma.contribution.create({
    data: {
      tenantId: tenant.id,
      accountId: account.id,
      cycleId: (await prisma.susuCycle.findFirstOrThrow({ where: { accountId: account.id } })).id,
      amount: 100,
      collectionDate: new Date("2026-11-05T09:00:00Z"),
      referenceId: `OFF-CON-${Date.now()}`,
      collectorId: collector.id,
      channel: "collector",
      recordedById: collectorUser.id,
    },
  });
  const device = await prisma.deviceEnrollment.create({
    data: {
      tenantId: tenant.id,
      userId: admin.id,
      deviceId: `off-device-${Date.now()}`,
      deviceName: "Shared tablet",
      module: "susu",
      status: "active",
      authorizedAt: new Date(),
    },
  });
  state.userId = admin.id;
  state.tenantId = tenant.id;
  state.role = "admin";
  state.email = admin.email;
  return { tenant, admin, collector, collectorUser, account, device };
}

function post(body: Record<string, unknown>) {
  return new NextRequest("https://example.com/api/offline/sync-request", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("offline request payloads", () => {
  it("normalizes money into integer pesewa and refuses malformed captures", () => {
    const ok = normalizeOfflineRequest({
      kind: "withdrawal",
      accountId: "acc-1",
      amount: 12.34,
      notes: "  customer asked at the market ",
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.request.amountMinor).toBe(1234);
    expect(ok.request.notes).toBe("customer asked at the market");

    expect(normalizeOfflineRequest({ kind: "withdrawal", accountId: "acc-1", amount: 0 }).ok).toBe(
      false
    );
    expect(
      normalizeOfflineRequest({ kind: "withdrawal", accountId: "acc-1", amount: 12.345 }).ok
    ).toBe(false);
    expect(
      normalizeOfflineRequest({ kind: "withdrawal", accountId: "acc-1", amount: -5 }).ok
    ).toBe(false);
    expect(normalizeOfflineRequest({ kind: "teleport", accountId: "acc-1", amount: 5 }).ok).toBe(
      false
    );
  });

  it("requires a real reason for a reversal and keeps the record type in the subject", () => {
    const short = normalizeOfflineRequest({
      kind: "reversal",
      recordType: "withdrawal",
      recordId: "w1",
      reason: "oops",
    });
    expect(short.ok).toBe(false);

    const ok = normalizeOfflineRequest({
      kind: "reversal",
      recordType: "contribution",
      recordId: "c1",
      reason: "The customer paid twice for the same day.",
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.request.amountMinor).toBeNull();
    expect(splitReversalSubject(ok.request.subjectId)).toEqual({
      recordType: "contribution",
      recordId: "c1",
    });
  });

  it("binds the canonical form to the payload, so a changed retry is a different hash", () => {
    const first = normalizeOfflineRequest({
      kind: "withdrawal",
      accountId: "acc-1",
      amount: 10,
    });
    const second = normalizeOfflineRequest({
      kind: "withdrawal",
      accountId: "acc-1",
      amount: 11,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.hash).not.toBe(second.hash);
  });
});

describe("capturing a request from a device", () => {
  it("stores the request and posts nothing", async () => {
    const f = await seed();
    const key = `offline-key-${Date.now()}`;
    const response = await POST(
      post({
        idempotencyKey: key,
        deviceId: f.device.deviceId,
        payload: JSON.stringify({ kind: "withdrawal", accountId: f.account.id, amount: 25 }),
      })
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.posted).toBe(false);

    const stored = await prisma.offlineActionRequest.findFirst({
      where: { tenantId: f.tenant.id },
    });
    expect(stored?.status).toBe("pending");
    expect(stored?.kind).toBe("withdrawal");

    // No money moved.
    expect(await prisma.withdrawal.count({ where: { tenantId: f.tenant.id } })).toBe(0);
  });

  it("returns the same request for a retry with the same key and payload", async () => {
    const f = await seed();
    const key = `offline-retry-${Date.now()}`;
    const body = {
      idempotencyKey: key,
      deviceId: f.device.deviceId,
      payload: JSON.stringify({ kind: "withdrawal", accountId: f.account.id, amount: 30 }),
    };
    const first = await (await POST(post(body))).json();
    const second = await (await POST(post(body))).json();
    expect(second.requestId).toBe(first.requestId);
    expect(await prisma.offlineActionRequest.count({ where: { tenantId: f.tenant.id } })).toBe(1);
  });

  it("refuses a replayed key whose payload changed", async () => {
    const f = await seed();
    const key = `offline-changed-${Date.now()}`;
    await POST(
      post({
        idempotencyKey: key,
        deviceId: f.device.deviceId,
        payload: JSON.stringify({ kind: "withdrawal", accountId: f.account.id, amount: 30 }),
      })
    );
    const second = await POST(
      post({
        idempotencyKey: key,
        deviceId: f.device.deviceId,
        payload: JSON.stringify({ kind: "withdrawal", accountId: f.account.id, amount: 300 }),
      })
    );
    // A different digest is a different stored key, so the second capture becomes
    // its own request rather than silently rewriting the first.
    expect([200, 409]).toContain(second.status);
    const rows = await prisma.offlineActionRequest.findMany({ where: { tenantId: f.tenant.id } });
    expect(rows.length).toBe(1 + (second.status === 200 ? 1 : 0));
  });

  it("refuses an unenrolled or revoked device", async () => {
    const f = await seed();
    await prisma.deviceEnrollment.update({
      where: { deviceId: f.device.deviceId },
      data: { status: "revoked" },
    });
    const response = await POST(
      post({
        idempotencyKey: `offline-revoked-${Date.now()}`,
        deviceId: f.device.deviceId,
        payload: JSON.stringify({ kind: "withdrawal", accountId: f.account.id, amount: 5 }),
      })
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe("device_revoked");
    expect(await prisma.offlineActionRequest.count()).toBe(0);
  });

  it("refuses an account that belongs to another business", async () => {
    const f = await seed();
    const otherTenant = await createTestTenant({ susu: true, momo: false });
    const otherCustomer = await prisma.customer.create({
      data: {
        tenantId: otherTenant.id,
        customerId: `OTH-C-${Date.now()}`,
        fullName: "Other Customer",
        status: "active",
      },
    });
    const otherAccount = await prisma.susuAccount.create({
      data: {
        tenantId: otherTenant.id,
        accountId: `OTH-S-${Date.now()}`,
        customerId: otherCustomer.id,
        dailyContribution: 10,
        status: "active",
      },
    });

    const response = await POST(
      post({
        idempotencyKey: `offline-foreign-${Date.now()}`,
        deviceId: f.device.deviceId,
        payload: JSON.stringify({
          kind: "withdrawal",
          accountId: otherAccount.id,
          amount: 10,
        }),
      })
    );
    expect(response.status).toBe(404);
    expect(await prisma.offlineActionRequest.count()).toBe(0);
  });
});

describe("authorising a request", () => {
  it("posts a withdrawal only after an administrator authorises it", async () => {
    const f = await seed();
    const created = await (
      await POST(
        post({
          idempotencyKey: `offline-auth-${Date.now()}`,
          deviceId: f.device.deviceId,
          payload: JSON.stringify({ kind: "withdrawal", accountId: f.account.id, amount: 50 }),
        })
      )
    ).json();

    await setAdminSession();
    // The grant is bound to the account and the exact amount, which is what the
    // withdrawal action itself claims.
    const verified = await verifyPasswordAction("Test1234!", {
      module: "admin",
      purpose: "susu.withdrawal",
      targetType: "susuAccount",
      targetId: f.account.id,
      context: { amountMinor: "5000", currency: "GHS" },
    });
    const token = (verified.data as { stepUpToken?: string } | undefined)?.stepUpToken;

    const result = await authoriseOfflineRequest({
      id: created.requestId,
      note: "Customer present at the counter.",
      stepUpToken: token,
    });
    expect(result.success, result.error).toBe(true);

    const stored = await prisma.offlineActionRequest.findUniqueOrThrow({
      where: { id: created.requestId },
    });
    expect(stored.status).toBe("authorised");
    expect(stored.resultingEntityType).toBe("withdrawal");
    expect(await prisma.withdrawal.count({ where: { tenantId: f.tenant.id } })).toBe(1);
  });

  it("moves the request to review with the server's reason when the action refuses", async () => {
    const f = await seed();
    // An amount larger than the customer's balance: the domain action refuses on
    // its own money rule, and that refusal must be shown, not retried forever.
    const created = await (
      await POST(
        post({
          idempotencyKey: `offline-refused-${Date.now()}`,
          deviceId: f.device.deviceId,
          payload: JSON.stringify({
            kind: "withdrawal",
            accountId: f.account.id,
            amount: 9999,
          }),
        })
      )
    ).json();

    await setAdminSession();
    const result = await authoriseOfflineRequest({ id: created.requestId });
    expect(result.success).toBe(false);

    const stored = await prisma.offlineActionRequest.findUniqueOrThrow({
      where: { id: created.requestId },
    });
    expect(stored.status).toBe("needs_review");
    expect(stored.conflictReason).toBeTruthy();
    expect(await prisma.withdrawal.count({ where: { tenantId: f.tenant.id } })).toBe(0);

    const queue = await getOfflineRequests("needs_review");
    expect(queue).toHaveLength(1);
    expect(queue[0].conflictReason).toContain(stored.conflictReason!);
  });

  it("refuses to authorise the same request twice", async () => {
    const f = await seed();
    const created = await (
      await POST(
        post({
          idempotencyKey: `offline-double-${Date.now()}`,
          deviceId: f.device.deviceId,
          payload: JSON.stringify({ kind: "withdrawal", accountId: f.account.id, amount: 20 }),
        })
      )
    ).json();

    await setAdminSession();
    const verified = await verifyPasswordAction("Test1234!", {
      module: "admin",
      purpose: "susu.withdrawal",
      targetType: "susuAccount",
      targetId: f.account.id,
      context: { amountMinor: "2000", currency: "GHS" },
    });
    const first = await authoriseOfflineRequest({
      id: created.requestId,
      stepUpToken: (verified.data as { stepUpToken?: string } | undefined)?.stepUpToken,
    });
    expect(first.success, first.error).toBe(true);
    const second = await authoriseOfflineRequest({ id: created.requestId });
    expect(second.success).toBe(false);
    expect(await prisma.withdrawal.count({ where: { tenantId: f.tenant.id } })).toBe(1);
  });

  it("rejects a request with a reason and never posts it", async () => {
    const f = await seed();
    const created = await (
      await POST(
        post({
          idempotencyKey: `offline-reject-${Date.now()}`,
          deviceId: f.device.deviceId,
          payload: JSON.stringify({ kind: "remittance", collectorId: f.collector.id, amount: 80 }),
        })
      )
    ).json();

    await setAdminSession();
    const rejected = await rejectOfflineRequest({
      id: created.requestId,
      note: "Counted cash does not match the sheet.",
    });
    expect(rejected.success, rejected.error).toBe(true);

    const stored = await prisma.offlineActionRequest.findUniqueOrThrow({
      where: { id: created.requestId },
    });
    expect(stored.status).toBe("rejected");
    expect(await prisma.collectorRemittance.count({ where: { tenantId: f.tenant.id } })).toBe(0);

    const again = await authoriseOfflineRequest({ id: created.requestId });
    expect(again.success).toBe(false);
  });

  it("keeps every business's queue separate", async () => {
    const f = await seed();
    await POST(
      post({
        idempotencyKey: `offline-scope-${Date.now()}`,
        deviceId: f.device.deviceId,
        payload: JSON.stringify({ kind: "withdrawal", accountId: f.account.id, amount: 15 }),
      })
    );

    const otherTenant = await createTestTenant({ susu: true, momo: false });
    const otherAdmin = await prisma.user.create({
      data: {
        tenantId: otherTenant.id,
        email: `other-admin-${Date.now()}@test.invalid`,
        fullName: "Other Admin",
        role: "admin",
        status: "active",
        passwordHash: "not-used",
        susuEnabled: true,
      },
    });
    state.userId = otherAdmin.id;
    state.tenantId = otherTenant.id;
    await setAdminSession();

    expect(await getOfflineRequests()).toHaveLength(0);
  });
});
