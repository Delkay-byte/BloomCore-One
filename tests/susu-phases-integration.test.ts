/**
 * Cross-phase integration (Phase 1 branch foundation + Phase 2 collector
 * operations + Phase 3 remittance lifecycle).
 *
 * These tests only pass when the three phases agree: Phase 2 suspension stops
 * Phase 3 declarations, Phase 2 transfers never rewrite Phase 1 branch
 * attribution, Phase 1 branch scoping limits Phase 3 visibility, and offline
 * (Phase 1/2) evidence flows into the Phase 3 settlement chain.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { SignJWT } from "jose";
import { createSessionRecord } from "@/lib/security/session-store";
import {
  hashStepUpToken,
  stepUpContextHash,
  stepUpSessionBinding,
} from "@/lib/security/step-up";
import { prisma, cleanDatabase } from "./setup";
import { assignCustomerToCollector, transferCustomerAssignment } from "@/lib/actions/susu-assignment";
import { changeCollectorLifecycleStatus } from "@/lib/actions/susu-collector-lifecycle";
import { recordRemittance } from "@/lib/actions/susu-collector.actions";
import {
  declareRemittance,
  getCollectorRemittancePosition,
  getRemittanceById,
} from "@/lib/actions/susu-remittance.actions";

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

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");
const money = (value: unknown) => Math.round(Number(value) * 100) / 100;
let seq = 0;

async function setSession(
  user: { id: string; tenantId: string | null; email: string },
  role: "admin" | "collector"
) {
  const now = Math.floor(Date.now() / 1000);
  if (!user.tenantId) throw new Error("test user has no tenant");
  const jti = `xp-${role}-${now}-${Math.random().toString(16).slice(2)}`;
  const session = {
    userId: user.id,
    email: user.email,
    fullName: role === "admin" ? "Cross Phase Admin" : "Cross Phase Collector",
    role,
    modules: ["susu"],
    tokenVersion: 0,
    jti,
    iat: now,
  };
  await createSessionRecord({
    id: jti,
    subjectType: "user",
    subjectId: user.id,
    tenantId: user.tenantId,
    expiresAt: new Date(now * 1000 + 60 * 60 * 1000),
  });
  mockCookieStore.clear();
  mockCookieStore.set(
    role === "admin" ? "bik-admin-session" : "bik-collector-session",
    await new SignJWT(session)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
  return session;
}

async function createUser(tenantId: string, role: "admin" | "collector", label: string) {
  return prisma.user.create({
    data: {
      tenantId,
      email: `xp-${label}-${randomBytes(4).toString("hex")}@test.local`,
      fullName: label,
      role,
      status: "active",
      passwordHash: "not-used",
      momoEnabled: true,
      susuEnabled: true,
    },
  });
}

async function fixture() {
  seq += 1;
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `XP-${seq}-${randomBytes(3).toString("hex").toUpperCase()}`,
      name: `Cross Phase Tenant ${seq}`,
      momoEnabled: true,
      susuEnabled: true,
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
    },
  });
  const branchA = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Accra", code: `XPACC-${seq}`, status: "active" },
  });
  const branchB = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Kumasi", code: `XPKUM-${seq}`, status: "active" },
  });
  const admin = await createUser(tenant.id, "admin", "Admin");
  await prisma.businessTenant.update({
    where: { id: tenant.id },
    data: { primaryAdminUserId: admin.id },
  });

  const collectorUserA = await createUser(tenant.id, "collector", "Collector A");
  const collectorA = await prisma.collector.create({
    data: { tenantId: tenant.id, userId: collectorUserA.id, branchId: branchA.id, status: "active" },
  });
  const collectorUserB = await createUser(tenant.id, "collector", "Collector B");
  const collectorB = await prisma.collector.create({
    data: { tenantId: tenant.id, userId: collectorUserB.id, branchId: branchB.id, status: "active" },
  });

  const customer = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      customerId: `XP-C-${seq}`,
      fullName: "Cross Phase Customer",
      phone: `+2332400${String(seq).padStart(4, "0")}`,
      status: "active",
    },
  });
  const account = await prisma.susuAccount.create({
    data: {
      tenantId: tenant.id,
      accountId: `XP-S-${seq}`,
      customerId: customer.id,
      dailyContribution: 50,
      status: "active",
      cardCustody: "customer",
    },
  });
  const cycle = await prisma.susuCycle.create({
    data: {
      tenantId: tenant.id,
      accountId: account.id,
      cycleNumber: 1,
      startDate: new Date(2026, 0, 1),
      endDate: new Date(2026, 0, 31),
      dailyContribution: 50,
      status: "active",
      commissionCharged: false,
    },
  });
  return {
    tenant, branchA, branchB, admin, customer, account, cycle,
    collectorUserA, collectorA, collectorUserB, collectorB,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function contribute(
  f: Fixture,
  collectorId: string | null,
  branchId: string | null,
  amount: number,
  extra: { capturedAt?: Date; recordedDeviceId?: string; recordedDeviceName?: string } = {}
) {
  return prisma.contribution.create({
    data: {
      tenantId: f.tenant.id,
      branchId,
      accountId: f.account.id,
      cycleId: f.cycle.id,
      amount,
      collectionDate: new Date(2026, 0, 15),
      channel: "collector",
      collectorId,
      recordedById: f.admin.id,
      capturedAt: extra.capturedAt ?? null,
      recordedDeviceId: extra.recordedDeviceId ?? null,
      recordedDeviceName: extra.recordedDeviceName ?? null,
      referenceId: `XP-CON-${randomBytes(8).toString("hex")}`,
    },
  });
}

async function lifecycleGrant(adminId: string, session: { jti: string; iat: number }, collectorId: string) {
  const raw = `xp-lifecycle-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await prisma.stepUpGrant.create({
    data: {
      tokenHash: hashStepUpToken(raw),
      subjectType: "user",
      subjectId: adminId,
      sessionId: stepUpSessionBinding({ jti: session.jti, iat: session.iat }, adminId),
      purpose: "collector.lifecycle",
      targetType: "collector",
      targetId: collectorId,
      contextHash: stepUpContextHash({
        purpose: "collector.lifecycle",
        targetType: "collector",
        targetId: collectorId,
        context: {},
      }),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });
  return raw;
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
});

describe("Phases 1-3 integration", () => {
  it("a Phase 2 suspension stops a Phase 3 remittance declaration", async () => {
    const f = await fixture();
    await contribute(f, f.collectorA.id, f.branchA.id, 1000);
    const session = await setSession(f.admin, "admin");

    const suspended = await changeCollectorLifecycleStatus({
      collectorId: f.collectorA.id,
      newStatus: "suspended",
      reason: "Cash handling investigation",
      stepUpToken: await lifecycleGrant(f.admin.id, session, f.collectorA.id),
    });
    expect(suspended.success).toBe(true);

    await setSession(f.collectorUserA, "collector");
    const declaration = await declareRemittance({ declaredAmount: 1000 });
    expect(declaration.success).toBe(false);
    expect(declaration.error).toMatch(/not authorised|suspended|inactive|not found/i);
    expect(await prisma.collectorRemittance.count()).toBe(0);
  });

  it("a Phase 2 collector transfer preserves Phase 1 branch and Phase 2 contribution attribution", async () => {
    const f = await fixture();
    await setSession(f.admin, "admin");

    const assigned = await assignCustomerToCollector({
      collectorId: f.collectorA.id,
      customerId: f.customer.id,
      accountId: f.account.id,
      reason: "Initial route allocation",
    });
    expect(assigned.success).toBe(true);

    const contribution = await contribute(f, f.collectorA.id, f.branchA.id, 1200);

    const transferred = await transferCustomerAssignment({
      collectorId: f.collectorB.id,
      fromCollectorId: f.collectorA.id,
      customerId: f.customer.id,
      accountId: f.account.id,
      reason: "Collector changed route",
    });
    expect(transferred.success).toBe(true);

    const unchanged = await prisma.contribution.findUniqueOrThrow({ where: { id: contribution.id } });
    expect(unchanged.collectorId).toBe(f.collectorA.id);
    expect(unchanged.branchId).toBe(f.branchA.id);
    expect(money(unchanged.amount)).toBe(1200);

    // Both the original and the new assignment are retained as history.
    const assignments = await prisma.collectorCustomerAssignment.findMany({
      where: { tenantId: f.tenant.id, accountId: f.account.id },
      orderBy: { assignedAt: "asc" },
    });
    expect(assignments).toHaveLength(2);
    expect(assignments.filter((row) => row.active)).toHaveLength(1);
    expect(assignments[0].collectorId).toBe(f.collectorA.id);
    expect(assignments[1].collectorId).toBe(f.collectorB.id);
    const events = await prisma.collectorAssignmentEvent.findMany({
      where: { tenantId: f.tenant.id, assignmentId: { in: assignments.map((row) => row.id) } },
    });
    expect(events.length).toBeGreaterThanOrEqual(2);

    // The transferred contribution still settles against the original collector.
    const position = await getCollectorRemittancePosition(f.collectorA.id);
    expect(position?.outstanding).toBe(1200);
    expect((await getCollectorRemittancePosition(f.collectorB.id))?.outstanding).toBe(0);
  });

  it("a branch manager sees only remittances received from their own branch", async () => {
    const f = await fixture();
    await contribute(f, f.collectorA.id, f.branchA.id, 600);
    await setSession(f.admin, "admin");
    const declared = await declareRemittance({ collectorId: f.collectorA.id, declaredAmount: 600 });
    expect(declared.success).toBe(true);
    const remittanceId = (declared.data as { id: string }).id;

    const managerA = await createUser(f.tenant.id, "admin", "Manager A");
    await prisma.branchMembership.create({
      data: { tenantId: f.tenant.id, userId: managerA.id, locationId: f.branchA.id, role: "branch_manager", status: "active" },
    });
    const managerB = await createUser(f.tenant.id, "admin", "Manager B");
    await prisma.branchMembership.create({
      data: { tenantId: f.tenant.id, userId: managerB.id, locationId: f.branchB.id, role: "branch_manager", status: "active" },
    });

    await setSession(managerA, "admin");
    expect((await getRemittanceById(remittanceId))?.id).toBe(remittanceId);

    await setSession(managerB, "admin");
    expect(await getRemittanceById(remittanceId)).toBeNull();
  });

  it("an offline-synced contribution becomes part of the remittance workflow with its evidence intact", async () => {
    const f = await fixture();
    const capturedAt = new Date(2026, 0, 10, 9, 30);
    const contribution = await contribute(f, f.collectorA.id, f.branchA.id, 750, {
      capturedAt,
      recordedDeviceId: "device-xp-1",
      recordedDeviceName: "Collector handset",
    });
    await setSession(f.admin, "admin");

    const declared = await declareRemittance({ collectorId: f.collectorA.id, declaredAmount: 750 });
    expect(declared.success).toBe(true);
    expect(money((declared.data as { expectedAmount: unknown }).expectedAmount)).toBe(750);

    const stored = await prisma.contribution.findUniqueOrThrow({ where: { id: contribution.id } });
    expect(stored.capturedAt?.toISOString()).toBe(capturedAt.toISOString());
    expect(stored.recordedDeviceId).toBe("device-xp-1");
    expect(stored.branchId).toBe(f.branchA.id);
    expect(
      await prisma.remittanceContribution.count({ where: { contributionId: contribution.id } })
    ).toBe(1);
  });

  it("reconciles a counter handover with the field declaration balance", async () => {
    const f = await fixture();
    await contribute(f, f.collectorA.id, f.branchA.id, 1000);
    await setSession(f.admin, "admin");

    // The office records GH₵400 handed in at the counter (Phase 2 path).
    const counter = await recordRemittance({ collectorId: f.collectorA.id, remittedAmount: 400 });
    expect(counter.success).toBe(true);
    const counterId = (counter.data as { id: string }).id;

    let position = await getCollectorRemittancePosition(f.collectorA.id);
    expect(position?.settled).toBe(400);
    expect(position?.outstanding).toBe(600);

    // The counter handover is linked to the contribution it settled.
    const counterLinks = await prisma.remittanceContribution.aggregate({
      where: { remittanceId: counterId },
      _sum: { amount: true },
    });
    expect(money(counterLinks._sum.amount)).toBe(400);

    // The collector then declares only the remaining balance in the field app.
    const declared = await declareRemittance({ collectorId: f.collectorA.id, declaredAmount: 600 });
    expect(declared.success).toBe(true);
    expect(money((declared.data as { expectedAmount: unknown }).expectedAmount)).toBe(600);
    expect(money((declared.data as { outstandingAmount: unknown }).outstandingAmount)).toBe(0);

    position = await getCollectorRemittancePosition(f.collectorA.id);
    expect(position?.outstanding).toBe(0);
    const totalAllocated = await prisma.remittanceContribution.aggregate({ _sum: { amount: true } });
    expect(money(totalAllocated._sum.amount)).toBe(1000);
  });
  it("keeps historical unassigned branch data unassigned instead of inventing a branch", async () => {
    const f = await fixture();
    const legacy = await contribute(f, null, null, 500);
    const orphanCollectorUser = await createUser(f.tenant.id, "collector", "Unassigned Collector");
    const orphanCollector = await prisma.collector.create({
      data: { tenantId: f.tenant.id, userId: orphanCollectorUser.id, branchId: null, status: "active" },
    });

    // A legacy remittance row predating branch attribution, with no branch and
    // no receiving branch. It must remain readable and must not be assigned to a
    // guessed branch when it is loaded.
    const legacyRemittance = await prisma.collectorRemittance.create({
      data: {
        tenantId: f.tenant.id,
        collectorId: orphanCollector.id,
        branchId: null,
        expectedAmount: 500,
        remittedAmount: 500,
        variance: 0,
        outstandingAmount: 0,
        method: "cash",
        status: "submitted",
        declaredById: f.admin.id,
        submittedAt: new Date(2026, 0, 15),
        recordedById: f.admin.id,
        referenceId: `XP-LEGACY-${randomBytes(6).toString("hex")}`,
      },
    });

    await setSession(f.admin, "admin");
    const loaded = await getRemittanceById(legacyRemittance.id);
    expect(loaded?.id).toBe(legacyRemittance.id);
    expect(loaded?.branchId).toBeNull();

    // A collector with no branch cannot declare against a branch-ful tenant.
    const declaration = await declareRemittance({
      collectorId: orphanCollector.id,
      declaredAmount: 500,
    });
    expect(declaration.success).toBe(false);
    expect(declaration.error).toMatch(/assign the collector to a branch/i);

    const stored = await prisma.contribution.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(stored.branchId).toBeNull();
    expect(stored.collectorId).toBeNull();
    const remittances = await prisma.collectorRemittance.findMany({ where: { tenantId: f.tenant.id } });
    expect(remittances).toHaveLength(1);
    expect(remittances[0].branchId).toBeNull();
  });
});
