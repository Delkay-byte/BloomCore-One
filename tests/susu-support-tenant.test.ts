/**
 * Phase 8 — tenant support requests.
 *
 * These call the real server actions against an isolated SQLite database. They
 * assert the promises that matter to a business: another tenant can never see a
 * request, an internal note is never returned to the tenant, a closed request
 * cannot be silently replied to, and the export carries metadata rather than
 * conversation bodies.
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

import {
  createSupportRequest,
  exportTenantSupportRequests,
  getSupportRequestDetail,
  listSupportRequests,
  reopenSupportRequest,
  replyToSupportRequest,
} from "@/lib/actions/susu-support.actions";

const SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function signToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(SECRET);
}

/**
 * The support surface authenticates with the Susu tab session, so an
 * administrator and a collector arrive through the same cookie. The database
 * row, not the token, decides the role.
 */
async function setAdminSession(user: { id: string; email: string; fullName?: string }) {
  await setStaffSession({
    id: user.id,
    email: user.email,
    fullName: user.fullName ?? "Administrator",
    role: "admin",
  });
}

async function setStaffSession(user: { id: string; email: string; fullName: string; role: string }) {
  mockCookieStore.set(
    "bik-collector-session",
    await signToken({
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      modules: ["susu"],
      tokenVersion: 0,
    })
  );
  mockCookieStore.delete("bik-admin-session");
}

