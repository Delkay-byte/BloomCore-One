/**
 * Offline MoMo capture.
 *
 * The promise this feature makes is narrow and must hold exactly: a captured MoMo day
 * is stored, never posted. These tests prove the payload rules, the server's refusals,
 * the idempotency contract, conflict detection, and — the part that matters most — that
 * no ledger, transaction, balance or daily account is created by syncing a capture.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase, createTestTenant, createTestAdmin } from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({ mockCookieStore: new Map<string, string>() }));

const state = vi.hoisted(() => ({
  userId: "",
  tenantId: "",
  role: "worker",
}));

vi.mock("@/lib/tenant", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenant")>("@/lib/tenant");
  const context = () =>
    state.userId
      ? {
          userId: state.userId,
          tenantId: state.tenantId,
          tenantCode: "OFFMOMO",
          tenantName: "Offline MoMo",
          role: state.role,
          modules: ["momo"],
          momoEnabled: true,
          susuEnabled: false,
        }
      : null;
  return {
    ...actual,
    getApiTenantContext: async () => context(),
    requireTenantWorker: async () => {
      const ctx = context();
      if (!ctx) throw new Error("REDIRECT:/login");
      return ctx;
    },
    requireTenantAdmin: async () => {
      const ctx = context();
      if (!ctx || ctx.role !== "admin") throw new Error("REDIRECT:/unauthorized");
      return ctx;
    },
  };
});

vi.mock("@/lib/security/same-origin", () => ({
  isSameOriginRequest: () => true,
  crossOriginDenied: () => new Response("denied", { status: 403 }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (mockCookieStore.has(name) ? { name, value: mockCookieStore.get(name)! } : undefined),
    set: (name: string, value: string) => mockCookieStore.set(name, value),
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  MOMO_OFFLINE_MAX_AGE_DAYS,
  canonicalMomoDay,
  isStaleBusinessDate,
  normalizeMomoDay,
  summarizeMomoDay,
} from "@/lib/offline/momo-draft";
import { POST as momoDraftRoute } from "@/app/api/offline/momo-draft/route";
import {
  applyMomoDraft,
  clearMomoDraftConflict,
  getMomoDraftsForReview,
  getMyMomoDrafts,
  rejectMomoDraft,
} from "@/lib/actions/momo-offline-draft.actions";

async function setSession(
  user: { id: string; email: string; tenantId: string },
  role: "worker" | "admin"
) {
  state.userId = user.id;
  state.tenantId = user.tenantId;
  state.role = role;
}

function dateString(offsetDays = 0): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offsetDays))
    .toISOString()
    .slice(0, 10);
}

function capture(overrides: Record<string, unknown> = {}) {
  return {
    businessDate: dateString(0),
    locationId: "loc-placeholder",
    openingCash: 500,
    openingFloat: 1200.5,
    closingCash: 420,
    closingFloat: 980.25,
    captureSource: "device",
    note: "Captured at the counter while offline",
    activities: [
      { kind: "cash_out", network: "mtn", amount: 120, reference: "MP-1", note: null, evidenceRef: "photo-1" },
      { kind: "commission", network: "mtn", amount: 2.4, reference: null, note: null, evidenceRef: null },
    ],
    ...overrides,
  };
}

describe("payload rules", () => {
  it("accepts a well-formed day and canonicalises it", () => {
    const result = normalizeMomoDay(capture({ locationId: "loc-1" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.day.openingCashMinor).toBe(50_000);
    expect(result.day.openingFloatMinor).toBe(120_050);
    expect(result.day.closingFloatMinor).toBe(98_025);
    expect(result.day.activities).toHaveLength(2);
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);

    // The same capture normalises to the same canonical string and hash.
    const again = normalizeMomoDay(capture({ locationId: "loc-1", activities: [...(capture().activities as unknown[])].reverse() }));
    expect(again.ok && again.canonical).toBe(result.canonical);
    expect(again.ok && again.hash).toBe(result.hash);
  });

  it("refuses a fractional pesewa instead of rounding it", () => {
    const result = normalizeMomoDay(capture({ openingCash: 10.005 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/two decimals/i);
  });

  it("refuses an unknown network, bad date, negative figure or missing branch", () => {
    expect(normalizeMomoDay(capture({ activities: [{ kind: "cash_in", network: "vodafone", amount: 10 }] })).ok).toBe(false);
    expect(normalizeMomoDay(capture({ businessDate: "2026-13-40" })).ok).toBe(false);
    expect(normalizeMomoDay(capture({ closingCash: -1 })).ok).toBe(false);
    expect(normalizeMomoDay(capture({ locationId: "" })).ok).toBe(false);
  });

  it("labels a capture source honestly and totals without touching money", () => {
    const result = normalizeMomoDay(capture({ locationId: "loc-1", captureSource: "something" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the two known sources are accepted; anything else is treated as manual.
    expect(result.day.captureSource).toBe("manual");
    const totals = summarizeMomoDay(result.day);
    expect(totals.cashOutMinor).toBe(12_000);
    expect(totals.commissionMinor).toBe(240);
    expect(totals.activityCount).toBe(2);
  });

  it("marks a capture older than the window as stale", () => {
    expect(isStaleBusinessDate(dateString(1))).toBe(false);
    expect(isStaleBusinessDate(dateString(MOMO_OFFLINE_MAX_AGE_DAYS + 1))).toBe(true);
    expect(canonicalMomoDay).toBeTypeOf("function");
  });
});

describe("server sync", () => {
  let tenantId: string;
  let locationId: string;
  let deviceId: string;
  let worker: { id: string; email: string; tenantId: string };
  let admin: { id: string; email: string; tenantId: string };

  beforeEach(async () => {
    await cleanDatabase();
    mockCookieStore.clear();
    const tenant = await createTestTenant({ momo: true, susu: false });
    tenantId = tenant.id;
    const location = await prisma.location.create({
      data: { tenantId, name: "Counter A", code: `C-${Date.now().toString().slice(-6)}` },
    });
    locationId = location.id;
    const created = await prisma.user.create({
      data: {
        tenantId,
        email: `offline-worker-${Date.now()}@test.invalid`,
        fullName: "Offline Worker",
        role: "worker",
        status: "active",
        passwordHash: "x",
        momoEnabled: true,
        locationId,
      },
    });
    worker = { id: created.id, email: created.email, tenantId };
    const adminUser = await createTestAdmin({ tenantId, momo: true, susu: false });
    admin = { id: adminUser.id, email: adminUser.email, tenantId };
    deviceId = `device-${Date.now()}`;
    await prisma.deviceEnrollment.create({
      data: {
        tenantId,
        userId: worker.id,
        deviceId,
        deviceName: "Counter phone",
        module: "momo",
        status: "active",
        authorizedAt: new Date(),
      },
    });
    await setSession(worker, "worker");
  });

  async function post(body: unknown) {
    // The route only needs the Request surface for these assertions (origin and body);
    // NextRequest adds helpers this test does not use.
    return momoDraftRoute(
      new Request("https://maacash.test/api/offline/momo-draft", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://maacash.test",
          host: "maacash.test",
          "x-forwarded-host": "maacash.test",
          "x-forwarded-proto": "https",
        },
        body: JSON.stringify(body),
      }) as unknown as Parameters<typeof momoDraftRoute>[0]
    );
  }

  function body(overrides: Record<string, unknown> = {}) {
    return {
      idempotencyKey: `idem-${Math.random().toString(36).slice(2)}-0000`,
      deviceId,
      payload: JSON.stringify(capture({ locationId })),
      ...overrides,
    };
  }

  it("stores the capture and posts nothing", async () => {
    const response = await post(body());
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.posted).toBe(false);
    expect(json.status).toBe("pending");

    expect(await prisma.momoOfflineDraft.count({ where: { tenantId } })).toBe(1);
    // The financial record of the day is untouched.
    expect(await prisma.momoTransaction.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.dailyAccount.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.branchAssetBalance.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.expense.count({ where: { tenantId } })).toBe(0);
  });

  it("is idempotent and refuses a changed payload under the same key", async () => {
    const key = "idem-stable-key-0001";
    const first = await (await post(body({ idempotencyKey: key }))).json();
    const second = await (await post(body({ idempotencyKey: key }))).json();
    expect(second.draftId).toBe(first.draftId);
    expect(await prisma.momoOfflineDraft.count({ where: { tenantId } })).toBe(1);

    const changed = await post(
      body({
        idempotencyKey: key,
        payload: JSON.stringify(capture({ locationId, closingCash: 1 })),
      })
    );
    expect(changed.status).toBe(409);
    const json = await changed.json();
    expect(json.code).toBe("payload_mismatch");
    // The stored capture is unchanged.
    const row = await prisma.momoOfflineDraft.findFirstOrThrow({ where: { tenantId } });
    expect(row.payloadJson).toContain("42000");
  });

  it("refuses a revoked device and an expired authorisation", async () => {
    await prisma.deviceEnrollment.updateMany({ where: { tenantId }, data: { status: "revoked" } });
    const revoked = await post(body());
    expect(revoked.status).toBe(403);
    expect((await revoked.json()).code).toBe("device_revoked");

    await prisma.deviceEnrollment.updateMany({
      where: { tenantId },
      data: { status: "active", authorizedAt: new Date(Date.now() - 48 * 3_600_000) },
    });
    const expired = await post(body());
    expect(expired.status).toBe(403);
    expect((await expired.json()).code).toBe("offline_auth_expired");
    expect(await prisma.momoOfflineDraft.count({ where: { tenantId } })).toBe(0);
  });

  it("refuses a branch that is not this business or not the caller's", async () => {
    const other = await createTestTenant({ momo: true, susu: false });
    const foreign = await prisma.location.create({
      data: { tenantId: other.id, name: "Elsewhere", code: `X-${Date.now().toString().slice(-6)}` },
    });
    const crossed = await post(body({ payload: JSON.stringify(capture({ locationId: foreign.id })) }));
    expect(crossed.status).toBe(403);

    const second = await prisma.location.create({
      data: { tenantId, name: "Counter B", code: `B-${Date.now().toString().slice(-6)}` },
    });
    const unassigned = await post(body({ payload: JSON.stringify(capture({ locationId: second.id })) }));
    expect(unassigned.status).toBe(403);
    expect(await prisma.momoOfflineDraft.count({ where: { tenantId } })).toBe(0);
  });

  it("flags a conflict when the day already exists, and keeps it for review", async () => {
    await prisma.dailyAccount.create({
      data: {
        tenantId,
        locationId,
        workerId: worker.id,
        businessDate: new Date(`${dateString(0)}T00:00:00.000Z`),
        status: "draft",
      },
    });
    const json = await (await post(body())).json();
    expect(json.status).toBe("needs_review");
    expect(json.conflictReason).toMatch(/already exists/i);

    await setSession(admin, "admin");
    const queue = await getMomoDraftsForReview("needs_review");
    expect(queue.success).toBe(true);
    expect(queue.data).toHaveLength(1);
  });

  it("lets a reviewer clear a conflict with a reason and audits it", async () => {
    await prisma.dailyAccount.create({
      data: {
        tenantId,
        locationId,
        workerId: worker.id,
        businessDate: new Date(`${dateString(0)}T00:00:00.000Z`),
        status: "submitted",
      },
    });
    const created = await (await post(body())).json();

    await setSession(admin, "admin");
    const short = await clearMomoDraftConflict({ draftId: created.draftId, reason: "ok" });
    expect(short.success).toBe(false);

    const cleared = await clearMomoDraftConflict({
      draftId: created.draftId,
      reason: "Checked the counter book; the capture matches the submitted day.",
    });
    expect(cleared.success, cleared.error).toBe(true);

    const audit = await prisma.auditLog.findFirst({
      where: { tenantId, action: "offline.momo_draft_conflict_cleared" },
    });
    expect(audit).not.toBeNull();
  });

  it("applies a capture only onto the worker's own saved account, and never writes figures", async () => {
    const created = await (await post(body())).json();

    const account = await prisma.dailyAccount.create({
      data: {
        tenantId,
        locationId,
        workerId: worker.id,
        businessDate: new Date(`${dateString(0)}T00:00:00.000Z`),
        status: "draft",
        openingCash: 500,
        closingCash: 420,
        updatedAt: new Date(Date.now() + 60_000),
      },
    });

    await setSession(worker, "worker");
    const applied = await applyMomoDraft({ draftId: created.draftId, accountId: account.id });
    expect(applied.success, applied.error).toBe(true);

    const row = await prisma.momoOfflineDraft.findUniqueOrThrow({ where: { id: created.draftId } });
    expect(row.status).toBe("applied");
    expect(row.appliedAccountId).toBe(account.id);

    // The capture did not write financial data: the account still holds what the
    // worker saved, and no ledger row appeared.
    const after = await prisma.dailyAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(Number(after.closingCash)).toBe(420);
    expect(await prisma.momoTransaction.count({ where: { tenantId } })).toBe(0);
  });

  it("refuses to apply onto another employee's day or an earlier save", async () => {
    const created = await (await post(body())).json();
    const otherWorker = await prisma.user.create({
      data: {
        tenantId,
        email: `offline-other-${Date.now()}@test.invalid`,
        fullName: "Other Worker",
        role: "worker",
        status: "active",
        passwordHash: "x",
        momoEnabled: true,
        locationId,
      },
    });
    const foreignAccount = await prisma.dailyAccount.create({
      data: {
        tenantId,
        locationId,
        workerId: otherWorker.id,
        businessDate: new Date(`${dateString(0)}T00:00:00.000Z`),
        status: "draft",
        updatedAt: new Date(Date.now() + 60_000),
      },
    });

    await setSession(worker, "worker");
    const refused = await applyMomoDraft({ draftId: created.draftId, accountId: foreignAccount.id });
    expect(refused.success).toBe(false);

    const stale = await prisma.dailyAccount.create({
      data: {
        tenantId,
        locationId,
        workerId: worker.id,
        businessDate: new Date(`${dateString(1)}T00:00:00.000Z`),
        status: "draft",
      },
    });
    const wrongDay = await applyMomoDraft({ draftId: created.draftId, accountId: stale.id });
    expect(wrongDay.success).toBe(false);
    expect(wrongDay.error).toMatch(/business day/i);
  });

  it("refuses to apply a capture a reviewer rejected", async () => {
    const created = await (await post(body())).json();
    await setSession(admin, "admin");
    const rejected = await rejectMomoDraft({
      draftId: created.draftId,
      reason: "Captured against the wrong branch; the counter book says otherwise.",
    });
    expect(rejected.success, rejected.error).toBe(true);

    const account = await prisma.dailyAccount.create({
      data: {
        tenantId,
        locationId,
        workerId: worker.id,
        businessDate: new Date(`${dateString(0)}T00:00:00.000Z`),
        status: "draft",
        updatedAt: new Date(Date.now() + 60_000),
      },
    });
    await setSession(worker, "worker");
    const refused = await applyMomoDraft({ draftId: created.draftId, accountId: account.id });
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/rejected/i);
  });

  it("shows the worker only their own captures", async () => {
    const tenant = await prisma.businessTenant.findUniqueOrThrow({ where: { id: tenantId } });
    const other = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `offline-third-${Date.now()}@test.invalid`,
        fullName: "Third Worker",
        role: "worker",
        status: "active",
        passwordHash: "x",
        momoEnabled: true,
        locationId,
      },
    });
    await prisma.momoOfflineDraft.create({
      data: {
        tenantId,
        locationId,
        userId: other.id,
        deviceId: "other-device",
        businessDate: new Date(`${dateString(2)}T00:00:00.000Z`),
        payloadJson: (() => {
          const parsed = normalizeMomoDay(capture({ locationId }));
          if (!parsed.ok) throw new Error(parsed.error);
          return parsed.canonical;
        })(),
        payloadHash: "a".repeat(64),
        idempotencyKey: "other-key",
        status: "pending",
      },
    });

    await setSession(worker, "worker");
    const mine = await getMyMomoDrafts();
    expect(mine.success).toBe(true);
    expect(mine.data).toHaveLength(0);

    await setSession(admin, "admin");
    const all = await getMomoDraftsForReview();
    expect(all.success).toBe(true);
    expect(all.data).toHaveLength(1);
    expect(all.data![0].capturedBy).toBe("Third Worker");
  });
});
