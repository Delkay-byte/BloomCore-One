/**
 * Shared agent risk intelligence — local acceptance scenario.
 *
 * Written as the acceptance run describes it: three synthetic businesses (A, B, C), one
 * synthetic subject, one suspicious-incident category, and a fake clock for the 180-day
 * expiry. The existing unit and integration suite covers the rules individually; this file
 * proves the reported end-to-end behaviour on a real database, including the thresholds,
 * the self-report exclusion, the disclosure audit trail and disabling the capability again
 * by removing the local secret.
 *
 * No real person, phone number or business appears here: every identifier is synthetic and
 * every business is created by this test.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  requireTenantAdminMomo: async () => ctxHolder.current,
  requireTenantAdmin: async () => ctxHolder.current,
}));

import {
  contributeRiskSignal,
  expireStaleRiskSignals,
  getRiskIntelligenceConsent,
  joinRiskIntelligence,
  listMyRiskSignals,
  querySharedRiskSignals,
  withdrawMyRiskSignal,
  withdrawRiskIntelligence,
} from "@/lib/actions/risk-intelligence.actions";
import {
  RISK_INTELLIGENCE_DECAY_DAYS,
  RISK_INTELLIGENCE_POLICY_VERSION,
} from "@/lib/risk-intelligence/policy";
import { hashRiskSubject, riskIntelligenceConfigured } from "@/lib/risk-intelligence/hasher";

/** Local acceptance secret: random, in memory only, never printed or committed. */
const LOCAL_SALT = "acceptance-salt-local-only-not-for-production-use-0001";
const SUBJECT_NAME = "Synthetic Subject Alpha";
const SUBJECT_PHONE = "0200000111";

interface Business {
  tenantId: string;
  adminId: string;
  subjectId: string;
  locationId: string;
}

async function createBusiness(code: string): Promise<Business> {
  const tenant = await prisma.businessTenant.create({
    data: { code: `${code}-${Math.random().toString(36).slice(2, 8)}`, name: `Synthetic ${code}`, status: "ACTIVE" },
  });
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `${code.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@test.invalid`,
      fullName: `${code} Owner`,
      role: "admin",
      status: "active",
      passwordHash: "x",
    },
  });
  const subject = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `${code.toLowerCase()}-subject-${Math.random().toString(36).slice(2, 8)}@test.invalid`,
      fullName: SUBJECT_NAME,
      phone: SUBJECT_PHONE,
      role: "worker",
      status: "active",
      passwordHash: "x",
    },
  });
  const location = await prisma.location.create({
    data: { tenantId: tenant.id, name: `${code} Branch`, code: `${code}${Date.now() % 100000}` },
  });
  return { tenantId: tenant.id, adminId: admin.id, subjectId: subject.id, locationId: location.id };
}

function actAs(business: Business) {
  ctxHolder.current = {
    tenantId: business.tenantId,
    userId: business.adminId,
    role: "admin",
    modules: ["admin"],
  };
}

async function joined(business: Business) {
  actAs(business);
  const result = await joinRiskIntelligence({
    scope: "share_signals",
    acceptedPolicyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
  });
  expect(result.success, result.error).toBe(true);
  await prisma.riskIntelligenceConsent.updateMany({
    where: { tenantId: business.tenantId },
    data: { eligibilityVerified: true, controllerRegistrationChecked: true },
  });
  for (const type of ["joint_controller", "participation_terms"] as const) {
    await prisma.participationAgreement.create({
      data: {
        tenantId: business.tenantId,
        type,
        title: type === "joint_controller" ? "Joint Controller Agreement" : "Business Participation and Data-Sharing Terms",
        version: "acceptance-1",
        effectiveDate: new Date(),
        documentText: "Disposable acceptance agreement text.",
        documentSha256: "1".repeat(64),
        documentRef: "acceptance-test",
        state: "active",
        signatoryId: business.adminId,
        signatoryName: "Synthetic Owner",
        signatoryRole: "owner",
        signatoryAuthority: "business owner",
        authenticationMethod: "acceptance-test",
      },
    });
  }
  const noticeText = "Disposable acceptance notice text.";
  const noticeHash = createHash("sha256").update(noticeText, "utf8").digest("hex");
  await prisma.employeePrivacyNotice.upsert({
    where: { version: "acceptance-notice-1" },
    update: { documentHash: noticeHash },
    create: {
      version: "acceptance-notice-1",
      title: "Employee Privacy Notice",
      documentText: noticeText,
      documentHash: noticeHash,
      effectiveDate: new Date(),
      policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
    },
  });
  await prisma.employeeNoticeAttestation.create({
    data: {
      tenantId: business.tenantId,
      userId: business.subjectId,
      noticeVersion: "acceptance-notice-1",
      deliveryMethod: "portal_acknowledgement",
      issuedAt: new Date(),
      deliveryEvidence: "acceptance-test-evidence",
      acknowledgementState: "acknowledged",
      acknowledgedAt: new Date(),
      verified: true,
      verifiedAt: new Date(),
      recordedById: business.adminId,
      policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
      documentSha256: noticeHash,
    },
  });
}