async function makeBranch(tenantId: string, name: string, code: string) {
  return prisma.location.create({
    data: { tenantId, name, code, status: "active" },
  });
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

const OPEN_INPUT = {
  category: "contribution",
  priority: "normal",
  subject: "A contribution is missing from the ledger",
  description: "Yesterday afternoon a customer paid cash and the receipt exists but the ledger shows nothing.",
};

let tenantA: { id: string; name: string };
let adminA: { id: string; email: string };
let workerA: { id: string; email: string; fullName: string; role: string };
let branchA1: { id: string; name: string };
let branchA2: { id: string; name: string };
let tenantB: { id: string };
let adminB: { id: string; email: string };

beforeEach(async () => {
  mockCookieStore.clear();
  await cleanDatabase();

  tenantA = await createTestTenant({ momo: false, susu: true, name: "Alpha Susu" });
  adminA = await createTestAdmin({ tenantId: tenantA.id, momo: false, susu: true });
  branchA1 = await makeBranch(tenantA.id, "Accra Central", "A1");
  branchA2 = await makeBranch(tenantA.id, "Kumasi", "A2");
  workerA = await makeStaff(tenantA.id, "worker", "Office Worker", "worker@alpha.test");
  tenantB = await createTestTenant({ momo: false, susu: true, name: "Beta Susu" });
  adminB = await createTestAdmin({ tenantId: tenantB.id, momo: false, susu: true });
});

describe("tenant support requests", () => {
  it("creates a request with a generated reference and records the event", async () => {
    await setAdminSession(adminA);
    const result = await createSupportRequest({ ...OPEN_INPUT, branchId: branchA1.id });
    expect(result.success).toBe(true);
    expect(result.reference).toMatch(/^SUP-\d{4}-[A-Z0-9]{6}$/);

    const request = await prisma.supportRequest.findUniqueOrThrow({ where: { id: result.requestId! } });
    expect(request.tenantId).toBe(tenantA.id);
    expect(request.branchId).toBe(branchA1.id);
    expect(request.status).toBe("open");
    expect(request.reopenedCount).toBe(0);
    expect(await prisma.supportEvent.count({ where: { requestId: request.id, type: "created" } })).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { action: "support.request_created", entityId: request.id } })
    ).toBe(1);
  });

  it("rejects credential-shaped content", async () => {
    await setAdminSession(adminA);
    const result = await createSupportRequest({
      ...OPEN_INPUT,
      description: "The customer says password: Hunter2! and the ledger is wrong.",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/password/i);
  });

  it("refuses a branch the caller cannot read", async () => {
    await setAdminSession(adminA);
    const otherTenant = await createTestTenant({ momo: false, susu: true, name: "Gamma" });
    const foreignBranch = await makeBranch(otherTenant.id, "Foreign", "F1");
    const result = await createSupportRequest({ ...OPEN_INPUT, branchId: foreignBranch.id });
    expect(result.success).toBe(false);
  });

  it("shows a request to its own tenant and never to another tenant", async () => {
    await setAdminSession(adminA);
    const created = await createSupportRequest(OPEN_INPUT);
    expect(created.success).toBe(true);

    await setAdminSession(adminB);
    expect(await getSupportRequestDetail(created.requestId!)).toBeNull();
    expect(await listSupportRequests()).toHaveLength(0);

    await setAdminSession(adminA);
    const detail = await getSupportRequestDetail(created.requestId!);
    expect(detail?.reference).toBe(created.reference);
  });

  it("limits a non-administrator to their own requests", async () => {
    await setAdminSession(adminA);
    await createSupportRequest(OPEN_INPUT);

    await setStaffSession(workerA);
    expect(await listSupportRequests()).toHaveLength(0);
    const own = await createSupportRequest(OPEN_INPUT);
    expect(own.success).toBe(true);
    expect(await listSupportRequests()).toHaveLength(1);

    await setAdminSession(adminA);
    expect(await listSupportRequests()).toHaveLength(2);
  });

  it("limits a branch-scoped administrator to their branch and their own requests", async () => {
    await setAdminSession(adminA);
    const inBranchOne = await createSupportRequest({ ...OPEN_INPUT, branchId: branchA1.id });
    const inBranchTwo = await createSupportRequest({ ...OPEN_INPUT, branchId: branchA2.id });
    const withoutBranch = await createSupportRequest(OPEN_INPUT);

    const scopedAdmin = await makeStaff(tenantA.id, "admin", "Branch Admin", "branch-admin@alpha.test");
    await prisma.branchMembership.create({
      data: { tenantId: tenantA.id, userId: scopedAdmin.id, locationId: branchA1.id, role: "branch_manager" },
    });
    await setAdminSession(scopedAdmin);

    const rows = await listSupportRequests();
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(inBranchOne.requestId);
    expect(ids).not.toContain(inBranchTwo.requestId);
    expect(ids).not.toContain(withoutBranch.requestId);
    expect(await getSupportRequestDetail(inBranchTwo.requestId!)).toBeNull();
  });

  it("never returns an internal note to the tenant", async () => {
    await setAdminSession(adminA);
    const created = await createSupportRequest(OPEN_INPUT);
    await prisma.supportMessage.create({
      data: {
        requestId: created.requestId!,
        authorType: "platform",
        visibility: "internal",
        body: "Internal: the collector's device clock is wrong; do not tell the tenant yet.",
      },
    });
    await prisma.supportMessage.create({
      data: {
        requestId: created.requestId!,
        authorType: "platform",
        visibility: "tenant",
        body: "We are checking the ledger now.",
      },
    });

    const detail = await getSupportRequestDetail(created.requestId!);
    expect(detail!.messages).toHaveLength(1);
    expect(detail!.messages[0].body).toBe("We are checking the ledger now.");
    expect(JSON.stringify(detail)).not.toContain("device clock");
  });

  it("replies move the last activity and refuse a closed request", async () => {
    await setAdminSession(adminA);
    const created = await createSupportRequest(OPEN_INPUT);
    const reply = await replyToSupportRequest({ requestId: created.requestId!, body: "Any update on this?" });
    expect(reply.success).toBe(true);
    expect(await prisma.supportMessage.count({ where: { requestId: created.requestId, visibility: "tenant" } })).toBe(1);

    await prisma.supportRequest.update({ where: { id: created.requestId! }, data: { status: "closed" } });
    const blocked = await replyToSupportRequest({ requestId: created.requestId!, body: "Hello?" });
    expect(blocked.success).toBe(false);
  });

  it("lets an administrator reopen a resolved request with a reason and counts it", async () => {
    await setAdminSession(adminA);
    const created = await createSupportRequest(OPEN_INPUT);
    await prisma.supportRequest.update({
      where: { id: created.requestId! },
      data: { status: "resolved", resolutionNote: "Reconciled.", resolvedAt: new Date() },
    });

    const reopened = await reopenSupportRequest({ requestId: created.requestId!, reason: "The figure changed again." });
    expect(reopened.success).toBe(true);
    const row = await prisma.supportRequest.findUniqueOrThrow({ where: { id: created.requestId! } });
    expect(row.status).toBe("open");
    expect(row.reopenedCount).toBe(1);
    expect(row.resolvedAt).toBeNull();
    expect(row.resolutionNote).toBeNull();
    expect(
      await prisma.auditLog.count({ where: { action: "support.request_reopened", entityId: row.id } })
    ).toBe(1);
  });

  it("refuses a reopen from a non-administrator", async () => {
    await setAdminSession(adminA);
    const created = await createSupportRequest(OPEN_INPUT);
    await prisma.supportRequest.update({ where: { id: created.requestId! }, data: { status: "resolved" } });

    await setStaffSession(workerA);
    const reopened = await reopenSupportRequest({ requestId: created.requestId!, reason: "Please reopen this." });
    expect(reopened.success).toBe(false);
  });

  it("exports metadata without conversation bodies and records the export", async () => {
    await setAdminSession(adminA);
    const created = await createSupportRequest(OPEN_INPUT);
    await prisma.supportMessage.create({
      data: {
        requestId: created.requestId!,
        authorType: "platform",
        visibility: "internal",
        body: "Secret internal reasoning",
      },
    });

    const result = await exportTenantSupportRequests();
    expect(result.success).toBe(true);
    expect(result.filename).toMatch(/^support-requests-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(result.rowCount).toBe(1);
    expect(result.csv!.split("\r\n")[0]).toContain("Reference");
    expect(result.csv).toContain(created.reference!);
    expect(result.csv).not.toContain("Secret internal reasoning");
    expect(await prisma.auditLog.count({ where: { action: "support.exported" } })).toBe(1);
  });

  it("counts open, resolved and closed requests for the tenant only", async () => {
    await setAdminSession(adminA);
    await createSupportRequest(OPEN_INPUT);
    await createSupportRequest({ ...OPEN_INPUT, subject: "Second request about a remittance" });

    await setAdminSession(adminB);
    await createSupportRequest(OPEN_INPUT);

    await setAdminSession(adminA);
    const { getSupportCounts } = await import("@/lib/actions/susu-support.actions");
    const counts = await getSupportCounts();
    expect(counts.open).toBe(2);
    expect(counts.resolved).toBe(0);
    expect(counts.closed).toBe(0);
  });
});
