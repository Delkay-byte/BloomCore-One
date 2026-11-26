/**
 * Shared agent risk intelligence.
 *
 * This is the feature where a well-meaning implementation does the most damage, so the
 * tests are mostly about what the product refuses: enrolling without consent, showing one
 * business's accusation to another, naming anybody, or answering a query without a record
 * of having answered it.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";
import {
  RISK_INTELLIGENCE_MIN_CONTRIBUTORS,
  RISK_INTELLIGENCE_POLICY_VERSION,
  RISK_INTELLIGENCE_PROMISES,
  evaluateRiskQuery,
  validateRiskContribution,
  type RiskConsentState,
  type RiskSignalFact,
} from "@/lib/risk-intelligence/policy";
import { hashRiskSubject, riskIntelligenceConfigured } from "@/lib/risk-intelligence/hasher";

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
  getRiskIntelligenceConsent,
  joinRiskIntelligence,
  listMyRiskSignals,
  querySharedRiskSignals,
  withdrawMyRiskSignal,
  withdrawRiskIntelligence,
} from "@/lib/actions/risk-intelligence.actions";

process.env.RISK_INTELLIGENCE_SALT = "test-salt-that-is-long-enough-for-the-policy";

const ACTIVE: RiskConsentState = {
  active: true,
  scope: "share_signals",
  policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
};

function signal(overrides: Partial<RiskSignalFact> = {}): RiskSignalFact {
  return {
    category: "repeated_shortage",
    severity: "high",
    tenantId: "tenant-a",
    observedAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2027-05-01T00:00:00.000Z",
    ...overrides,
  };
}

const queryBase = {
  consent: ACTIVE,
  globalEnabled: true,
  subjectFrozen: false,
  network: { activeEligibleBusinesses: 20 },
  tenantAvailable: true,
  role: "admin",
  subjectKnownToCaller: true,
  reason: "Considering this person for a counter role",
  callerTenantId: "tenant-viewer",
  asOf: "2026-12-01T00:00:00.000Z",
};

describe("evaluateRiskQuery", () => {
  it("refuses every caller who has not joined, in the order they would meet it", () => {
    const missing = evaluateRiskQuery({
      ...queryBase,
      consent: { active: false, scope: null, policyVersion: null },
      signals: [],
    });
    expect(missing.allowed).toBe(false);
    if (!missing.allowed) expect(missing.denial).toBe("consent_missing");

    const withdrawn = evaluateRiskQuery({
      ...queryBase,
      consent: { active: false, scope: "share_signals", policyVersion: RISK_INTELLIGENCE_POLICY_VERSION },
      signals: [],
    });
    expect(withdrawn.allowed).toBe(false);
    if (!withdrawn.allowed) expect(withdrawn.denial).toBe("consent_withdrawn");

    const stale = evaluateRiskQuery({
      ...queryBase,
      consent: { active: true, scope: "share_signals", policyVersion: "old-policy" },
      signals: [],
    });
    expect(stale.allowed).toBe(false);
    if (!stale.allowed) expect(stale.denial).toBe("policy_version_stale");

    const worker = evaluateRiskQuery({ ...queryBase, role: "worker", signals: [] });
    expect(worker.allowed).toBe(false);
    if (!worker.allowed) expect(worker.denial).toBe("role_not_permitted");

    const stranger = evaluateRiskQuery({ ...queryBase, subjectKnownToCaller: false, signals: [] });
    expect(stranger.allowed).toBe(false);
    if (!stranger.allowed) expect(stranger.denial).toBe("subject_not_known_to_business");

    const noReason = evaluateRiskQuery({ ...queryBase, reason: "check", signals: [] });
    expect(noReason.allowed).toBe(false);
    if (!noReason.allowed) expect(noReason.denial).toBe("reason_required");
  });

  it("never discloses a single business's report", () => {
    const result = evaluateRiskQuery({ ...queryBase, signals: [signal()] });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.verdict).toBe("no_shared_signals");
    expect(result.signals).toHaveLength(0);
    expect(result.contributorCount).toBe(1);
    expect(result.notes.join(" ")).toMatch(/single business's report is never shown/i);
  });

  it("discloses only once independent businesses agree on the kind of problem", () => {
    const result = evaluateRiskQuery({
      ...queryBase,
      signals: [
        signal({ tenantId: "a" }),
        signal({ tenantId: "b" }),
        signal({ tenantId: "c" }),
      ],
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.verdict).toBe("review_recommended");
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].contributorBand).toBe("3 to 5 businesses");
    expect(result.contributorCount).toBeGreaterThanOrEqual(RISK_INTELLIGENCE_MIN_CONTRIBUTORS);
  });

  it("will not combine unrelated complaints into one accusation", () => {
    // Three businesses, three different problems, each reported once.
    const result = evaluateRiskQuery({
      ...queryBase,
      signals: [
        signal({ tenantId: "a", category: "shortage" }),
        signal({ tenantId: "b", category: "evidence_gap" }),
        signal({ tenantId: "c", category: "unreconciled_day" }),
      ],
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.verdict).toBe("no_shared_signals");
    expect(result.signals).toHaveLength(0);
  });

  it("never counts the caller's own signal towards unlocking disclosure", () => {
    const result = evaluateRiskQuery({
      ...queryBase,
      signals: [
        signal({ tenantId: queryBase.callerTenantId }),
        signal({ tenantId: "a" }),
        signal({ tenantId: "b" }),
      ],
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.verdict).toBe("no_shared_signals");
    expect(result.contributorCount).toBe(2);
  });

  it("ignores expired signals and unknown categories", () => {
    const result = evaluateRiskQuery({
      ...queryBase,
      signals: [
        signal({ tenantId: "a", expiresAt: "2026-01-01T00:00:00.000Z" }),
        signal({ tenantId: "b" }),
        signal({ tenantId: "c", category: "gossip" }),
      ],
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.verdict).toBe("no_shared_signals");
  });

  it("is structurally not a blacklist", () => {
    const result = evaluateRiskQuery({
      ...queryBase,
      signals: [signal({ tenantId: "a" }), signal({ tenantId: "b" }), signal({ tenantId: "c" })],
    });
    if (!result.allowed) throw new Error(result.denial);
    expect(result.isBlacklist).toBe(false);
    expect(result.disclosesIdentity).toBe(false);
    expect(result.requiresHumanJudgement).toBe(true);
    expect(result.headline).toMatch(/review/i);
    expect(JSON.stringify(result)).not.toContain("tenant-a");
    expect(JSON.stringify(result)).not.toContain("internalNote");
  });

  it("tells every joiner what it promises", () => {
    const text = RISK_INTELLIGENCE_PROMISES.join(" ");
    expect(text).toMatch(/never enrolled without its owner accepting/i);
    expect(text).toMatch(/never a name, a phone number, a note or a file/i);
    expect(text).toMatch(/nothing here blocks, blacklists or publicly names/i);
    expect(text).toMatch(/withdraw at any time/i);
  });
});

describe("validateRiskContribution", () => {
  const valid = {
    consent: ACTIVE,
    category: "shortage",
    severity: "high",
    sourceType: "anomalyInvestigation",
    sourceId: "inv_1",
    reasonLength: 40,
    alreadyContributed: false,
    businessEligibilityVerified: true,
    controllerRegistrationChecked: true,
    agreementsExecuted: true,
    noticeEvidenceRecorded: true,
    businessSuspended: false,
    globalEnabled: true,
  };

  it("accepts a signal that points at a closed record", () => {
    const result = validateRiskContribution(valid);
    expect(result.ok).toBe(true);
  });

  it("refuses contribution from a business that only queries", () => {
    const result = validateRiskContribution({
      ...valid,
      consent: { ...ACTIVE, scope: "query_only" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/active agreement/i);
  });

  it("refuses a stale policy, an unknown category, a duplicate and no reason", () => {
    expect(validateRiskContribution({ ...valid, consent: { ...ACTIVE, policyVersion: "old" } }).ok).toBe(false);
    expect(validateRiskContribution({ ...valid, category: "rumour" }).ok).toBe(false);
    expect(validateRiskContribution({ ...valid, alreadyContributed: true }).ok).toBe(false);
    expect(validateRiskContribution({ ...valid, reasonLength: 3 }).ok).toBe(false);
    expect(validateRiskContribution({ ...valid, sourceId: "" }).ok).toBe(false);
  });
});

describe("hasher", () => {
  it("is configured only with a long salt", () => {
    expect(riskIntelligenceConfigured()).toBe(true);
    const saved = process.env.RISK_INTELLIGENCE_SALT;
    process.env.RISK_INTELLIGENCE_SALT = "short";
    expect(riskIntelligenceConfigured()).toBe(false);
    expect(() => hashRiskSubject("Ama Mensah", "0244000111")).toThrow(/RISK_INTELLIGENCE_SALT/);
    process.env.RISK_INTELLIGENCE_SALT = saved;
  });

  it("keys on name and phone together, and never returns the identity", () => {
    const first = hashRiskSubject("Ama  Mensah", "024 400 0111");
    const second = hashRiskSubject("ama mensah", "+233244000111");
    expect(first.subjectKey).toBe(second.subjectKey);
    expect(first.subjectKey).toHaveLength(64);
    expect(first.subjectKey).not.toContain("ama");
    expect(hashRiskSubject("Ama Mensah", "0209999999").subjectKey).not.toBe(first.subjectKey);
    expect(hashRiskSubject("Kofi Mensah", "0244000111").subjectKey).not.toBe(first.subjectKey);
  });

  it("refuses an identity it cannot match", () => {
    expect(() => hashRiskSubject("A", "0244000111")).toThrow(/name and a mobile number/);
    expect(() => hashRiskSubject("Ama Mensah", "0244")).toThrow(/name and a mobile number/);
  });
});

describe("shared risk intelligence in the database", () => {
  let tenantId: string;
  let adminId: string;
  let employeeId: string;

  async function makeParticipant(id: string) {
    await prisma.riskIntelligenceConsent.create({
      data: {
        tenantId: id,
        policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
        status: "active",
        scope: "share_signals",
        consentedById: "network-seed",
        eligibilityVerified: true,
        controllerRegistrationChecked: true,
      },
    });
    for (const type of ["joint_controller", "participation_terms"] as const) {
      await prisma.participationAgreement.create({
        data: {
          tenantId: id,
          type,
          title: type,
          version: "network-1",
          effectiveDate: new Date(),
          documentText: "Disposable network agreement text.",
          documentSha256: "0".repeat(64),
          documentRef: "unit-test",
          state: "active",
          signatoryId: "network-seed",
          signatoryName: "Network Seed",
          signatoryRole: "owner",
          signatoryAuthority: "business owner",
          authenticationMethod: "unit-test",
        },
      });
    }
  }

  /** Seed enough independent, eligible businesses for the 20-business network gate. */
  async function seedNetwork(size: number) {
    for (let index = 0; index < size; index += 1) {
      const seeded = await seedTenantMuted("NET" + index);
      await makeParticipant(seeded.tenantId);
    }
  }

  async function seedTenantMuted(code: string) {
    const tenant = await prisma.businessTenant.create({
      data: { code: `${code}-${Math.random().toString(36).slice(2, 8)}`, name: `Tenant ${code}`, status: "ACTIVE" },
    });
    return { tenantId: tenant.id };
  }

  async function seedTenant(code: string, participant = false) {
    const tenant = await prisma.businessTenant.create({
      data: { code: `${code}-${Math.random().toString(36).slice(2, 8)}`, name: `Tenant ${code}`, status: "ACTIVE" },
    });
    const admin = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `${code.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@test.local`,
        fullName: `${code} Admin`,
        role: "admin",
        status: "active",
        passwordHash: "x",
      },
    });
    if (participant) await makeParticipant(tenant.id);
    return { tenantId: tenant.id, adminId: admin.id };
  }

  beforeEach(async () => {
    await cleanDatabase();
    const seeded = await seedTenant("RI");
    tenantId = seeded.tenantId;
    adminId = seeded.adminId;
    const employee = await prisma.user.create({
      data: {
        tenantId,
        email: `ri-emp-${Math.random().toString(36).slice(2, 8)}@test.local`,
        fullName: "Ama Mensah",
        phone: "0244000111",
        role: "worker",
        status: "active",
        passwordHash: "x",
      },
    });
    employeeId = employee.id;
    ctxHolder.current = { tenantId, userId: adminId, role: "admin", modules: ["admin"] };

    // ENG-01: the eligible network is created only in the disposable unit
    // database. No fixture data touches the application database.
    for (let index = 0; index < 19; index += 1) {
      const member = await seedTenant(`NW${index}`);
      await prisma.riskIntelligenceConsent.create({
        data: {
          tenantId: member.tenantId,
          policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
          scope: "share_signals",
          consentedById: member.adminId,
        },
      });
    }
  });

  async function join() {
    const result = await joinRiskIntelligence({
      scope: "share_signals",
      acceptedPolicyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
    });
    expect(result.success, result.error).toBe(true);
    await prisma.riskIntelligenceConsent.updateMany({
      where: { tenantId },
      data: { eligibilityVerified: true, controllerRegistrationChecked: true },
    });
    for (const type of ["joint_controller", "participation_terms"] as const) {
      await prisma.participationAgreement.create({
        data: {
          tenantId,
          type,
          title: type === "joint_controller" ? "Joint Controller Agreement" : "Business Participation and Data-Sharing Terms",
          version: "test-1",
          effectiveDate: new Date(),
          documentText: "Disposable unit-test agreement text.",
          documentSha256: "0".repeat(64),
          documentRef: "unit-test",
          state: "active",
          signatoryId: adminId,
          signatoryName: "Test Owner",
          signatoryRole: "owner",
          signatoryAuthority: "business owner",
          authenticationMethod: "unit-test",
        },
      });
    }
    // The live disclosure threshold requires 20 eligible businesses.
    await seedNetwork(19);
    const noticeText = "Disposable unit-test notice text.";
    const noticeHash = createHash("sha256").update(noticeText, "utf8").digest("hex");
    await prisma.employeePrivacyNotice.create({
      data: {
        version: "test-notice-1",
        title: "Employee Privacy Notice",
        documentText: noticeText,
        documentHash: noticeHash,
        effectiveDate: new Date(),
        policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
      },
    });
    await prisma.employeeNoticeAttestation.create({
      data: {
        tenantId,
        userId: employeeId,
        noticeVersion: "test-notice-1",
        deliveryMethod: "portal_acknowledgement",
        issuedAt: new Date(),
        deliveryEvidence: "unit-test-evidence",
        acknowledgementState: "acknowledged",
        acknowledgedAt: new Date(),
        verified: true,
        verifiedAt: new Date(),
        recordedById: adminId,
        policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
        documentSha256: noticeHash,
      },
    });
  }

  it("is off until the owner joins, and joining needs the current policy", async () => {
    const before = await getRiskIntelligenceConsent();
    expect(before.data?.active).toBe(false);

    const stale = await joinRiskIntelligence({
      scope: "share_signals",
      acceptedPolicyVersion: "risk-intelligence-policy-2025.01",
    });
    expect(stale.success).toBe(false);

    await join();
    const after = await getRiskIntelligenceConsent();
    expect(after.data?.active).toBe(true);
    expect(after.data?.currentPolicyVersion).toBe(RISK_INTELLIGENCE_POLICY_VERSION);
  });

  it("refuses a query from a business that has not joined", async () => {
    const result = await querySharedRiskSignals({
      userId: employeeId,
      reason: "Considering this person for a counter role",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data?.result.allowed).toBe(false);
    if (result.data && !result.data.result.allowed) {
      expect(result.data.result.denial).toBe("consent_missing");
    }
  });

  it("records every disclosure it gives, and gives nothing without three businesses", async () => {
    await join();
    const short = await querySharedRiskSignals({
      userId: employeeId,
      reason: "Considering this person for a counter role",
    });
    expect(short.success).toBe(true);
    if (!short.success) return;
    expect(short.data?.result.allowed).toBe(true);
    if (short.data && short.data.result.allowed) {
      expect(short.data.result.verdict).toBe("no_shared_signals");
    }

    // Two other businesses report the same kind of problem. Still not enough.
    const subject = hashRiskSubject("Ama Mensah", "0244000111");
    for (const code of ["RB", "RC"]) {
      const other = await seedTenant(code, true);
      await prisma.agentRiskSignal.create({
        data: {
          tenantId: other.tenantId,
          subjectKey: subject.subjectKey,
          keyBasis: subject.keyBasis,
          category: "repeated_shortage",
          severity: "high",
          sourceType: "anomalyInvestigation",
          sourceId: `src-${code}`,
          observedFrom: new Date("2026-11-01T00:00:00.000Z"),
          observedTo: new Date("2026-11-05T00:00:00.000Z"),
          expiresAt: new Date("2027-05-05T00:00:00.000Z"),
        },
      });
    }
    const two = await querySharedRiskSignals({
      userId: employeeId,
      reason: "Considering this person for a counter role",
    });
    if (!two.success || !two.data) throw new Error("query failed");
    if (!two.data.result.allowed) throw new Error("should be allowed");
    expect(two.data.result.verdict).toBe("no_shared_signals");

    // A third makes it a cohort.
    const third = await seedTenant("RD", true);
    await prisma.agentRiskSignal.create({
      data: {
        tenantId: third.tenantId,
        subjectKey: subject.subjectKey,
        keyBasis: subject.keyBasis,
        category: "repeated_shortage",
        severity: "medium",
        sourceType: "anomalyInvestigation",
        sourceId: "src-RD",
        observedFrom: new Date("2026-11-01T00:00:00.000Z"),
        observedTo: new Date("2026-11-05T00:00:00.000Z"),
        expiresAt: new Date("2027-05-05T00:00:00.000Z"),
      },
    });

    const three = await querySharedRiskSignals({
      userId: employeeId,
      reason: "Considering this person for a counter role",
    });
    if (!three.success || !three.data) throw new Error("query failed");
    if (!three.data.result.allowed) throw new Error("should be allowed");
    expect(three.data.result.verdict).toBe("review_recommended");
    expect(three.data.result.signals).toHaveLength(1);
    expect(three.data.result.signals[0].category).toBe("repeated_shortage");

    const disclosures = await prisma.riskIntelligenceDisclosure.findMany({ where: { tenantId } });
    expect(disclosures.length).toBe(3);
    // The log itself must not identify the contributing businesses.
    const stored = JSON.stringify(disclosures);
    expect(stored).not.toContain(third.tenantId);
    expect(stored).not.toContain("RB-");
  });

  it("stops sharing the moment a business withdraws", async () => {
    await join();
    const subject = hashRiskSubject("Ama Mensah", "0244000111");
    const contributors = ["RE", "RF", "RG"];
    const ids: string[] = [];
    for (const code of contributors) {
      const other = await seedTenant(code, true);
      ids.push(other.tenantId);
      await prisma.agentRiskSignal.create({
        data: {
          tenantId: other.tenantId,
          subjectKey: subject.subjectKey,
          keyBasis: subject.keyBasis,
          category: "shortage",
          severity: "high",
          sourceType: "anomalyInvestigation",
          sourceId: `w-${code}`,
          observedFrom: new Date("2026-11-01T00:00:00.000Z"),
          observedTo: new Date("2026-11-05T00:00:00.000Z"),
          expiresAt: new Date("2027-05-05T00:00:00.000Z"),
        },
      });
    }

    const before = await querySharedRiskSignals({
      userId: employeeId,
      reason: "Considering this person for a counter role",
    });
    if (!before.success || !before.data || !before.data.result.allowed) throw new Error("query failed");
    expect(before.data.result.verdict).toBe("review_recommended");

    // One contributor leaves.
    ctxHolder.current = { tenantId: ids[0], userId: adminId, role: "admin", modules: ["admin"] };
    const left = await withdrawRiskIntelligence({ reason: "We have left the shared programme." });
    expect(left.success, left.error).toBe(true);

    ctxHolder.current = { tenantId, userId: adminId, role: "admin", modules: ["admin"] };
    const after = await querySharedRiskSignals({
      userId: employeeId,
      reason: "Considering this person for a counter role",
    });
    if (!after.success || !after.data || !after.data.result.allowed) throw new Error("query failed");
    expect(after.data.result.verdict).toBe("no_shared_signals");

    // Their contributed rows are kept for audit, but no longer count.
    const kept = await prisma.agentRiskSignal.count({ where: { tenantId: ids[0] } });
    expect(kept).toBe(1);
    expect(await prisma.agentRiskSignal.count({ where: { tenantId: ids[0], status: "open" } })).toBe(0);
  });

  it("refuses a query about somebody the business has no record of", async () => {
    await join();
    const other = await seedTenant("RH");
    const stranger = await prisma.user.create({
      data: {
        tenantId: other.tenantId,
        email: `rh-${Math.random().toString(36).slice(2, 8)}@test.local`,
        fullName: "Other Person",
        phone: "0209998887",
        role: "worker",
        status: "active",
        passwordHash: "x",
      },
    });
    const result = await querySharedRiskSignals({
      userId: stranger.id,
      reason: "Considering this person for a counter role",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not found/i);
  });

  it("will not build a signal on another business's record", async () => {
    await join();
    const other = await seedTenant("RJ");
    const foreign = await prisma.anomalyInvestigation.create({
      data: {
        tenantId: other.tenantId,
        anomalyId: "anom-x",
        title: "Foreign investigation",
        openedById: other.adminId,
        status: "open",
      } as never,
    }).catch(() => null);

    const result = await contributeRiskSignal({
      userId: employeeId,
      category: "shortage",
      severity: "high",
      sourceType: "anomalyInvestigation",
      sourceId: foreign?.id ?? "does-not-exist",
      note: "The day ended short and was never explained",
      observedFrom: "2026-11-01T00:00:00.000Z",
      observedTo: "2026-11-05T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/not one of your business's records|invalid signal/i);
    }
  });

  it("stores a contribution as a hash, and lets the business withdraw it", async () => {
    await join();
    const account = await prisma.dailyAccount.create({
      data: {
        tenantId,
        locationId: (
          await prisma.location.create({
            data: { tenantId, name: "Counter", code: `RC${Date.now() % 100000}` },
          })
        ).id,
        workerId: employeeId,
        businessDate: new Date("2026-11-05T00:00:00.000Z"),
        status: "reviewed",
        reviewedAt: new Date("2026-11-06T00:00:00.000Z"),
      },
    });

    const created = await contributeRiskSignal({
      userId: employeeId,
      category: "shortage",
      severity: "high",
      sourceType: "dailyAccount",
      sourceId: account.id,
      note: "The day ended short and was never explained",
      observedFrom: "2026-11-05T00:00:00.000Z",
      observedTo: "2026-11-05T00:00:00.000Z",
      goodFaith: true,
    });
    expect(created.success, created.error).toBe(true);

    const stored = await prisma.agentRiskSignal.findMany({ where: { tenantId } });
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain("Ama Mensah");
    expect(JSON.stringify(stored)).not.toContain("0244000111");
    expect(stored[0].subjectKey).toHaveLength(64);

    // The same record cannot be shared twice.
    const again = await contributeRiskSignal({
      userId: employeeId,
      category: "shortage",
      severity: "high",
      sourceType: "dailyAccount",
      sourceId: account.id,
      note: "The day ended short and was never explained",
      observedFrom: "2026-11-05T00:00:00.000Z",
      observedTo: "2026-11-05T00:00:00.000Z",
    });
    expect(again.success).toBe(false);

    const mine = await listMyRiskSignals();
    expect(mine.data?.signals).toHaveLength(1);

    const withdrawn = await withdrawMyRiskSignal({
      id: stored[0].id,
      reason: "The shortage was later explained by a bank delay.",
    });
    expect(withdrawn.success, withdrawn.error).toBe(true);
    expect(await prisma.agentRiskSignal.count({ where: { tenantId, status: "withdrawn" } })).toBe(1);
  });
});
