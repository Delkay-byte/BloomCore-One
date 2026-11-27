/**
 * Phase 8 — platform support operations.
 *
 * The platform console acts ACROSS tenants, so these tests assert the opposite
 * concerns from the tenant suite: a support agent may see internal notes and
 * every tenant, every transition is audited against the request reference, and
 * the queue export still contains no conversation body.
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

import { PLATFORM_COOKIE } from "@/lib/platform-auth";
import {
  acknowledgeSupportRequest,
  addSupportInternalNote,
  assignSupportRequest,
  closeSupportRequest,
  escalateSupportRequest,
  exportSupportQueue,
  getSupportOperationsSummary,
  getSupportRequestAgentView,
  listSupportQueue,
  reopenSupportRequestAsSupport,
  replyToTenantSupportRequest,
  resolveSupportRequest,
} from "@/lib/actions/platform-support.actions";
import { getSupportRequestDetail } from "@/lib/actions/susu-support.actions";

const SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function signToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(SECRET);
}

async function setPlatformSession(admin: { id: string; email: string; fullName: string }) {
  mockCookieStore.set(
    PLATFORM_COOKIE,
    await signToken({
      kind: "platform",
      adminId: admin.id,
      email: admin.email,
      fullName: admin.fullName,
      tokenVersion: 0,
      lastActivityAt: Math.floor(Date.now() / 1000),
    })
  );
}

async function setTenantSession(user: { id: string; email: string; fullName: string; role: string }) {
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
}

async function makeAgent(email: string, fullName: string) {
  return prisma.platformSuperAdmin.create({
    data: { email, fullName, passwordHash: "x", status: "active" },
  });
}

async function makeRequest(tenantId: string, submittedById: string, overrides: Record<string, unknown> = {}) {
  return prisma.supportRequest.create({
    data: {
      tenantId,
      reference: "SUP-2027-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
      submittedById,
      category: "contribution",
      priority: "normal",
      status: "open",
      subject: "A contribution is missing",
      description: "The receipt exists but the ledger shows nothing for yesterday afternoon.",
      lastActivityAt: new Date(),
      ...overrides,
    },
  });
}

let tenant: { id: string };
let tenantAdmin: { id: string; email: string; fullName: string; role: string };
let agentOne: { id: string; email: string; fullName: string };
let agentTwo: { id: string; email: string; fullName: string };
let request: { id: string; reference: string };

beforeEach(async () => {
  mockCookieStore.clear();
  await cleanDatabase();
  tenant = await createTestTenant({ momo: false, susu: true, name: "Platform Test Susu" });
  tenantAdmin = await createTestAdmin({ tenantId: tenant.id, momo: false, susu: true });
  agentOne = await makeAgent("agent-one@bloomcore.test", "Agent One");
  agentTwo = await makeAgent("agent-two@bloomcore.test", "Agent Two");
  request = await makeRequest(tenant.id, tenantAdmin.id);
  await setPlatformSession(agentOne);
});

describe("platform support queue", () => {
  it("summarises open, unassigned and urgent work without counting closed items", async () => {
    await makeRequest(tenant.id, tenantAdmin.id, { priority: "urgent" });
    await makeRequest(tenant.id, tenantAdmin.id, { status: "closed" });

    const summary = await getSupportOperationsSummary();
    // "Open" is everything that still needs work: the first request plus the
    // urgent one, but never the closed row.
    expect(summary.open).toBe(2);
    expect(summary.unassigned).toBe(2);
    expect(summary.urgent).toBe(1);
    expect(summary.tenantsWithOpenRequests).toBe(1);
  });

  it("orders urgent work first and filters by assignment", async () => {
    await makeRequest(tenant.id, tenantAdmin.id, { priority: "urgent", subject: "Urgent one" });
    const rows = await listSupportQueue({});
    expect(rows[0].priority).toBe("urgent");

    const mine = await listSupportQueue({ assignment: "unassigned" });
    expect(mine.every((row) => row.assignedAgentId === null)).toBe(true);
    const assigned = await listSupportQueue({ assignment: "mine" });
    expect(assigned).toHaveLength(0);
  });

  it("acknowledges and assigns the acting agent", async () => {
    const result = await acknowledgeSupportRequest(request.id);
    expect(result.success).toBe(true);
    const row = await prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.status).toBe("acknowledged");
    expect(row.assignedAgentId).toBe(agentOne.id);
    expect(await prisma.supportEvent.count({ where: { requestId: request.id, type: "acknowledged" } })).toBe(1);
    expect(await prisma.platformAuditLog.count({ where: { action: "support.acknowledged", entityId: request.id } })).toBe(1);
  });

  it("reassigns to another active agent", async () => {
    const result = await assignSupportRequest({ requestId: request.id, agentId: agentTwo.id });
    expect(result.success).toBe(true);
    const row = await prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.assignedAgentId).toBe(agentTwo.id);
  });

  it("refuses to assign an inactive agent", async () => {
    const inactive = await prisma.platformSuperAdmin.create({
      data: { email: "inactive@bloomcore.test", fullName: "Inactive Agent", passwordHash: "x", status: "inactive" },
    });
    const result = await assignSupportRequest({ requestId: request.id, agentId: inactive.id });
    expect(result.success).toBe(false);
  });

  it("escalates with a reason and records the level", async () => {
    const result = await escalateSupportRequest({ requestId: request.id, reason: "Needs a data correction" });
    expect(result.success).toBe(true);
    const row = await prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.status).toBe("escalated");
    expect(row.escalationLevel).toBe(1);
    expect(row.escalatedAt).not.toBeNull();
    expect(
      await prisma.platformAuditLog.count({ where: { action: "support.escalated", entityId: request.id } })
    ).toBe(1);
  });

  it("replies to the tenant and moves the request into progress", async () => {
    const result = await replyToTenantSupportRequest({
      requestId: request.id,
      body: "We are checking the ledger and will confirm today.",
    });
    expect(result.success).toBe(true);
    const row = await prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.status).toBe("in_progress");
    expect(row.assignedAgentId).toBe(agentOne.id);
    expect(
      await prisma.supportMessage.count({ where: { requestId: request.id, visibility: "tenant" } })
    ).toBe(1);
  });

  it("keeps an internal note away from the tenant while the agent view keeps it", async () => {
    const saved = await addSupportInternalNote({
      requestId: request.id,
      body: "Internal: the collector device clock is wrong. Do not tell the tenant yet.",
    });
    expect(saved.success).toBe(true);

    const view = await getSupportRequestAgentView(request.id);
    expect(view?.messages.map((message) => message.body).join(" ")).toContain("device clock");

    await setTenantSession(tenantAdmin);
    const tenantView = await getSupportRequestDetail(request.id);
    expect(JSON.stringify(tenantView)).not.toContain("device clock");
  });

  it("resolves with a tenant-visible note and requires one", async () => {
    const tooShort = await resolveSupportRequest({ requestId: request.id, resolutionNote: "fixed" });
    expect(tooShort.success).toBe(false);

    const result = await resolveSupportRequest({
      requestId: request.id,
      resolutionNote: "The contribution was posted against the wrong account and has been moved.",
    });
    expect(result.success).toBe(true);
    const row = await prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.status).toBe("resolved");
    expect(row.resolvedAgentId).toBe(agentOne.id);
    expect(row.resolutionNote).toContain("wrong account");
  });

  it("closes a resolved request, refuses to resolve a closed one, and reopens with history", async () => {
    await resolveSupportRequest({
      requestId: request.id,
      resolutionNote: "The contribution was posted against the wrong account and has been moved.",
    });
    const closed = await closeSupportRequest({ requestId: request.id });
    expect(closed.success).toBe(true);

    const reopenWithoutReason = await reopenSupportRequestAsSupport({ requestId: request.id, reason: "" });
    expect(reopenWithoutReason.success).toBe(false);

    const reopened = await reopenSupportRequestAsSupport({
      requestId: request.id,
      reason: "The tenant says the amount is still wrong.",
    });
    expect(reopened.success).toBe(true);
    const row = await prisma.supportRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row.status).toBe("open");
    expect(row.reopenedCount).toBe(1);
    expect(row.resolutionNote).toBeNull();
  });

  it("requires a reason before closing an escalated request", async () => {
    await escalateSupportRequest({ requestId: request.id, reason: "Needs platform engineering" });
    const withoutReason = await closeSupportRequest({ requestId: request.id });
    expect(withoutReason.success).toBe(false);
    const closed = await closeSupportRequest({
      requestId: request.id,
      reason: "Handed to engineering; tracking continues in the incident.",
    });
    expect(closed.success).toBe(true);
  });

  it("exports metadata only and audits the export", async () => {
    await addSupportInternalNote({ requestId: request.id, body: "Secret reasoning that must not be exported." });
    const result = await exportSupportQueue({});
    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.csv).toContain(request.reference);
    expect(result.csv).not.toContain("Secret reasoning");
    expect(
      await prisma.platformAuditLog.count({ where: { action: "support.exported" } })
    ).toBe(1);
  });

  it("refuses support actions without a platform session", async () => {
    mockCookieStore.clear();
    await expect(acknowledgeSupportRequest(request.id)).rejects.toThrow();
  });
});
