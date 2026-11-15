import { beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanDatabase } from "./pg-setup";

/**
 * PostgreSQL rehearsal of the data backfills in
 * 20261115_email_verification_password_policy.
 *
 * The CI job applies the real migration to an empty database before this file
 * runs. This test seeds credential-bearing rows that represent the deployed
 * schema, executes the migration's backfill statements and verifies that only
 * the intended flags change. A separate manual rehearsal applies the migration
 * from the previous migration state against a disposable PostgreSQL container.
 */

const BACKFILL = [
  `UPDATE "User" SET "emailVerified" = true WHERE "emailVerified" IS DISTINCT FROM true`,
  `UPDATE "User" SET "forcePasswordReset" = true`,
  `UPDATE "PlatformSuperAdmin" SET "forcePasswordReset" = true WHERE "passwordHash" IS NOT NULL AND "passwordHash" <> ''`,
  `UPDATE "Customer" SET "forcePortalPasswordReset" = true WHERE "portalEnabled" = true AND "portalPasswordHash" IS NOT NULL AND "portalPasswordHash" <> ''`,
];

describe("auth upgrade migration backfills", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("marks all credential-bearing account types without touching credentials or scopes", async () => {
    const tenant = await prisma.businessTenant.create({
      data: { code: `MIG-${Date.now()}`, name: "Migration Tenant" },
    });

    const hash = "$2b$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ";
    const admin = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "migration-admin@example.com",
        fullName: "Admin",
        role: "admin",
        status: "active",
        passwordHash: hash,
        forcePasswordReset: false,
        emailVerified: true,
      },
    });
    const worker = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "migration-worker@example.com",
        fullName: "Worker",
        role: "worker",
        status: "active",
        momoEnabled: true,
        passwordHash: hash,
        forcePasswordReset: false,
        emailVerified: true,
      },
    });
    const collector = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "migration-collector@example.com",
        fullName: "Collector",
        role: "collector",
        status: "active",
        susuEnabled: true,
        passwordHash: hash,
        forcePasswordReset: false,
        emailVerified: true,
      },
    });

    const platform = await prisma.platformSuperAdmin.create({
      data: {
        email: "migration-platform@example.com",
        fullName: "Platform",
        status: "active",
        passwordHash: hash,
        forcePasswordReset: false,
      },
    });
    const inactivePlatform = await prisma.platformSuperAdmin.create({
      data: {
        email: "migration-platform-inactive@example.com",
        fullName: "Platform Inactive",
        status: "inactive",
        passwordHash: hash,
        forcePasswordReset: false,
      },
    });

    const portalCustomer = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        customerId: `BIK-C-MIG-${Date.now()}`,
        fullName: "Portal Customer",
        phone: "+233240009111",
        status: "active",
        portalEnabled: true,
        portalPasswordHash: hash,
        forcePortalPasswordReset: false,
      },
    });
    const noPortalCustomer = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        customerId: `BIK-C-NOP-${Date.now()}`,
        fullName: "No Portal",
        phone: "+233240009112",
        status: "active",
        portalEnabled: false,
        forcePortalPasswordReset: false,
      },
    });
    const enabledWithoutHash = await prisma.customer.create({
      data: {
        tenantId: tenant.id,
        customerId: `BIK-C-EMP-${Date.now()}`,
        fullName: "Enabled No Hash",
        phone: "+233240009113",
        status: "active",
        portalEnabled: true,
        forcePortalPasswordReset: false,
      },
    });

    const session = await prisma.sessionRecord.create({
      data: {
        id: `migration-session-${Date.now()}`,
        subjectType: "user",
        subjectId: admin.id,
        tenantId: tenant.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    for (const statement of BACKFILL) {
      await prisma.$executeRawUnsafe(statement);
    }

    const users = await prisma.user.findMany({ where: { tenantId: tenant.id } });
    for (const user of users) {
      expect(user.forcePasswordReset).toBe(true);
      expect(user.emailVerified).toBe(true);
      expect(user.passwordHash).toBe(hash);
      expect(user.tokenVersion).toBe(0);
    }
    expect(users.map((u) => u.id).sort()).toEqual(
      [admin.id, worker.id, collector.id].sort()
    );
    expect(users.every((u) => u.tenantId === tenant.id)).toBe(true);
    expect(users.find((u) => u.id === worker.id)?.momoEnabled).toBe(true);
    expect(users.find((u) => u.id === collector.id)?.susuEnabled).toBe(true);

    const platformAfter = await prisma.platformSuperAdmin.findMany();
    expect(platformAfter.every((row) => row.forcePasswordReset)).toBe(true);
    expect(platformAfter.every((row) => row.passwordHash === hash)).toBe(true);
    expect(platformAfter.find((row) => row.id === inactivePlatform.id)?.status).toBe(
      "inactive"
    );

    const portalAfter = await prisma.customer.findUnique({
      where: { id: portalCustomer.id },
    });
    expect(portalAfter?.forcePortalPasswordReset).toBe(true);
    expect(portalAfter?.portalPasswordHash).toBe(hash);
    expect(portalAfter?.tenantId).toBe(tenant.id);

    for (const untouched of [noPortalCustomer, enabledWithoutHash]) {
      const row = await prisma.customer.findUnique({ where: { id: untouched.id } });
      expect(row?.forcePortalPasswordReset).toBe(false);
      expect(row?.portalPasswordHash).toBeNull();
    }

    const sessionAfter = await prisma.sessionRecord.findUnique({
      where: { id: session.id },
    });
    expect(sessionAfter?.revokedAt).toBeNull();
    expect(sessionAfter?.expiresAt.getTime()).toBe(session.expiresAt.getTime());
    expect(platform.id).toBeTruthy();
  });
});
