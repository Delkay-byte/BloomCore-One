/**
 * Phase 8 — operational guidance, controlled exports and the Phase 6 audit gap.
 *
 * The guide must describe the tenant's ACTUAL state, the staff export must be
 * authorised by a fresh password confirmation and recorded, and a Susu report
 * export must leave an audit trail (the gap this phase closed).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SignJWT } from "jose";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";

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

import { getSusuSetupGuide } from "@/lib/actions/susu-guide.actions";
import { exportStaffDirectoryCsv } from "@/lib/actions/susu-admin-export.actions";
import { createStepUpGrant } from "@/lib/security/step-up";
import { exportSusuReport } from "@/lib/actions/susu-reporting.actions";

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
}

async function grant(adminId: string, purpose: "admin.export", targetType: string, targetId: string) {
  return (
    await createStepUpGrant({
      subjectType: "user",
      subjectId: adminId,
      sessionId: "legacy:" + adminId + ":" + currentIat,
      purpose,
      targetType,
      targetId,
    })
  ).token;
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

beforeEach(async () => {
  mockCookieStore.clear();
  await cleanDatabase();
  tenant = await createTestTenant({ momo: false, susu: true, name: "Guide Susu" });
  admin = await createTestAdmin({ tenantId: tenant.id, momo: false, susu: true });
  await setAdminSession(admin);
});

describe("operational guide", () => {
  it("describes a fresh business honestly rather than claiming readiness", async () => {
    const guide = await getSusuSetupGuide();
    const byKey = new Map(guide.items.map((item) => [item.key, item]));
    expect(byKey.get("branches")?.status).toBe("todo");
    expect(byKey.get("team")?.status).toBe("todo");
    expect(byKey.get("collector")?.status).toBe("todo");
    expect(byKey.get("withdrawal-policy")?.status).toBe("todo");
    expect(byKey.get("support")?.status).toBe("todo");
    expect(byKey.get("second-admin")?.status).toBe("todo");
    expect(guide.completed).toBeLessThan(guide.total);
  });

  it("marks steps complete only once the records exist", async () => {
    const branch = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Main", code: "M1", status: "active" },
    });
    const worker = await makeStaff(tenant.id, "worker", "Office Staff", "office@guide.test");
    const collectorUser = await makeStaff(tenant.id, "collector", "Collector One", "collector@guide.test");
    const collector = await prisma.collector.create({
      data: { tenantId: tenant.id, userId: collectorUser.id, branchId: branch.id, status: "active" },
    });
    await prisma.withdrawalPolicy.create({ data: { tenantId: tenant.id, active: true } });
    await prisma.collectorRemittance.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        collectorId: collector.id,
        recordedById: admin.id,
        referenceId: "REM-TEST-GUIDE-1",
        expectedAmount: 100,
        remittedAmount: 100,
        variance: 0,
      },
    });
    await prisma.susuReconciliation.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        type: "branch_close",
        status: "reviewed",
        openedById: admin.id,
        periodStart: new Date("2027-01-01"),
        periodEnd: new Date("2027-01-02"),
      },
    });
    await prisma.supportRequest.create({
      data: {
        tenantId: tenant.id,
        reference: "SUP-2027-GUIDE1",
        submittedById: worker.id,
        category: "other",
        priority: "low",
        status: "open",
        subject: "A question about the guide",
        description: "How should the month be closed when a collector is on leave?",
        lastActivityAt: new Date(),
      },
    });

    const guide = await getSusuSetupGuide();
    const byKey = new Map(guide.items.map((item) => [item.key, item]));
    for (const key of ["branches", "team", "collector", "withdrawal-policy", "remittance", "reconciliation", "support"]) {
      expect(byKey.get(key)?.status, key).toBe("done");
    }
    expect(byKey.get("second-admin")?.status).toBe("todo");
    expect(guide.completed).toBe(7);
    expect(guide.total).toBe(8);
  });
});

describe("staff directory export", () => {
  it("requires a fresh admin.export grant", async () => {
    const without = await exportStaffDirectoryCsv({});
    expect(without.success).toBe(false);
    expect(without.error).toMatch(/password|authori|confirm/i);
    expect(await prisma.auditLog.count({ where: { action: "user.staff_directory_exported" } })).toBe(0);
  });

  it("exports the directory with an audit record", async () => {
    const worker = await makeStaff(tenant.id, "worker", "Ama Worker", "ama@export.test");
    const result = await exportStaffDirectoryCsv({
      stepUpToken: await grant(admin.id, "admin.export", "dataset", "staff_directory"),
    });
    expect(result.success).toBe(true);
    expect(result.filename).toMatch(/^staff-directory-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(result.csv).toContain("Full name,Email");
    expect(result.csv).toContain("Ama Worker");
    expect(result.csv).toContain(worker.email);
    expect(result.csv).not.toContain("passwordHash");
    expect(
      await prisma.auditLog.count({ where: { action: "user.staff_directory_exported", userId: admin.id } })
    ).toBe(1);
  });

  it("shows a branch-limited administrator only staff in their branch", async () => {
    const branch = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Only Branch", code: "OB", status: "active" },
    });
    const inside = await makeStaff(tenant.id, "worker", "Inside Worker", "inside@export.test");
    await makeStaff(tenant.id, "worker", "Outside Worker", "outside@export.test");
    await prisma.branchMembership.create({
      data: { tenantId: tenant.id, userId: inside.id, locationId: branch.id, role: "branch_manager" },
    });

    const scoped = await makeStaff(tenant.id, "admin", "Scoped Admin", "scoped@export.test");
    await prisma.branchMembership.create({
      data: { tenantId: tenant.id, userId: scoped.id, locationId: branch.id, role: "branch_manager" },
    });
    await setAdminSession(scoped);

    const result = await exportStaffDirectoryCsv({
      stepUpToken: await grant(scoped.id, "admin.export", "dataset", "staff_directory"),
    });
    expect(result.success).toBe(true);
    expect(result.csv).toContain("Inside Worker");
    expect(result.csv).not.toContain("Outside Worker");
    expect(result.csv).not.toContain("Ama Worker");
  });
});

describe("susu report export audit", () => {
  it("records who exported which report and how many rows", async () => {
    const result = await exportSusuReport({
      report: "contributions",
      dateFrom: "2027-01-01",
      dateTo: "2027-01-31",
    });
    expect(result.success).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "finance.susu_report_exported", userId: admin.id },
    });
    expect(audit.entityId).toBe("contributions");
    expect(String(audit.details)).toContain("rowCount");
  });
});
