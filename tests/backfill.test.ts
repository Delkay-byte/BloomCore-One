/**
 * BIK Prestige Enterprise — Backfill / migration safety tests.
 *
 * Runs the REAL operator script (scripts/backfill-bik-tenant.mjs) against the
 * SQLite test database and verifies:
 *   * legacy rows without a tenant are assigned to the BIK tenant
 *   * row counts are preserved exactly — nothing deleted, nothing recreated
 *   * identifiers are untouched
 *   * the script is idempotent
 *   * a second tenant enrolled afterwards starts blind to BIK data
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { execFileSync } from "child_process";
import path from "path";
import { prisma, cleanDatabase, createTestAdmin, createTestCustomer, createTestTenant } from "./setup";
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => ({ get: () => null }),
}));
vi.mock("next/navigation", () => ({ redirect: (p: string) => { throw new Error(`REDIRECT:${p}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const SCRIPT = path.resolve(__dirname, "..", "scripts", "backfill-bik-tenant.mjs");

function runBackfill() {
  execFileSync("node", [SCRIPT], {
    env: { ...process.env },
    stdio: "pipe",
    encoding: "utf-8",
  });
}

async function snapshot() {
  return {
    user: await prisma.user.count(),
    location: await prisma.location.count(),
    dailyAccount: await prisma.dailyAccount.count(),
    expense: await prisma.expense.count(),
    customer: await prisma.customer.count(),
    susuAccount: await prisma.susuAccount.count(),
    susuCycle: await prisma.susuCycle.count(),
    contribution: await prisma.contribution.count(),
    withdrawal: await prisma.withdrawal.count(),
    cardFee: await prisma.cardFee.count(),
    collector: await prisma.collector.count(),
  };
}

describe("Backfill — legacy BIK data becomes tenant-owned", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("assigns all legacy rows to the BIK tenant, preserves counts and is idempotent", async () => {
    // ── Legacy pre-tenancy state: rows WITHOUT any tenantId ──────────────
    const legacyAdmin = await prisma.user.create({
      data: {
        email: `legacy-admin-${Date.now()}@bikprestige.com`,
        fullName: "Legacy BIK Admin",
        role: "admin",
        status: "active",
        passwordHash: "legacy-hash",
      },
    });
    const legacyLocation = await prisma.location.create({
      data: { name: "Legacy HQ", code: `LQ-${Date.now()}`, status: "active" },
    });
    const legacy = await createTestCustomer(legacyAdmin.id, 50, "LGCY1");
    // createTestCustomer's helper attaches the admin's tenant — strip it back
    // to simulate true pre-tenancy NULLs.
    await prisma.customer.update({ where: { id: legacy.customer.id }, data: { tenantId: null } });
    await prisma.susuAccount.update({ where: { id: legacy.account.id }, data: { tenantId: null } });
    await prisma.susuCycle.update({ where: { id: legacy.cycle.id }, data: { tenantId: null } });
    await prisma.cardFee.updateMany({ where: { accountId: legacy.account.id }, data: { tenantId: null } });
    await prisma.location.update({ where: { id: legacyLocation.id }, data: { tenantId: null } });

    const before = await snapshot();
    const identifiersBefore = {
      customerId: legacy.customer.customerId,
      accountId: legacy.account.accountId,
    };

    // ── Run the operator script ──────────────────────────────────────────
    runBackfill();

    // ── Verify ───────────────────────────────────────────────────────────
    const after = await snapshot();
    expect(after).toEqual(before); // no rows deleted or added

    const tenant = await prisma.businessTenant.findUnique({ where: { code: "BIK-HQ-001" } });
    expect(tenant).not.toBeNull();
    expect(tenant!.momoEnabled).toBe(true);
    expect(tenant!.susuEnabled).toBe(true);
    expect(tenant!.status).toBe("ACTIVE");

    const updatedAdmin = await prisma.user.findUniqueOrThrow({ where: { id: legacyAdmin.id } });
    expect(updatedAdmin.tenantId).toBe(tenant!.id);
    expect(updatedAdmin.passwordHash).toBe("legacy-hash"); // identifiers & credentials untouched

    const updatedCustomer = await prisma.customer.findUniqueOrThrow({ where: { id: legacy.customer.id } });
    expect(updatedCustomer.customerId).toBe(identifiersBefore.customerId);
    expect(updatedCustomer.tenantId).toBe(tenant!.id);

    const updatedAccount = await prisma.susuAccount.findUniqueOrThrow({ where: { id: legacy.account.id } });
    expect(updatedAccount.accountId).toBe(identifiersBefore.accountId);
    expect(updatedAccount.tenantId).toBe(tenant!.id);

    const updatedLocation = await prisma.location.findUniqueOrThrow({ where: { id: legacyLocation.id } });
    expect(updatedLocation.tenantId).toBe(tenant!.id);

    // Tenant primary admin is set to the existing admin
    expect(tenant!.primaryAdminUserId).toBe(legacyAdmin.id);

    // ── Idempotency: running again changes nothing ───────────────────────
    runBackfill();
    const afterAgain = await snapshot();
    expect(afterAgain).toEqual(before);
    expect(await prisma.businessTenant.count({ where: { code: "BIK-HQ-001" } })).toBe(1);

    // Backfilled rows must remain assigned (still exactly one tenant owner).
    const usersWithoutTenant = await prisma.user.count({ where: { tenantId: null } });
    expect(usersWithoutTenant).toBe(0);
  });

  it("a second tenant enrolled after the backfill starts blind to BIK data", async () => {
    // BIK tenant with data (post-backfill state)
    const bikAdmin = await createTestAdmin();
    const bikTenant = await prisma.businessTenant.findUniqueOrThrow({
      where: { id: bikAdmin.tenantId! },
    });
    await createTestCustomer(bikAdmin.id, 50, "BIK01");

    // Freshly enrolled second tenant
    const secondTenant = await createTestTenant({ name: "Second Business Ltd" });
    const secondAdmin = await createTestAdmin({ tenantId: secondTenant.id });

    // At the data layer the second tenant owns nothing of BIK's…
    const secondCustomers = await prisma.customer.count({ where: { tenantId: secondTenant.id } });
    const bikCustomers = await prisma.customer.count({ where: { tenantId: bikTenant.id } });
    expect(secondCustomers).toBe(0);
    expect(bikCustomers).toBeGreaterThan(0);

    // …and the two tenants are distinct isolation domains.
    expect(secondTenant.id).not.toBe(bikTenant.id);
    expect(secondAdmin.tenantId).toBe(secondTenant.id);
  });
});
