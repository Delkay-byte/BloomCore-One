/**
 * Association governance: the association entity, zones, roles, consent and
 * exports.
 *
 * The point of these tests is the boundary the audit called out: an association
 * is not a business, and an association role never grants authority over a
 * member business's money.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";

const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as null | Record<string, unknown> },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/tenant", () => ({
  requireTenantAdmin: async () => ctxHolder.current,
  requireTenantAdminSusu: async () => ctxHolder.current,
  requireTenantCustomer: async () => ctxHolder.current,
  getTenantContext: async () => ctxHolder.current,
  getApiTenantContext: async () => ctxHolder.current,
}));

import {
  assignAssociationRole,
  createAssociation,
  createAssociationZone,
  exportAssociationReport,
  getAssociationGovernance,
  recordAssociationConsent,
  revokeAssociationRole,
  withdrawAssociationConsent,
} from "@/lib/actions/association-governance.actions";
import {
  associationAllows,
  consentIsActive,
  type AssociationRole,
} from "@/lib/association-governance";

let tenantId: string;
let adminId: string;
let officerId: string;
let associationId: string;

async function asAdmin(userId = adminId) {
  ctxHolder.current = {
    tenantId,
    tenantName: "Association Tenant",
    tenantCode: "AT",
    userId,
    role: "admin",
    modules: ["admin"],
  };
}

beforeEach(async () => {
  await cleanDatabase();
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `AS-${Math.random().toString(36).slice(2, 8)}`,
      name: "Association Tenant",
      status: "ACTIVE",
      susuEnabled: true,
    },
  });
  tenantId = tenant.id;
  const admin = await prisma.user.create({
    data: {
      tenantId,
      email: `as-admin-${Math.random().toString(36).slice(2, 8)}@test.local`,
      fullName: "Association Admin",
      role: "admin",
      status: "active",
      passwordHash: "x",
    },
  });
  adminId = admin.id;
  const officer = await prisma.user.create({
    data: {
      tenantId,
      email: `as-officer-${Math.random().toString(36).slice(2, 8)}@test.local`,
      fullName: "Zone Officer",
      role: "admin",
      status: "active",
      passwordHash: "x",
    },
  });
  officerId = officer.id;
  await asAdmin();
  const created = await createAssociation({
    code: "MOMAG",
    name: "MoMAG Association",
    region: "Greater Accra",
    charterVersion: "2026.1",
  });
  expect(created.success, created.error).toBe(true);
  associationId = created.data!.associations[0].id;
});

describe("association and zones", () => {
  it("keeps one association alongside the existing register instead of replacing it", async () => {
    const { data } = await getAssociationGovernance();
    expect(data?.associations).toHaveLength(1);
    expect(data?.associations[0]).toMatchObject({
      code: "MOMAG",
      name: "MoMAG Association",
      status: "active",
      charterVersion: "2026.1",
    });
    // The creator can run it immediately.
    expect(data?.myRoles).toContain("association_admin");
  });

  it("nests a zone under a parent and refuses a duplicate code", async () => {
    const region = await createAssociationZone({
      associationId,
      code: "GA",
      name: "Greater Accra",
    });
    expect(region.success, region.error).toBe(true);
    const regionZone = region.data!.zones.find((zone) => zone.code === "GA")!;
    const district = await createAssociationZone({
      associationId,
      code: "AMA",
      name: "Accra Metropolitan",
      parentZoneId: regionZone.id,
    });
    expect(district.success, district.error).toBe(true);
    const child = district.data!.zones.find((zone) => zone.code === "AMA")!;
    expect(child.parentName).toBe("Greater Accra");

    const duplicate = await createAssociationZone({
      associationId,
      code: "GA",
      name: "Duplicate",
    });
    expect(duplicate.success).toBe(false);
    expect(duplicate.error).toMatch(/already used/i);
  });

  it("refuses a parent zone from another association", async () => {
    const other = await createAssociation({ code: "OTHER", name: "Other Association" });
    const otherZone = await createAssociationZone({
      associationId: other.data!.associations.find((row) => row.code === "OTHER")!.id,
      code: "OZ",
      name: "Other Zone",
    });
    const foreignZone = otherZone.data!.zones.find((zone) => zone.code === "OZ")!;
    const result = await createAssociationZone({
      associationId,
      code: "BAD",
      name: "Bad Zone",
      parentZoneId: foreignZone.id,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not in this association/i);
  });
});

describe("roles", () => {
  it("grants a zone officer only what a zone officer may do", async () => {
    const granted = await assignAssociationRole({
      associationId,
      userId: officerId,
      role: "zone_officer",
    });
    expect(granted.success, granted.error).toBe(true);

    await asAdmin(officerId);
    const view = await getAssociationGovernance();
    expect(view.data?.myRoles).toEqual(["zone_officer"]);
    expect(view.data?.canManageMembers).toBe(true);
    expect(view.data?.canManageGovernance).toBe(false);
    expect(view.data?.canManageRoles).toBe(false);
  });

  it("refuses a role that would let a zone officer hand out roles", async () => {
    await assignAssociationRole({ associationId, userId: officerId, role: "zone_officer" });
    await asAdmin(officerId);
    const attempt = await assignAssociationRole({
      associationId,
      userId: adminId,
      role: "association_admin",
    });
    expect(attempt.success).toBe(false);
    expect(attempt.error).toMatch(/does not allow/i);
  });

  it("keeps at least one association administrator", async () => {
    const view = await getAssociationGovernance();
    const mine = view.data!.roles.find((role) => role.userId === adminId)!;
    const result = await revokeAssociationRole({ assignmentId: mine.id });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/at least one association administrator/i);
  });

  it("refuses a person who is not an active user of this business", async () => {
    const other = await prisma.businessTenant.create({
      data: { code: "AS-OTHER", name: "Other", status: "ACTIVE", susuEnabled: true },
    });
    const outsider = await prisma.user.create({
      data: {
        tenantId: other.id,
        email: `as-outsider-${Math.random().toString(36).slice(2, 8)}@test.local`,
        fullName: "Outsider",
        role: "admin",
        status: "active",
        passwordHash: "x",
      },
    });
    const result = await assignAssociationRole({
      associationId,
      userId: outsider.id,
      role: "member_viewer",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not an active user/i);
  });

  it("revokes an officer and leaves the administrator in place", async () => {
    const granted = await assignAssociationRole({
      associationId,
      userId: officerId,
      role: "auditor",
    });
    const row = granted.data!.roles.find((role) => role.userId === officerId)!;
    const revoked = await revokeAssociationRole({ assignmentId: row.id });
    expect(revoked.success, revoked.error).toBe(true);
    expect(revoked.data!.roles.find((role) => role.id === row.id)?.revokedAt).toBeTruthy();
  });
});

describe("consent", () => {
  it("counts a live consent and stops counting one that expired", async () => {
    const live = await recordAssociationConsent({
      associationId,
      subjectType: "data_sharing",
      documentRef: "DSA-2026-01",
    });
    expect(live.success, live.error).toBe(true);
    expect(live.data!.consents.filter((consent) => consent.active)).toHaveLength(1);

    const expiring = new Date(Date.now() + 60_000).toISOString();
    await recordAssociationConsent({
      associationId,
      subjectType: "membership_agreement",
      expiresAt: expiring,
    });
    const stored = await prisma.associationConsentRecord.findFirstOrThrow({
      where: { subjectType: "membership_agreement" },
    });
    await prisma.associationConsentRecord.update({
      where: { id: stored.id },
      data: { expiresAt: new Date("2020-01-01T00:00:00Z") },
    });
    const after = await getAssociationGovernance();
    const lapsed = after.data!.consents.find(
      (consent) => consent.subjectType === "membership_agreement"
    )!;
    expect(lapsed.active).toBe(false);
    expect(after.data!.lapsedConsents).toBeGreaterThanOrEqual(1);
  });

  it("refuses an expiry in the past and a short withdrawal reason", async () => {
    const past = await recordAssociationConsent({
      associationId,
      subjectType: "access_review",
      expiresAt: "2020-01-01",
    });
    expect(past.success).toBe(false);
    expect(past.error).toMatch(/future/i);

    const created = await recordAssociationConsent({
      associationId,
      subjectType: "access_review",
    });
    const consent = created.data!.consents[0];
    const short = await withdrawAssociationConsent({ consentId: consent.id, note: "no" });
    expect(short.success).toBe(false);

    const withdrawn = await withdrawAssociationConsent({
      consentId: consent.id,
      note: "The member business withdrew its agreement in writing.",
    });
    expect(withdrawn.success, withdrawn.error).toBe(true);
    const after = withdrawn.data!.consents.find((row) => row.id === consent.id)!;
    expect(after.withdrawnAt).not.toBeNull();
    expect(after.active).toBe(false);
  });

  it("treats consent as active only while granted, unexpired and not withdrawn", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    expect(
      consentIsActive({ grantedAt: new Date("2026-01-01T00:00:00Z"), expiresAt: null, withdrawnAt: null }, now)
    ).toBe(true);
    expect(
      consentIsActive(
        { grantedAt: new Date("2026-01-01T00:00:00Z"), expiresAt: new Date("2026-05-01T00:00:00Z"), withdrawnAt: null },
        now
      )
    ).toBe(false);
    expect(
      consentIsActive(
        { grantedAt: new Date("2026-01-01T00:00:00Z"), expiresAt: null, withdrawnAt: new Date("2026-05-01T00:00:00Z") },
        now
      )
    ).toBe(false);
  });
});

describe("capabilities", () => {
  it("separates reading from administering", () => {
    expect(associationAllows(["auditor"], "view")).toBe(true);
    expect(associationAllows(["auditor"], "manageMembers")).toBe(false);
    expect(associationAllows(["member_viewer"], "manageGovernance")).toBe(false);
    expect(associationAllows(["association_admin"], "manageRoles")).toBe(true);
    const roles: AssociationRole[] = ["zone_officer", "auditor"];
    expect(associationAllows(roles, "manageGovernance")).toBe(false);
  });
});

describe("exports", () => {
  it("exports this business's members as CSV and nothing else", async () => {
    await prisma.associationMember.createMany({
      data: [
        {
          tenantId,
          associationId,
          memberCode: "M-1",
          businessName: "Alpha Susu",
          contactName: "Ama",
          phone: "+233200000001",
          status: "active",
          createdById: adminId,
        },
        {
          tenantId,
          associationId,
          memberCode: "M-2",
          businessName: "Beta Susu",
          contactName: "Kofi",
          phone: "+233200000002",
          status: "invited",
          createdById: adminId,
        },
      ],
    });
    const other = await prisma.businessTenant.create({
      data: { code: "AS-EXP-OTHER", name: "Other", status: "ACTIVE", susuEnabled: true },
    });
    await prisma.associationMember.create({
      data: {
        tenantId: other.id,
        memberCode: "X-1",
        businessName: "Hidden Susu",
        contactName: "Nobody",
        status: "active",
        createdById: adminId,
      },
    });

    const report = await exportAssociationReport("members");
    expect(report.success, report.error).toBe(true);
    expect(report.csv).toContain("Alpha Susu");
    expect(report.csv).toContain("Beta Susu");
    expect(report.csv).not.toContain("Hidden Susu");
    expect(report.filename).toMatch(/^association-members-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("exports consent with its live state", async () => {
    await recordAssociationConsent({
      associationId,
      subjectType: "data_sharing",
      documentRef: "DSA-9",
    });
    const report = await exportAssociationReport("consent");
    expect(report.success, report.error).toBe(true);
    expect(report.csv).toContain("Data-sharing consent");
    expect(report.csv).toContain("DSA-9");
    expect(report.csv).toContain("yes");
  });

  it("refuses an unknown report", async () => {
    const report = await exportAssociationReport("salaries" as never);
    expect(report.success).toBe(false);
  });
});

describe("audit", () => {
  it("records every governance change as non-financial", async () => {
    await createAssociationZone({ associationId, code: "Z1", name: "Zone One" });
    await assignAssociationRole({
      associationId,
      userId: officerId,
      role: "member_viewer",
    });
    await recordAssociationConsent({ associationId, subjectType: "data_sharing" });

    const rows = await prisma.auditLog.findMany({
      where: {
        tenantId,
        action: { startsWith: "association." },
      },
    });
    expect(rows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "association.created",
        "association.zone_created",
        "association.role_granted",
        "association.consent_recorded",
      ])
    );
    for (const row of rows) {
      expect(JSON.parse(String(row.details)).financialMutation).toBe(false);
    }
  });
});
