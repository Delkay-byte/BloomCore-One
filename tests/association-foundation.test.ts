import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name) ? { name, value: mockCookieStore.get(name)! } : undefined,
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
  createAssociationMember,
  createAssociationSponsorship,
  createAssociationTraining,
  getAssociationDashboard,
  updateAssociationMemberStatus,
  updateAssociationSponsorshipStatus,
} from "@/lib/actions/association.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setSession(user: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Association Admin",
      role: "admin",
      modules: ["momo", "susu"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

async function tenantAdmin() {
  const tenant = await createTestTenant({ momo: true, susu: true });
  const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: true });
  return { tenant, admin };
}

function memberInput(overrides: Record<string, unknown> = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    memberCode: `MEM-${suffix}`,
    businessName: "Ama Mobile Money",
    contactName: "Ama Mensah",
    phone: `+23320${Math.floor(1000000 + Math.random() * 8999999)}`,
    email: "ama@example.test",
    region: "Greater Accra",
    status: "active",
    joinedAt: "2026-11-01",
    ...overrides,
  };
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
});

describe("association foundation", () => {
  it("registers a member and returns it on the tenant dashboard", async () => {
    const { tenant, admin } = await tenantAdmin();
    await setSession(admin);

    const created = await createAssociationMember(memberInput({ memberCode: "MOM-001" }));
    expect(created.success).toBe(true);

    const board = await getAssociationDashboard();
    expect(board.counts.members).toBe(1);
    expect(board.members[0]).toMatchObject({
      memberCode: "MOM-001",
      businessName: "Ama Mobile Money",
      statusLabel: "Active",
    });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: tenant.id, action: "association.member_created" },
    });
    expect(audit.entityType).toBe("associationMember");
  });

  it("rejects a duplicate member code inside one tenant but allows it in another", async () => {
    const first = await tenantAdmin();
    const second = await tenantAdmin();

    await setSession(first.admin);
    expect((await createAssociationMember(memberInput({ memberCode: "DUP-1" }))).success).toBe(true);
    const duplicate = await createAssociationMember(memberInput({ memberCode: "DUP-1" }));
    expect(duplicate.success).toBe(false);
    expect(duplicate.error).toContain("already registered");

    await setSession(second.admin);
    expect((await createAssociationMember(memberInput({ memberCode: "DUP-1" }))).success).toBe(true);
    expect((await getAssociationDashboard()).counts.members).toBe(1);
  });

  it("records a sponsorship without moving money or creating a subscription", async () => {
    const { tenant, admin } = await tenantAdmin();
    await setSession(admin);
    const created = await createAssociationMember(memberInput());
    const memberId = (created.data as { memberId: string }).memberId;

    const sponsorship = await createAssociationSponsorship({
      memberId,
      sponsorName: "MoMAG Support Fund",
      planCode: "GROWTH",
      amount: 450.5,
      status: "active",
      startDate: "2026-11-01",
      endDate: "2027-10-31",
      reference: "SPN-001",
    });
    expect(sponsorship.success).toBe(true);

    const board = await getAssociationDashboard();
    expect(board.counts.activeSponsorships).toBe(1);
    expect(board.counts.activeSponsorshipValue).toBe(450.5);
    expect(board.sponsorships[0]).toMatchObject({
      memberName: "Ama Mobile Money",
      sponsorName: "MoMAG Support Fund",
      amount: 450.5,
      statusLabel: "Active",
    });

    expect(await prisma.momoTransaction.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(await prisma.contribution.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(await prisma.zeliSubscription.count({ where: { tenantId: tenant.id } })).toBe(0);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: tenant.id, action: "association.sponsorship_recorded" },
    });
    const details = JSON.parse(String(audit.details)) as { financialMutation?: boolean };
    expect(details.financialMutation).toBe(false);
  });

  it("refuses a sponsorship for a member in another tenant", async () => {
    const first = await tenantAdmin();
    const second = await tenantAdmin();
    await setSession(first.admin);
    const created = await createAssociationMember(memberInput());
    const memberId = (created.data as { memberId: string }).memberId;

    await setSession(second.admin);
    const result = await createAssociationSponsorship({
      memberId,
      sponsorName: "Other Sponsor",
      amount: 100,
      status: "pledged",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("your association");
  });

  it("validates dates and updates member and sponsorship status", async () => {
    const { admin } = await tenantAdmin();
    await setSession(admin);
    const created = await createAssociationMember(memberInput());
    const memberId = (created.data as { memberId: string }).memberId;

    const badDates = await createAssociationSponsorship({
      memberId,
      sponsorName: "Sponsor",
      amount: 100,
      status: "pledged",
      startDate: "2027-01-01",
      endDate: "2026-01-01",
    });
    expect(badDates.success).toBe(false);
    expect(badDates.error).toContain("end date");

    const sponsorship = await createAssociationSponsorship({
      memberId,
      sponsorName: "Sponsor",
      amount: 100,
      status: "pledged",
      reference: "SPN-STATUS",
    });
    const sponsorshipId = (sponsorship.data as { sponsorshipId: string }).sponsorshipId;
    expect(
      (await updateAssociationSponsorshipStatus({ sponsorshipId, status: "active" })).success
    ).toBe(true);
    expect(
      (await updateAssociationMemberStatus({ memberId, status: "suspended" })).success
    ).toBe(true);

    const board = await getAssociationDashboard();
    expect(board.sponsorships[0].status).toBe("active");
    expect(board.members[0].status).toBe("suspended");
  });

  it("records training and counts certificates expiring within 90 days", async () => {
    const { admin } = await tenantAdmin();
    await setSession(admin);
    const created = await createAssociationMember(memberInput());
    const memberId = (created.data as { memberId: string }).memberId;
    const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const training = await createAssociationTraining({
      memberId,
      title: "MoMo float and fraud awareness",
      provider: "MoMAG Academy",
      status: "completed",
      completedAt: new Date().toISOString().slice(0, 10),
      expiresAt: soon,
      certificateReference: "CERT-001",
    });
    expect(training.success).toBe(true);

    const board = await getAssociationDashboard();
    expect(board.counts.completedTrainings).toBe(1);
    expect(board.counts.expiringTrainings).toBe(1);
    expect(board.trainings[0]).toMatchObject({
      title: "MoMo float and fraud awareness",
      certificateReference: "CERT-001",
    });

    const bad = await createAssociationTraining({
      memberId,
      title: "Bad dates",
      status: "completed",
      completedAt: "2027-01-01",
      expiresAt: "2026-01-01",
    });
    expect(bad.success).toBe(false);
    expect(bad.error).toContain("Expiry");
  });
});

