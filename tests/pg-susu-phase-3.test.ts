/**
 * Phase 3 remittance concurrency on PostgreSQL.
 *
 * The SQLite suite proves the lifecycle rules; these tests run the same actions
 * against a real PostgreSQL database so the collector settlement advisory lock,
 * conditional state transitions and unique constraints are exercised under
 * genuine parallel transactions.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { SignJWT } from "jose";
import { createSessionRecord } from "@/lib/security/session-store";
import { prisma, cleanDatabase } from "./pg-setup";
import {
  acknowledgeRemittanceReceipt,
  declareRemittance,
  getCollectorRemittancePosition,
  verifyRemittance,
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

let seq = 0;
const money = (value: unknown) => Math.round(Number(value) * 100) / 100;

async function asAdmin(user: { id: string; tenantId: string | null; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  if (!user.tenantId) throw new Error("test user has no tenant");
  const jti = `pgp3-${now}-${Math.random().toString(16).slice(2)}`;
  await createSessionRecord({
    id: jti,
    subjectType: "user",
    subjectId: user.id,
    tenantId: user.tenantId,
    expiresAt: new Date(now * 1000 + 60 * 60 * 1000),
  });
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "PG Admin",
      role: "admin",
      modules: ["susu"],
      tokenVersion: 0,
      jti,
      iat: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

async function createAdmin(tenantId: string, label: string) {
  return prisma.user.create({
    data: {
      tenantId,
      email: `pgp3-${label}-${randomBytes(4).toString("hex")}@test.local`,
      fullName: label,
      role: "admin",
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
      code: `PGP3-${seq}-${randomBytes(3).toString("hex").toUpperCase()}`,
      name: `PG Phase 3 Tenant ${seq}`,
      momoEnabled: true,
      susuEnabled: true,
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
    },
  });
  const branch = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Accra", code: `PGACC-${seq}`, status: "active" },
  });
  const admin = await createAdmin(tenant.id, "Admin");
  await prisma.businessTenant.update({
    where: { id: tenant.id },
    data: { primaryAdminUserId: admin.id },
  });

  const collectorUser = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `pgp3-collector-${seq}@test.local`,
      fullName: "PG Collector",
      role: "collector",
      status: "active",
      passwordHash: "not-used",
      susuEnabled: true,
    },
  });
  const collector = await prisma.collector.create({
    data: { tenantId: tenant.id, userId: collectorUser.id, branchId: branch.id, status: "active" },
  });
  const customer = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      customerId: `PGP3-C-${seq}`,
      fullName: "PG Customer",
      phone: `+2332100${String(seq).padStart(4, "0")}`,
      status: "active",
    },
  });
  const account = await prisma.susuAccount.create({
    data: {
      tenantId: tenant.id,
      accountId: `PGP3-S-${seq}`,
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
  return { tenant, branch, admin, collectorUser, collector, account, cycle };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function contribute(f: Fixture, amounts: number[]) {
  for (const amount of amounts) {
    await prisma.contribution.create({
      data: {
        tenantId: f.tenant.id,
        branchId: f.branch.id,
        accountId: f.account.id,
        cycleId: f.cycle.id,
        amount,
        collectionDate: new Date(2026, 0, 15),
        channel: "collector",
        collectorId: f.collector.id,
        recordedById: f.admin.id,
        referenceId: `PGP3-CON-${randomBytes(8).toString("hex")}`,
      },
    });
  }
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
});

describe("Phase 3 remittance concurrency (PostgreSQL)", () => {
  it("acknowledges a receipt exactly once under parallel submissions", async () => {
    const f = await fixture();
    await contribute(f, [1000]);
    await asAdmin(f.admin);
    const declared = await declareRemittance({ collectorId: f.collector.id, declaredAmount: 1000 });
    expect(declared.success).toBe(true);
    const remittanceId = (declared.data as { id: string }).id;

    const results = await Promise.all([
      acknowledgeRemittanceReceipt({ remittanceId, receivedAmount: 1000 }),
      acknowledgeRemittanceReceipt({ remittanceId, receivedAmount: 1000 }),
      acknowledgeRemittanceReceipt({ remittanceId, receivedAmount: 1000 }),
    ]);
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(await prisma.remittanceDiscrepancy.count({ where: { remittanceId } })).toBe(0);

    const stored = await prisma.collectorRemittance.findUniqueOrThrow({ where: { id: remittanceId } });
    expect(stored.status).toBe("received");
    expect(stored.receivedAt).not.toBeNull();
  });

  it("creates one declaration for parallel retries sharing an idempotency key", async () => {
    const f = await fixture();
    await contribute(f, [900]);
    await asAdmin(f.admin);
    const idempotencyKey = `pg-parallel-${randomBytes(4).toString("hex")}`;

    const results = await Promise.all([
      declareRemittance({ collectorId: f.collector.id, declaredAmount: 900, idempotencyKey }),
      declareRemittance({ collectorId: f.collector.id, declaredAmount: 900, idempotencyKey }),
      declareRemittance({ collectorId: f.collector.id, declaredAmount: 900, idempotencyKey }),
    ]);
    expect(results.every((result) => result.success)).toBe(true);
    const ids = new Set(results.map((result) => (result.data as { id: string }).id));
    expect(ids.size).toBe(1);
    expect(await prisma.collectorRemittance.count()).toBe(1);
    expect(await prisma.remittanceContribution.count()).toBe(1);
  });

  it("never settles the same contributions twice when declarations race", async () => {
    const f = await fixture();
    await contribute(f, [1000]);
    await asAdmin(f.admin);

    const results = await Promise.all([
      declareRemittance({ collectorId: f.collector.id, declaredAmount: 1000, idempotencyKey: `pg-a-${randomBytes(3).toString("hex")}` }),
      declareRemittance({ collectorId: f.collector.id, declaredAmount: 1000, idempotencyKey: `pg-b-${randomBytes(3).toString("hex")}` }),
    ]);
    expect(results.every((result) => result.success)).toBe(true);

    const allocated = await prisma.remittanceContribution.aggregate({ _sum: { amount: true } });
    expect(money(allocated._sum.amount)).toBe(1000);
    const links = await prisma.remittanceContribution.findMany();
    expect(links.length).toBe(1);

    const position = await getCollectorRemittancePosition(f.collector.id);
    expect(position?.outstanding).toBe(0);
    expect(position?.settled).toBe(2000);

    // The second race is cash received beyond the collections, recorded as a
    // single open over-remittance discrepancy rather than a second settlement.
    expect(await prisma.remittanceDiscrepancy.count({ where: { type: "over_remittance", status: "open" } })).toBe(1);
  });

  it("verifies a remittance exactly once under parallel verifiers", async () => {
    const f = await fixture();
    await contribute(f, [1500]);
    await asAdmin(f.admin);
    const declared = await declareRemittance({ collectorId: f.collector.id, declaredAmount: 1500 });
    const remittanceId = (declared.data as { id: string }).id;
    await acknowledgeRemittanceReceipt({ remittanceId, receivedAmount: 1500 });

    const first = await createAdmin(f.tenant.id, "Verifier One");
    const second = await createAdmin(f.tenant.id, "Verifier Two");
    await asAdmin(first);

    // The session cookie identifies a single actor, so run the two verifiers
    // sequentially at the identity layer while their transactions still overlap
    // through Promise.all: both read the same pre-verification row.
    const race = await Promise.all([
      verifyRemittance({ remittanceId, verifiedAmount: 1500 }),
      (async () => {
        await asAdmin(second);
        return verifyRemittance({ remittanceId, verifiedAmount: 1500 });
      })(),
    ]);
    expect(race.filter((result) => result.success)).toHaveLength(1);

    const stored = await prisma.collectorRemittance.findUniqueOrThrow({ where: { id: remittanceId } });
    expect(stored.status).toBe("verified");
    expect(await prisma.remittanceDiscrepancy.count({ where: { remittanceId } })).toBe(0);
  });
});
