/**
 * A2 — employee accountability: tenant operational policy, the shift-policy
 * gate on daily close, shared-device actor proof, and audited correction of a
 * closed shift.
 *
 * Real server actions against the SQLite test database. Only next/headers,
 * next/navigation and next/cache are mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name)
        ? { name, value: mockCookieStore.get(name)! }
        : undefined,
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
  getOperationalPolicy,
  saveOperationalPolicy,
} from "@/lib/actions/tenant-policy.actions";
import {
  closeShift,
  confirmShiftHandover,
  correctClosedShift,
  createShift,
  getShiftDetail,
  openShift,
} from "@/lib/actions/shift.actions";
import { submitDailyAccount } from "@/lib/actions/daily-account.actions";
import { verifyPasswordAction } from "@/lib/actions/auth.actions";
import {
  ACTOR_PROOF_REQUIRED,
  DEFAULT_OPERATIONAL_POLICY,
  SHIFT_REQUIRED_REFUSAL,
  businessDayBounds,
} from "@/lib/tenant-policy";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");
const PASSWORD = "Test1234!";

async function setSession(module: "admin" | "momo", user: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    module === "admin" ? "bik-admin-session" : "bik-worker-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Test",
      role: module === "admin" ? "admin" : "worker",
      modules: ["momo"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

let counter = 0;

interface Fixture {
  tenantId: string;
  locationId: string;
  admin: { id: string; email: string };
  outgoing: { id: string; email: string };
  incoming: { id: string; email: string };
  dailyAccountId: string;
  businessDate: Date;
}

async function fixture(): Promise<Fixture> {
  counter += 1;
  const tenant = await createTestTenant({ momo: true, susu: false });
  const location = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Policy Branch", code: `POL-${counter}` },
  });
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const worker = (name: string, tag: string) =>
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `${tag}-${counter}@test.invalid`,
        fullName: name,
        role: "worker",
        status: "active",
        passwordHash,
        momoEnabled: true,
        locationId: location.id,
        passwordPolicyVersion: 1,
      },
    });
  const outgoing = await worker("Yaa Outgoing", "outgoing");
  const incoming = await worker("Kwesi Incoming", "incoming");
  const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });

  const businessDate = new Date(Date.UTC(2026, 10, 12));
  const account = await prisma.dailyAccount.create({
    data: {
      tenantId: tenant.id,
      locationId: location.id,
      workerId: outgoing.id,
      businessDate,
      openingCash: 100,
      openingMomoFloat: 200,
      closingCash: 150,
      closingMomoFloat: 260,
      commission: 10,
      status: "draft",
    },
  });

  return {
    tenantId: tenant.id,
    locationId: location.id,
    admin,
    outgoing,
    incoming,
    dailyAccountId: account.id,
    businessDate,
  };
}

async function openShiftFor(f: Fixture): Promise<string> {
  await setSession("momo", f.outgoing);
  const created = await createShift({
    locationId: f.locationId,
    businessDate: f.businessDate.toISOString().slice(0, 10),
    name: "morning",
    assignedUserId: f.outgoing.id,
    openingCash: 100,
    openingMomoFloat: 200,
  } as never);
  expect(created.success, created.error).toBe(true);
  const shiftId = (created.data as { shiftId: string }).shiftId;
  const opened = await openShift(shiftId);
  expect(opened.success, opened.error).toBe(true);
  return shiftId;
}

async function closeShiftFor(f: Fixture, shiftId: string) {
  await setSession("momo", f.outgoing);
  const closed = await closeShift({
    shiftId,
    closingCash: 150,
    closingMomoFloat: 260,
    handoverToUserId: f.incoming.id,
  });
  expect(closed.success, closed.error).toBe(true);
  await setSession("momo", f.incoming);
  const confirmed = await confirmShiftHandover({
    handoverId: (closed.data as { handoverId: string }).handoverId,
    incomingCash: 150,
    incomingMomoFloat: 260,
    operationsAccepted: true,
  });
  expect(confirmed.success, confirmed.error).toBe(true);
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("tenant operational policy", () => {
  it("defaults to optional shifts and no actor proof", async () => {
    const f = await fixture();
    await setSession("admin", f.admin);
    const policy = await getOperationalPolicy();
    expect(policy).toMatchObject(DEFAULT_OPERATIONAL_POLICY);
    expect(policy.usingDefaults).toBe(true);
    expect(policy.shiftSummary).toMatch(/optional/i);
    expect(policy.actorProofSummary).toMatch(/signed-in session/i);
  });

  it("saves the policy, audits the previous and new values, and is administrator-only", async () => {
    const f = await fixture();
    await setSession("admin", f.admin);
    const saved = await saveOperationalPolicy({
      shiftsRequired: true,
      actorProofForSensitiveCounts: true,
      note: "Three branches share one till.",
    });
    expect(saved.success, saved.error).toBe(true);

    const stored = await prisma.tenantOperationalPolicy.findFirst({
      where: { tenantId: f.tenantId },
    });
    expect(stored?.shiftsRequired).toBe(true);
    expect(stored?.actorProofForSensitiveCounts).toBe(true);
    expect(stored?.updatedById).toBe(f.admin.id);

    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: f.tenantId, action: "tenant.operational_policy_changed" },
      orderBy: { createdAt: "desc" },
    });
    const details = JSON.parse(String(audit?.details));
    expect(details.shiftsRequired).toEqual({ from: false, to: true });
    expect(details.financialMutation).toBe(false);

    // A worker cannot change the policy.
    await setSession("momo", f.outgoing);
    await expect(
      saveOperationalPolicy({ shiftsRequired: false, actorProofForSensitiveCounts: false })
    ).rejects.toThrow(/REDIRECT|not found|unauthor/i);
  });
});

describe("shift policy gate on daily close", () => {
  it("refuses a daily close with no closed shift when shifts are required", async () => {
    const f = await fixture();
    await setSession("admin", f.admin);
    await saveOperationalPolicy({ shiftsRequired: true, actorProofForSensitiveCounts: false });

    await setSession("momo", f.outgoing);
    const refused = await submitDailyAccount(f.dailyAccountId);
    expect(refused.success).toBe(false);
    expect(refused.error).toBe(SHIFT_REQUIRED_REFUSAL);

    const account = await prisma.dailyAccount.findUnique({ where: { id: f.dailyAccountId } });
    expect(account?.status).toBe("draft");
  });

  it("accepts the daily close once the same employee has a closed shift that day", async () => {
    const f = await fixture();
    const shiftId = await openShiftFor(f);
    await closeShiftFor(f, shiftId);

    await setSession("admin", f.admin);
    await saveOperationalPolicy({ shiftsRequired: true, actorProofForSensitiveCounts: false });

    await setSession("momo", f.outgoing);
    const submitted = await submitDailyAccount(f.dailyAccountId);
    expect(submitted.success, submitted.error).toBe(true);
  });

  it("ignores another employee's closed shift for the same branch and day", async () => {
    const f = await fixture();
    const shiftId = await openShiftFor(f);
    await closeShiftFor(f, shiftId);

    // Reassign the day to the receiving employee, who has no closed shift.
    await prisma.dailyAccount.update({
      where: { id: f.dailyAccountId },
      data: { workerId: f.incoming.id },
    });
    await setSession("admin", f.admin);
    await saveOperationalPolicy({ shiftsRequired: true, actorProofForSensitiveCounts: false });

    await setSession("momo", f.incoming);
    const refused = await submitDailyAccount(f.dailyAccountId);
    expect(refused.success).toBe(false);
    expect(refused.error).toBe(SHIFT_REQUIRED_REFUSAL);
  });
});

describe("shared-device actor proof", () => {
  it("refuses a daily close without the actor's own proof, then accepts a bound grant", async () => {
    const f = await fixture();
    await setSession("admin", f.admin);
    await saveOperationalPolicy({ shiftsRequired: false, actorProofForSensitiveCounts: true });

    await setSession("momo", f.outgoing);
    const refused = await submitDailyAccount(f.dailyAccountId);
    expect(refused.success).toBe(false);
    expect(refused.error).toBe(ACTOR_PROOF_REQUIRED);

    const account = await prisma.dailyAccount.findUnique({ where: { id: f.dailyAccountId } });
    expect(account?.status).toBe("draft");

    const verified = await verifyPasswordAction(PASSWORD, {
      module: "momo",
      purpose: "finance.daily_close.submit",
      targetType: "dailyAccount",
      targetId: f.dailyAccountId,
      context: {},
    });
    expect(verified.success, verified.error).toBe(true);
    const token = (verified.data as { stepUpToken?: string } | undefined)?.stepUpToken;
    expect(token).toBeTruthy();

    const accepted = await submitDailyAccount(f.dailyAccountId, token);
    expect(accepted.success, accepted.error).toBe(true);

    // The grant is single use, so the same token cannot close another record.
    const second = await prisma.dailyAccount.create({
      data: {
        tenantId: f.tenantId,
        locationId: f.locationId,
        workerId: f.outgoing.id,
        businessDate: new Date(Date.UTC(2026, 10, 13)),
        openingCash: 10,
        closingCash: 20,
        status: "draft",
      },
    });
    const replay = await submitDailyAccount(second.id, token);
    expect(replay.success).toBe(false);
    expect(replay.error).toBe(ACTOR_PROOF_REQUIRED);
  });

  it("requires proof for a shared-device shift count only when the policy is on", async () => {
    const f = await fixture();
    const shiftId = await openShiftFor(f);

    // Policy off: the signed-in session is enough.
    await setSession("momo", f.outgoing);
    const withoutPolicy = await closeShift({
      shiftId,
      closingCash: 150,
      closingMomoFloat: 260,
      handoverToUserId: f.incoming.id,
    });
    expect(withoutPolicy.success, withoutPolicy.error).toBe(true);

    // A fresh shift with the policy on is refused without the actor's proof.
    const secondShift = await openShiftFor({ ...f, businessDate: new Date(Date.UTC(2026, 10, 14)) });
    await setSession("admin", f.admin);
    await saveOperationalPolicy({ shiftsRequired: false, actorProofForSensitiveCounts: true });

    await setSession("momo", f.outgoing);
    const refused = await closeShift({
      shiftId: secondShift,
      closingCash: 150,
      closingMomoFloat: 260,
      handoverToUserId: f.incoming.id,
    });
    expect(refused.success).toBe(false);
    expect(refused.error).toBe(ACTOR_PROOF_REQUIRED);

    const verified = await verifyPasswordAction(PASSWORD, {
      module: "momo",
      purpose: "finance.shift_count.submit",
      targetType: "shift",
      targetId: secondShift,
      context: {},
    });
    expect(verified.success, verified.error).toBe(true);
    const accepted = await closeShift({
      shiftId: secondShift,
      closingCash: 150,
      closingMomoFloat: 260,
      handoverToUserId: f.incoming.id,
      actorProofToken: (verified.data as { stepUpToken?: string }).stepUpToken,
    });
    expect(accepted.success, accepted.error).toBe(true);
  });
});

describe("correcting a closed shift", () => {
  it("keeps the original figures, requires step-up and records a revision", async () => {
    const f = await fixture();
    const shiftId = await openShiftFor(f);
    await closeShiftFor(f, shiftId);

    await setSession("admin", f.admin);
    const refused = await correctClosedShift({
      shiftId,
      closingCash: 145,
      closingMomoFloat: 260,
      reason: "Till recount found a GH₵5 note stuck under the drawer.",
    });
    expect(refused.success).toBe(false);

    const verified = await verifyPasswordAction(PASSWORD, {
      module: "admin",
      purpose: "finance.shift_handover.resolve",
      targetType: "shift",
      targetId: shiftId,
      context: { fields: "cash" },
    });
    expect(verified.success, verified.error).toBe(true);

    const corrected = await correctClosedShift({
      shiftId,
      closingCash: 145,
      closingMomoFloat: 260,
      reason: "Till recount found a GH₵5 note stuck under the drawer.",
      stepUpToken: (verified.data as { stepUpToken?: string }).stepUpToken,
    });
    expect(corrected.success, corrected.error).toBe(true);

    const shift = await prisma.shift.findUnique({ where: { id: shiftId } });
    expect(Number(shift?.closingCash)).toBe(145);
    expect(shift?.status).toBe("closed");

    const revisions = await prisma.shiftRevision.findMany({ where: { shiftId } });
    expect(revisions).toHaveLength(1);
    expect(JSON.parse(revisions[0].beforeJson)).toEqual({ cash: 150, momoFloat: 260 });
    expect(JSON.parse(revisions[0].afterJson)).toEqual({ cash: 145, momoFloat: 260 });
    expect(revisions[0].fields).toBe("cash");

    const detail = await getShiftDetail(shiftId);
    expect(detail?.shift.revisions).toHaveLength(1);
    expect(detail?.shift.revisions[0].before.cash).toBe(150);

    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: f.tenantId, action: "shift.corrected" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(JSON.parse(String(audit?.details)).financialMutation).toBe(false);
  });

  it("refuses a correction with no change, a short reason, or an open variance", async () => {
    const f = await fixture();
    const shiftId = await openShiftFor(f);
    await closeShiftFor(f, shiftId);

    await setSession("admin", f.admin);
    const grant = async (fields: string) =>
      (
        (await verifyPasswordAction(PASSWORD, {
          module: "admin",
          purpose: "finance.shift_handover.resolve",
          targetType: "shift",
          targetId: shiftId,
          context: { fields },
        })).data as { stepUpToken?: string }
      ).stepUpToken;

    const unchanged = await correctClosedShift({
      shiftId,
      closingCash: 150,
      closingMomoFloat: 260,
      reason: "Recount confirms the original figures exactly.",
      stepUpToken: await grant("cash"),
    });
    expect(unchanged.success).toBe(false);
    expect(unchanged.error).toMatch(/already match/i);

    const shortReason = await correctClosedShift({
      shiftId,
      closingCash: 149,
      closingMomoFloat: 260,
      reason: "oops",
      stepUpToken: await grant("cash"),
    });
    expect(shortReason.success).toBe(false);
    expect(shortReason.error).toMatch(/at least 10 characters/i);

    // A shift that is still awaiting the receiver cannot be corrected.
    const secondShift = await openShiftFor({ ...f, businessDate: new Date(Date.UTC(2026, 10, 15)) });
    await setSession("momo", f.outgoing);
    await closeShift({
      shiftId: secondShift,
      closingCash: 150,
      closingMomoFloat: 260,
      handoverToUserId: f.incoming.id,
    });
    await setSession("admin", f.admin);
    const notClosedShift = await correctClosedShift({
      shiftId: secondShift,
      closingCash: 140,
      closingMomoFloat: 260,
      reason: "Attempting to correct a shift that is not closed.",
    });
    expect(notClosedShift.success).toBe(false);
    expect(notClosedShift.error).toMatch(/only a closed shift/i);
  });
});

describe("business day bounds", () => {
  it("covers exactly one UTC day", () => {
    const { start, end } = businessDayBounds(new Date("2026-11-12T15:45:00.000Z"));
    expect(start.toISOString()).toBe("2026-11-12T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-13T00:00:00.000Z");
  });
});