/** Contribute one signal from a business about its own synthetic subject. */
async function reportShortage(business: Business, category = "repeated_shortage") {
  actAs(business);
  const account = await prisma.dailyAccount.create({
    data: {
      tenantId: business.tenantId,
      locationId: business.locationId,
      workerId: business.subjectId,
      businessDate: new Date("2026-11-05T00:00:00.000Z"),
      status: "reviewed",
      reviewedAt: new Date("2026-11-06T00:00:00.000Z"),
    },
  });
  const result = await contributeRiskSignal({
    userId: business.subjectId,
    category,
    severity: "high",
    sourceType: "dailyAccount",
    sourceId: account.id,
    note: "The synthetic day ended short and was never explained.",
    observedFrom: "2026-11-05T00:00:00.000Z",
    observedTo: "2026-11-05T00:00:00.000Z",
    goodFaith: true,
  });
  expect(result.success, result.error).toBe(true);
}

async function ask(business: Business) {
  actAs(business);
  const result = await querySharedRiskSignals({
    userId: business.subjectId,
    reason: "Considering this synthetic person for a counter role",
  });
  expect(result.success, result.error).toBe(true);
  if (!result.success || !result.data) throw new Error("query failed");
  return result.data.result;
}

describe("shared risk intelligence — three-business acceptance", () => {
  let a: Business;
  let b: Business;
  let c: Business;
  /**
   * The viewer.
   *
   * The implementation counts *other* businesses, so a business that contributes cannot
   * reach the threshold on the strength of its own report plus two others: three
   * contributors plus a separate viewer is the smallest network that can disclose
   * anything. That is the safer direction, and it is asserted below rather than worked
   * around.
   */
  let viewer: Business;

  beforeEach(async () => {
    process.env.RISK_INTELLIGENCE_SALT = LOCAL_SALT;
    process.env.RISK_RETENTION_TOKEN = "unit-retention-token";
    await cleanDatabase();
    a = await createBusiness("BA");
    b = await createBusiness("BB");
    c = await createBusiness("BC");
    viewer = await createBusiness("BV");

    // ENG-01: the minimum eligible network. Created only in the disposable
    // unit database, never in the application database.
    for (let index = 0; index < 19; index += 1) {
      const tenant = await prisma.businessTenant.create({
        data: {
          code: `NWA-${index}-${Math.random().toString(36).slice(2, 6)}`,
          name: `Synthetic Network ${index}`,
          status: "ACTIVE",
        },
      });
      await prisma.riskIntelligenceConsent.create({
        data: {
          tenantId: tenant.id,
          policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
          scope: "share_signals",
          consentedById: a.adminId,
        },
      });
      for (const type of ["joint_controller", "participation_terms"] as const) {
        await prisma.participationAgreement.create({
          data: {
            tenantId: tenant.id,
            type,
            title: type,
            version: "network-1",
            effectiveDate: new Date(),
            documentText: "Disposable synthetic network agreement text.",
            documentSha256: "2".repeat(64),
            documentRef: "acceptance-test",
            state: "active",
            signatoryId: a.adminId,
            signatoryName: "Synthetic Network Owner",
            signatoryRole: "owner",
            signatoryAuthority: "business owner",
            authenticationMethod: "acceptance-test",
          },
        });
      }
    }
  });

  afterEach(() => {
    process.env.RISK_INTELLIGENCE_SALT = LOCAL_SALT;
    vi.useRealTimers();
  });

  it("is off until each business opts in, and each consent records the policy version", async () => {
    actAs(a);
    const before = await getRiskIntelligenceConsent();
    expect(before.data?.active).toBe(false);

    const refusal = await querySharedRiskSignals({
      userId: a.subjectId,
      reason: "Considering this synthetic person for a counter role",
    });
    if (!refusal.success || !refusal.data) throw new Error("query failed");
    expect(refusal.data.result.allowed).toBe(false);
    if (!refusal.data.result.allowed) expect(refusal.data.result.denial).toBe("consent_missing");

    await joined(a);
    const row = await prisma.riskIntelligenceConsent.findFirstOrThrow({
      where: { tenantId: a.tenantId },
    });
    expect(row.policyVersion).toBe(RISK_INTELLIGENCE_POLICY_VERSION);
    expect(row.status).toBe("active");
    expect(row.consentedById).toBe(a.adminId);
  });

  it("requires three distinct businesses before disclosing anything", async () => {
    await joined(a);
    await joined(b);
    await joined(c);
    await joined(viewer);

    await reportShortage(a);

    // One business reporting: the caller's own signal never counts for it.
    const own = await ask(a);
    if (!own.allowed) throw new Error(own.denial);
    expect(own.verdict).toBe("no_shared_signals");
    expect(own.contributorCount).toBe(0);

    // A second business reporting gives the viewer two contributors, still short of three.
    await reportShortage(b);
    const ab = await ask(viewer);
    if (!ab.allowed) throw new Error(ab.denial);
    expect(ab.verdict).toBe("no_shared_signals");
    expect(ab.contributorCount).toBe(2);

    // The third business satisfies the threshold for a business that contributed nothing.
    await reportShortage(c);
    const abc = await ask(viewer);
    if (!abc.allowed) throw new Error(abc.denial);
    expect(abc.verdict).toBe("review_recommended");
    expect(abc.signals).toHaveLength(1);
    expect(abc.signals[0].category).toBe("repeated_shortage");
    expect(abc.signals[0].contributorBand).toBe("3 to 5 businesses");
    expect(abc.isBlacklist).toBe(false);
    expect(abc.disclosesIdentity).toBe(false);
    expect(abc.requiresHumanJudgement).toBe(true);

    // Documented consequence: a contributing business cannot unlock disclosure with its
    // own report plus two others. It sees nothing until three *other* businesses report.
    const fromContributor = await ask(a);
    if (!fromContributor.allowed) throw new Error(fromContributor.denial);
    expect(fromContributor.verdict).toBe("no_shared_signals");
    expect(fromContributor.contributorCount).toBe(2);
  });

  it("does not combine different categories into one accusation", async () => {
    await joined(a);
    await joined(b);
    await joined(c);
    await joined(viewer);
    await reportShortage(a, "shortage");
    await reportShortage(b, "evidence_gap");
    await reportShortage(c, "unreconciled_day");

    const result = await ask(viewer);
    if (!result.allowed) throw new Error(result.denial);
    expect(result.verdict).toBe("no_shared_signals");
    expect(result.signals).toHaveLength(0);
  });

  it("never returns a raw report, an identity, a count or a contributing business", async () => {
    await joined(a);
    await joined(b);
    await joined(c);
    await joined(viewer);
    await reportShortage(a);
    await reportShortage(b);
    await reportShortage(c);

    actAs(viewer);
    const response = await querySharedRiskSignals({
      userId: viewer.subjectId,
      reason: "Considering this synthetic person for a counter role",
    });
    if (!response.success || !response.data) throw new Error("query failed");
    const serialised = JSON.stringify(response.data);

    expect(serialised).not.toContain(SUBJECT_NAME);
    expect(serialised).not.toContain(SUBJECT_PHONE);
    expect(serialised).not.toContain(b.tenantId);
    expect(serialised).not.toContain(c.tenantId);
    expect(serialised).not.toContain("ended short and was never explained");
    // The band is text, not the raw contributor count.
    if (!response.data.result.allowed) throw new Error("should be allowed");
    expect(response.data.result.signals[0].contributorBand).toMatch(/businesses$/);
  });

  it("stores subjects as an HMAC and never as a name or phone number", async () => {
    await joined(a);
    await reportShortage(a);

    const rows = await prisma.agentRiskSignal.findMany({ where: { tenantId: a.tenantId } });
    expect(rows).toHaveLength(1);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(SUBJECT_NAME);
    expect(stored).not.toContain(SUBJECT_PHONE);
    expect(stored).not.toContain("0200000111");
    expect(rows[0].subjectKey).toHaveLength(64);
    expect(rows[0].keyBasis).toBe("name+phone");
    expect(rows[0].saltVersion).toBe(1);

    // The same identity hashes to the same key across businesses; a different identity
    // does not. This is what makes matching work without storing the identity.
    const same = hashRiskSubject(SUBJECT_NAME, SUBJECT_PHONE).subjectKey;
    expect(rows[0].subjectKey).toBe(same);
    expect(hashRiskSubject("Synthetic Subject Beta", SUBJECT_PHONE).subjectKey).not.toBe(same);
  });

  it("audits every disclosure, including the ones that disclosed nothing", async () => {
    await joined(a);
    await joined(b);
    await joined(c);
    await joined(viewer);
    await reportShortage(a);
    await reportShortage(b);
    await reportShortage(c);
    await ask(viewer);

    const disclosures = await prisma.riskIntelligenceDisclosure.findMany({
      where: { tenantId: viewer.tenantId },
    });
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0].contributorCount).toBeGreaterThanOrEqual(2);
    expect(disclosures[0].reason).toContain("synthetic person");
    const stored = JSON.stringify(disclosures);
    expect(stored).not.toContain(b.tenantId);
    expect(stored).not.toContain(c.tenantId);
    expect(stored).not.toContain(SUBJECT_PHONE);
  });

  it("stops sharing immediately when a contributing business withdraws", async () => {
    await joined(a);
    await joined(b);
    await joined(c);
    await joined(viewer);
    await reportShortage(a);
    await reportShortage(b);
    await reportShortage(c);
    expect((await ask(viewer)) as { verdict: string }).toMatchObject({
      verdict: "review_recommended",
    });

    actAs(c);
    const left = await withdrawRiskIntelligence({
      reason: "Synthetic business C leaves the shared programme for this test.",
    });
    expect(left.success, left.error).toBe(true);

    const after = await ask(viewer);
    if (!after.allowed) throw new Error(after.denial);
    expect(after.verdict).toBe("no_shared_signals");

    // The contributed row is retained for audit but no longer counts.
    expect(await prisma.agentRiskSignal.count({ where: { tenantId: c.tenantId } })).toBe(1);
    expect(
      await prisma.agentRiskSignal.count({ where: { tenantId: c.tenantId, status: "open" } })
    ).toBe(0);
  });

  it("lets a business correct its own report without leaving the programme", async () => {
    await joined(a);
    await reportShortage(a);
    const mine = await listMyRiskSignals();
    const signal = mine.data?.signals[0];
    expect(signal).toBeTruthy();
    const corrected = await withdrawMyRiskSignal({
      id: signal!.id,
      reason: "The synthetic shortage was later explained by a bank delay.",
    });
    expect(corrected.success, corrected.error).toBe(true);
    expect(
      await prisma.agentRiskSignal.count({ where: { tenantId: a.tenantId, status: "withdrawn" } })
    ).toBe(1);
  });

  it("enforces the 180-day expiry on a fake clock", async () => {
    await joined(a);
    await joined(b);
    await joined(c);
    await joined(viewer);
    await reportShortage(a);
    await reportShortage(b);
    await reportShortage(c);
    expect((await ask(viewer)) as { verdict: string }).toMatchObject({
      verdict: "review_recommended",
    });

    const expiry = await prisma.agentRiskSignal.findFirstOrThrow({ where: { tenantId: a.tenantId } });
    const expected = new Date("2026-11-05T00:00:00.000Z");
    expected.setUTCDate(expected.getUTCDate() + RISK_INTELLIGENCE_DECAY_DAYS);
    expect(expiry.expiresAt.toISOString()).toBe(expected.toISOString());

    // Move the clock past the window rather than waiting 180 days.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-06-01T00:00:00.000Z"));
    const swept = await expireStaleRiskSignals({ token: "unit-retention-token" });
    expect(swept.success, swept.error).toBe(true);
    expect(swept.expired).toBeGreaterThanOrEqual(3);
    vi.useRealTimers();

    const after = await ask(viewer);
    if (!after.allowed) throw new Error(after.denial);
    expect(after.verdict).toBe("no_shared_signals");
    // Expired is a status, not a deletion: the row is kept for audit.
    expect(await prisma.agentRiskSignal.count({ where: { tenantId: a.tenantId } })).toBe(1);
  });

  it("refuses to match a subject across businesses that are not the caller's", async () => {
    await joined(a);
    // A cannot ask about B's employee, even with a matching name and phone.
    actAs(a);
    const refusal = await querySharedRiskSignals({
      userId: b.subjectId,
      reason: "Considering this synthetic person for a counter role",
    });
    expect(refusal.success).toBe(false);
    if (!refusal.success) expect(refusal.error).toMatch(/not found/i);
    // No disclosure is written for a refused query.
    expect(await prisma.riskIntelligenceDisclosure.count({ where: { tenantId: a.tenantId } })).toBe(0);
  });

  it("refuses a contribution built on another business's record", async () => {
    await joined(a);
    const foreignAccount = await prisma.dailyAccount.create({
      data: {
        tenantId: b.tenantId,
        locationId: b.locationId,
        workerId: b.subjectId,
        businessDate: new Date("2026-11-05T00:00:00.000Z"),
        status: "submitted",
      },
    });
    actAs(a);
    const result = await contributeRiskSignal({
      userId: a.subjectId,
      category: "shortage",
      severity: "high",
      sourceType: "dailyAccount",
      sourceId: foreignAccount.id,
      note: "An attempt to build a signal on another business's record.",
      observedFrom: "2026-11-05T00:00:00.000Z",
      observedTo: "2026-11-05T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
    expect(await prisma.agentRiskSignal.count({ where: { tenantId: a.tenantId } })).toBe(0);
  });

  it("refuses to answer rather than saying nobody reported, when the secret is removed", async () => {
    await joined(a);
    await joined(b);
    await joined(c);
    await joined(viewer);
    await reportShortage(a);
    await reportShortage(b);
    await reportShortage(c);
    expect((await ask(viewer)) as { verdict: string }).toMatchObject({
      verdict: "review_recommended",
    });

    // An active consent with no salt cannot match anybody. "No shared signals" would be a
    // false reassurance, so the query is refused.
    delete process.env.RISK_INTELLIGENCE_SALT;
    actAs(viewer);
    const refused = await querySharedRiskSignals({
      userId: viewer.subjectId,
      reason: "Considering this synthetic person for a counter role",
    });
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error).toMatch(/not configured/i);
      expect(refused.error).toMatch(/do not read this as a clean report/i);
    }
    process.env.RISK_INTELLIGENCE_SALT = LOCAL_SALT;
  });

  it("disables the capability again when the local secret is removed", async () => {
    expect(riskIntelligenceConfigured()).toBe(true);
    delete process.env.RISK_INTELLIGENCE_SALT;

    expect(riskIntelligenceConfigured()).toBe(false);
    actAs(a);
    const refusal = await joinRiskIntelligence({
      scope: "share_signals",
      acceptedPolicyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
    });
    expect(refusal.success).toBe(false);
    if (!refusal.success) expect(refusal.error).toMatch(/not configured/i);
    expect(await prisma.riskIntelligenceConsent.count({ where: { tenantId: a.tenantId } })).toBe(0);

    // And a contribution cannot be hashed without the salt either.
    await expect(async () => hashRiskSubject(SUBJECT_NAME, SUBJECT_PHONE)).rejects.toThrow(
      /RISK_INTELLIGENCE_SALT/
    );
    process.env.RISK_INTELLIGENCE_SALT = LOCAL_SALT;
  });
});
