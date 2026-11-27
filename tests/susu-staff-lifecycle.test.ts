/**
 * Phase 8 — staff lifecycle.
 *
 * These exercise the real action module against an isolated SQLite database.
 * Step-up grants are minted through the real helper so the tests prove the
 * actual claim path, not a bypass. The point of the suite is that an
 * offboarding cannot happen without authorisation, cannot strand live
 * responsibilities, and cannot leave a working session behind.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SignJWT } from "jose";
import {
  prisma,
  cleanDatabase,
  createTestAdmin,
  createTestTenant,
} from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name) ? { name, value: mockCookieStore.get(name)! } : undefined,
    set: (name: string, value: string) => {
      mockCookieStore.set(name, value);
    },
    delete: (name: string) => {
      mockCookieStore.delete(name);
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error("REDIRECT:" + path);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  assignStaffBranch,
  changeStaffRole,
  getStaffLifecycleOverview,
  getStaffOffboardingReadiness,
  offboardStaff,
  reactivateStaff,
  revokeStaffBranchMembership,
  revokeStaffSessions,
} from "@/lib/actions/susu-staff-lifecycle.actions";
import { createStepUpGrant } from "@/lib/security/step-up";

const SECRET = new TextEncoder().encode("test-secret-for-vitest");

let currentIat = 0;

async function setAdminSession(user: { id: string; email: string; fullName?: string }) {
  currentIat = Math.floor(Date.now() / 1000);
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: user.fullName ?? "Administrator",
      role: "admin",
      modules: [],
      tokenVersion: 0,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(currentIat)
      .setExpirationTime("1h")
      .sign(SECRET)
  );
  mockCookieStore.delete("bik-collector-session");
}

async function grant(
  adminId: string,
  purpose: "staff.lifecycle" | "staff.assignment" | "admin.export",
  targetType: string,
  targetId: string
) {
  const created = await createStepUpGrant({
    subjectType: "user",
    subjectId: adminId,
    sessionId: "legacy:" + adminId + ":" + currentIat,
    purpose,
    targetType,
    targetId,
  });
  return created.token;
}

async function makeStaff(tenantId: string, role: string, fullName: string, email: string) {
  return prisma.user.create({
    data: {
      tenantId,
      email,
      fullName,
      role,
      status: "active",
      passwordHash: "x",
      susuEnabled: true,
      momoEnabled: false,
    },
  });
}

let tenant: { id: string };
let admin: { id: string; email: string };
let worker: { id: string; email: string; fullName: string; role: string };
let branch: { id: string; name: string };

beforeEach(async () => {
  mockCookieStore.clear();
  await cleanDatabase();
  tenant = await createTestTenant({ momo: false, susu: true, name: "Lifecycle Susu" });
  admin = await createTestAdmin({ tenantId: tenant.id, momo: false, susu: true });
  branch = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Tema", code: "T1", status: "active" },
  });
  worker = await makeStaff(tenant.id, "worker", "Ama Worker", "ama@lifecycle.test");
  await setAdminSession(admin);
});

describe("staff lifecycle overview", () => {
  it("lists active and inactive staff with branch options", async () => {
    const overview = await getStaffLifecycleOverview();
    expect(overview.companyWideActor).toBe(true);
    expect(overview.canManageRoles).toBe(true);
    const row = overview.rows.find((item) => item.id === worker.id);
    expect(row?.fullName).toBe("Ama Worker");
    expect(row?.status).toBe("active");
    expect(row?.readyToOffboard).toBe(true);
    expect(overview.branches.map((item) => item.name)).toContain("Tema");
  });

  it("reports blockers and never claims readiness while a responsibility is live", async () => {
    const collector = await makeStaff(tenant.id, "collector", "Kofi Collector", "kofi@lifecycle.test");
    const collectorRow = await prisma.collector.create({
      data: { tenantId: tenant.id, userId: collector.id, branchId: branch.id, status: "active" },
    });
    const customer = await prisma.customer.create({
      data: { tenantId: tenant.id, customerId: "BIK-C-L1", fullName: "Test Customer", phone: "+233200000001" },
    });
    const account = await prisma.susuAccount.create({
      data: {
        tenantId: tenant.id,
        accountId: "BIK-S-L1",
        customerId: customer.id,
        dailyContribution: 10,
        status: "active",
      },
    });
    await prisma.collectorCustomerAssignment.create({
      data: { tenantId: tenant.id, collectorId: collectorRow.id, customerId: customer.id, accountId: account.id },
    });

    const readiness = await getStaffOffboardingReadiness(collector.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((item) => item.key)).toContain("active_assignments");

    const attempt = await offboardStaff({
      userId: collector.id,
      reason: "Left the company on Friday",
      stepUpToken: await grant(admin.id, "staff.lifecycle", "user", collector.id),
    });
    expect(attempt.success).toBe(false);
    expect(attempt.blockers?.length).toBeGreaterThan(0);
    const still = await prisma.user.findUniqueOrThrow({ where: { id: collector.id } });
    expect(still.status).toBe("active");
  });
});

describe("offboarding", () => {
  it("requires a reason of at least ten characters", async () => {
    const short = await offboardStaff({ userId: worker.id, reason: "left" });
    expect(short.success).toBe(false);
    expect(short.error).toMatch(/at least 10/i);
  });

  it("refuses the actor's own account", async () => {
    const result = await offboardStaff({
      userId: admin.id,
      reason: "I am leaving the business today",
      stepUpToken: await grant(admin.id, "staff.lifecycle", "user", admin.id),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/own account/i);
  });

  it("refuses without a step-up grant and leaves the account untouched", async () => {
    const result = await offboardStaff({
      userId: worker.id,
      reason: "Left the company on Friday",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/password|authori/i);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: worker.id } });
    expect(row.status).toBe("active");
  });

  it("offboards one person completely, records the change and revokes sessions", async () => {
    await prisma.branchMembership.create({
      data: { tenantId: tenant.id, userId: worker.id, locationId: branch.id, role: "branch_manager" },
    });
    await prisma.sessionRecord.create({
      data: {
        id: "worker-session-" + Date.now(),
        subjectType: "user",
        subjectId: worker.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    const result = await offboardStaff({
      userId: worker.id,
      reason: "Resigned, last day was Friday",
      stepUpToken: await grant(admin.id, "staff.lifecycle", "user", worker.id),
    });
    expect(result.success).toBe(true);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: worker.id } });
    expect(row.status).toBe("inactive");
    expect(row.tokenVersion).toBe(1);
    expect(row.forcePasswordReset).toBe(true);

    const membership = await prisma.branchMembership.findFirstOrThrow({ where: { userId: worker.id } });
    expect(membership.status).toBe("inactive");

    const sessions = await prisma.sessionRecord.findMany({ where: { subjectId: worker.id } });
    expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "user.staff_offboarded", entityId: worker.id },
    });
    expect(audit.userId).toBe(admin.id);
    expect(String(audit.details)).toContain("Resigned");
  });

  it("requires a fresh grant for a second offboarding", async () => {
    const other = await makeStaff(tenant.id, "worker", "Yaa Worker", "yaa@lifecycle.test");
    const token = await grant(admin.id, "staff.lifecycle", "user", worker.id);
    const first = await offboardStaff({
      userId: worker.id,
      reason: "Resigned, last day was Friday",
      stepUpToken: token,
    });
    expect(first.success).toBe(true);
    const second = await offboardStaff({
      userId: other.id,
      reason: "Resigned, last day was Monday",
      stepUpToken: token,
    });
    expect(second.success).toBe(false);
  });
});

describe("reactivation and role changes", () => {
  it("reactivates a previously offboarded collector", async () => {
    const collectorUser = await makeStaff(tenant.id, "collector", "Kofi Collector", "kofi2@lifecycle.test");
    const collectorRow = await prisma.collector.create({
      data: { tenantId: tenant.id, userId: collectorUser.id, branchId: branch.id, status: "inactive" },
    });
    await prisma.user.update({ where: { id: collectorUser.id }, data: { status: "inactive" } });

    const result = await reactivateStaff({
      userId: collectorUser.id,
      reason: "Returned from leave",
      stepUpToken: await grant(admin.id, "staff.lifecycle", "user", collectorUser.id),
    });
    expect(result.success).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: collectorUser.id } })).status).toBe("active");
    expect((await prisma.collector.findUniqueOrThrow({ where: { id: collectorRow.id } })).status).toBe("active");
  });

  it("promotes a worker to collector and creates the collector record", async () => {
    const result = await changeStaffRole({
      userId: worker.id,
      role: "collector",
      stepUpToken: await grant(admin.id, "staff.assignment", "user", worker.id),
    });
    expect(result.success).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: worker.id } })).role).toBe("collector");
    expect(await prisma.collector.count({ where: { userId: worker.id } })).toBe(1);
  });

  it("never creates an administrator from the tenant console", async () => {
    const result = await changeStaffRole({
      userId: worker.id,
      role: "admin",
      stepUpToken: await grant(admin.id, "staff.assignment", "user", worker.id),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/platform support/i);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: worker.id } })).role).toBe("worker");
  });

  it("grants and then revokes branch access with separate authorisations", async () => {
    const granted = await assignStaffBranch({
      userId: worker.id,
      locationId: branch.id,
      role: "branch_manager",
      stepUpToken: await grant(admin.id, "staff.assignment", "user", worker.id),
    });
    expect(granted.success).toBe(true);
    const membership = await prisma.branchMembership.findFirstOrThrow({ where: { userId: worker.id } });
    expect(membership.status).toBe("active");

    const revoked = await revokeStaffBranchMembership({
      membershipId: membership.id,
      reason: "Moved to another branch",
      stepUpToken: await grant(admin.id, "staff.assignment", "user", worker.id),
    });
    expect(revoked.success).toBe(true);
    expect((await prisma.branchMembership.findUniqueOrThrow({ where: { id: membership.id } })).status).toBe("inactive");
  });

  it("signs a person out everywhere without deactivating the account", async () => {
    await prisma.sessionRecord.create({
      data: {
        id: "signout-session-" + Date.now(),
        subjectType: "user",
        subjectId: worker.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const result = await revokeStaffSessions({
      userId: worker.id,
      reason: "Device was lost",
      stepUpToken: await grant(admin.id, "staff.lifecycle", "user", worker.id),
    });
    expect(result.success).toBe(true);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: worker.id } });
    expect(row.status).toBe("active");
    const sessions = await prisma.sessionRecord.findMany({ where: { subjectId: worker.id } });
    expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);
  });
});

describe("branch-limited administrators", () => {
  it("cannot read or mutate the tenant staff directory", async () => {
    const limited = await makeStaff(tenant.id, "admin", "Bisi Branch Admin", "bisi@lifecycle.test");
    await prisma.branchMembership.create({
      data: {
        tenantId: tenant.id,
        userId: limited.id,
        locationId: branch.id,
        role: "branch_manager",
        status: "active",
      },
    });
    await setAdminSession(limited);

    await expect(getStaffLifecycleOverview()).rejects.toThrow(/company-wide/i);

    const denial = await offboardStaff({
      userId: worker.id,
      reason: "Branch manager tried to offboard another branch",
      stepUpToken: await grant(limited.id, "staff.lifecycle", "user", worker.id),
    });
    expect(denial.success).toBe(false);
    expect(denial.error).toMatch(/company-wide/i);

    const roleDenial = await changeStaffRole({
      userId: worker.id,
      role: "collector",
      stepUpToken: await grant(limited.id, "staff.assignment", "user", worker.id),
    });
    expect(roleDenial.success).toBe(false);
    expect(roleDenial.error).toMatch(/company-wide/i);

    expect((await prisma.user.findUniqueOrThrow({ where: { id: worker.id } })).status).toBe("active");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: worker.id } })).role).toBe("worker");
  });
});
