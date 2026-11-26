/**
 * Governance action integration coverage on the disposable unit database.
 * Every actor is synthetic; no application database record is touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { prisma, cleanDatabase } from "./setup";

const { ctxHolder, sessionHolder, workerSessionHolder, platformHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as null | Record<string, unknown> },
  sessionHolder: { current: null as null | Record<string, unknown> },
  workerSessionHolder: { current: null as null | Record<string, unknown> },
  platformHolder: { current: null as null | Record<string, unknown> },
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
vi.mock("@/lib/auth", () => ({
  getAdminSession: async () => sessionHolder.current,
  getMomoSession: async () => workerSessionHolder.current,
  getSusuSession: async () => null,
}));
vi.mock("@/lib/platform-auth", () => ({
  getPlatformAdminOrNull: async () => platformHolder.current,
}));

import {
  acceptParticipationAgreement,
  activateParticipationAgreement,
  countersignParticipationAgreement,
  freezeRiskSubject,
  getPrivacyNotices,
  placeLegalHold,
  presentParticipationAgreement,
  publishEmployeePrivacyNotice,
  recordEmployeeNoticeAttestation,
  recordKeyRotation,
  releaseLegalHold,
  resolveRiskSubjectFreeze,
  resolveRightsRequest,
  runRiskRetentionSweep,
  setGlobalRiskControl,
  setParticipationVerification,
  submitSubjectRightsRequest,
  submitMySubjectRightsRequest,
} from "@/lib/actions/risk-governance.actions";
import {
  joinRiskIntelligence,
  contributeRiskSignal,
  querySharedRiskSignals,
} from "@/lib/actions/risk-intelligence.actions";
import { listClosedRiskSignalSources } from "@/lib/actions/risk-source.actions";
import {
  RISK_INTELLIGENCE_POLICY_VERSION,
} from "@/lib/risk-intelligence/policy";
import { candidateSubjectKeys } from "@/lib/risk-intelligence/hasher";

const SALT = "integration-salt-local-only-not-production-0001";

describe("Risk Intelligence governance actions", () => {
  let tenantId: string;
  let adminId: string;
  let workerId: string;

  beforeEach(async () => {
    process.env.RISK_INTELLIGENCE_SALT = SALT;
    delete process.env.RISK_INTELLIGENCE_ACTIVE_KEY_VERSION;
    delete process.env.RISK_INTELLIGENCE_SUPPORTED_VERSIONS;
    delete process.env.RISK_INTELLIGENCE_KEY_V2;
    await cleanDatabase();
    const tenant = await prisma.businessTenant.create({
      data: {
        code: `GOV-${Math.random().toString(36).slice(2, 7)}`,
        name: "Governance test tenant",
        status: "ACTIVE",
      },
    });
    tenantId = tenant.id;
    const admin = await prisma.user.create({
      data: {
        tenantId,
        email: `gov-admin-${Math.random().toString(36).slice(2, 8)}@test.invalid`,
        fullName: "Governance Admin",
        role: "admin",
        status: "active",
        passwordHash: "x",
      },
    });
    adminId = admin.id;
    const worker = await prisma.user.create({
      data: {
        tenantId,
        email: `gov-worker-${Math.random().toString(36).slice(2, 8)}@test.invalid`,
        fullName: "Synthetic Subject",
        phone: "0200000222",
        role: "worker",
        status: "active",
        passwordHash: "x",
      },
    });
    workerId = worker.id;
    ctxHolder.current = { tenantId, userId: adminId, role: "admin", modules: ["admin"] };
    sessionHolder.current = { userId: adminId, tenantId };
    workerSessionHolder.current = null;
    platformHolder.current = null;
    await prisma.riskPrivacyAccess.create({
      data: {
        userId: adminId,
        role: "privacy_admin",
        grantedById: adminId,
        reason: "Synthetic privacy administrator grant for the disposable unit database.",
      },
    });
  });

  afterEach(() => {
    process.env.RISK_INTELLIGENCE_SALT = SALT;
    vi.useRealTimers();
  });

  function actAsPlatform() {
    sessionHolder.current = null;
    platformHolder.current = {
      adminId: "platform-synthetic",
      email: "platform-synthetic@test.invalid",
      fullName: "Platform Synthetic",
      forcePasswordReset: false,
    };
  }

  async function seedNetwork() {
    for (let index = 0; index < 19; index += 1) {
      const member = await prisma.businessTenant.create({
        data: {
          code: `GON-${index}-${Math.random().toString(36).slice(2, 6)}`,
          name: `Governance network ${index}`,
          status: "ACTIVE",
        },
      });
      await prisma.riskIntelligenceConsent.create({
        data: {
          tenantId: member.id,
          policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
          scope: "share_signals",
          consentedById: adminId,
        },
      });
    }
  }

  it("ENG-07 refuses to answer when the global control is disabled", async () => {
    actAsPlatform();
    await seedNetwork();
    expect((await setGlobalRiskControl({ enabled: false, reason: "Emergency suspension ordered." })).success).toBe(true);
    const refused = await querySharedRiskSignals({
      userId: workerId,
      reason: "Considering this synthetic person for a counter role",
    });
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error).toMatch(/unavailable|not read as a clean report/i);
    expect((await setGlobalRiskControl({ enabled: true, reason: "Emergency lifted after review." })).success).toBe(true);
  });

  it("ENG-03 freezes the subject for an objection and records deadlines", async () => {
    const submitted = await submitSubjectRightsRequest({
      subjectUserId: workerId,
      type: "objection",
      details: "The synthetic subject disputes the reported shortage.",
      evidenceMetadata: "synthetic evidence reference",
    });
    expect(submitted.success, submitted.error).toBe(true);
    if (!submitted.success || !submitted.data) throw new Error("submission failed");
    expect(submitted.data.caseRef).toMatch(/^SR-[0-9A-F]{16}$/);
    const request = await prisma.subjectRightsRequest.findUniqueOrThrow({
      where: { caseRef: submitted.data.caseRef },
    });
    expect(request.status).toBe("frozen");
    expect(request.resolutionDeadline.getTime() - request.receivedAt.getTime()).toBe(21 * 86_400_000);
    const days = Math.round(
      (request.ackDeadline.getTime() - request.receivedAt.getTime()) / 86_400_000
    );
    expect(days).toBeGreaterThanOrEqual(3);
    expect(await prisma.riskSubjectFreeze.count({ where: { status: "frozen" } })).toBeGreaterThan(0);
  });

  it("lets a signed-in worker submit their own rights request without a client-supplied subject", async () => {
    workerSessionHolder.current = { userId: workerId, tenantId, role: "worker" };
    const result = await submitMySubjectRightsRequest({
      type: "access",
      details: "Please provide the shared-risk record held about me and how it was matched.",
      subjectUserId: adminId,
    });
    expect(result.success).toBe(true);
    const caseRef = result.data?.caseRef;
    expect(caseRef).toMatch(/^SR-/);
    const request = await prisma.subjectRightsRequest.findUnique({ where: { caseRef: caseRef! } });
    expect(request?.tenantId).toBe(tenantId);
    expect(request?.subjectUserId).toBe(workerId);
    expect(request?.subjectKey).not.toBeNull();
  });

  it("ENG-02 withdraws frozen signals when an objection is upheld", async () => {
    actAsPlatform();
    const keys = candidateSubjectKeys("Synthetic Subject", "0200000222");
    const account = await prisma.dailyAccount.create({
      data: {
        tenantId,
        locationId: (
          await prisma.location.create({
            data: { tenantId, name: "Counter", code: `GC${Date.now() % 100000}` },
          })
        ).id,
        workerId,
        businessDate: new Date("2026-11-05T00:00:00.000Z"),
        status: "submitted",
      },
    });
    await prisma.agentRiskSignal.create({
      data: {
        tenantId,
        subjectKey: keys[0].subjectKey,
        keyBasis: "name+phone",
        category: "shortage",
        severity: "high",
        sourceType: "dailyAccount",
        sourceId: account.id,
        observedFrom: new Date("2026-11-05T00:00:00.000Z"),
        observedTo: new Date("2026-11-05T00:00:00.000Z"),
        expiresAt: new Date("2027-05-05T00:00:00.000Z"),
      },
    });
    expect(
      (await freezeRiskSubject({
        fullName: "Synthetic Subject",
        phone: "0200000222",
        reason: "A synthetic objection requires a subject-wide freeze.",
      })).success
    ).toBe(true);
    expect(await prisma.agentRiskSignal.count({ where: { status: "disputed_frozen" } })).toBe(1);
    const freeze = await prisma.riskSubjectFreeze.findFirstOrThrow({ where: { status: "frozen" } });
    expect(
      (await resolveRiskSubjectFreeze({
        freezeId: freeze.id,
        decision: "upheld",
        reason: "The synthetic evidence supports the objection.",
      })).success
    ).toBe(true);
    expect(await prisma.agentRiskSignal.count({ where: { status: "withdrawn" } })).toBe(1);
  });

  it("resolves a rights case and its linked subject freeze together", async () => {
    actAsPlatform();
    const keys = candidateSubjectKeys("Synthetic Subject", "0200000222");
    const account = await prisma.dailyAccount.create({
      data: {
        tenantId,
        locationId: (
          await prisma.location.create({
            data: { tenantId, name: "Counter", code: `GR${Date.now() % 100000}` },
          })
        ).id,
        workerId,
        businessDate: new Date("2026-11-05T00:00:00.000Z"),
        status: "submitted",
      },
    });
    await prisma.agentRiskSignal.create({
      data: {
        tenantId,
        subjectKey: keys[0].subjectKey,
        keyBasis: "name+phone",
        category: "shortage",
        severity: "high",
        sourceType: "dailyAccount",
        sourceId: account.id,
        observedFrom: new Date("2026-11-05T00:00:00.000Z"),
        observedTo: new Date("2026-11-05T00:00:00.000Z"),
        expiresAt: new Date("2027-05-05T00:00:00.000Z"),
      },
    });
    const submitted = await submitSubjectRightsRequest({
      subjectUserId: workerId,
      type: "objection",
      details: "The synthetic subject objects to the recorded shortage.",
      evidenceMetadata: "synthetic objection evidence",
    });
    if (!submitted.success || !submitted.data) throw new Error("submission failed");
    const missingOutcome = await resolveRightsRequest({
      caseRef: submitted.data.caseRef,
      decision: "upheld",
      reason: "The synthetic evidence supports the objection.",
      closeCase: true,
    });
    expect(missingOutcome.success).toBe(false);
    expect(
      (
        await resolveRightsRequest({
          caseRef: submitted.data.caseRef,
          decision: "upheld",
          reason: "The synthetic evidence supports the objection.",
          closeCase: true,
          freezeOutcome: "upheld",
        })
      ).success
    ).toBe(true);
    const request = await prisma.subjectRightsRequest.findUniqueOrThrow({
      where: { caseRef: submitted.data.caseRef },
    });
    expect(request.status).toBe("closed");
    expect(await prisma.agentRiskSignal.count({ where: { status: "withdrawn" } })).toBe(1);
    expect(await prisma.riskSubjectFreeze.count({ where: { status: "upheld" } })).toBeGreaterThan(0);
  });

  it("lists only the selected employee's closed records as contribution sources", async () => {
    await prisma.riskIntelligenceConsent.create({
      data: {
        tenantId,
        policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
        scope: "share_signals",
        consentedById: adminId,
      },
    });
    const location = await prisma.location.create({
      data: { tenantId, name: "Counter", code: `GL${Date.now() % 100000}` },
    });
    const own = await prisma.dailyAccount.create({
      data: {
        tenantId,
        locationId: location.id,
        workerId,
        businessDate: new Date("2026-11-06T00:00:00.000Z"),
        status: "reviewed",
        reviewedAt: new Date("2026-11-07T00:00:00.000Z"),
      },
    });
    const otherWorker = await prisma.user.create({
      data: {
        tenantId,
        email: `gov-other-${Math.random().toString(36).slice(2, 8)}@test.invalid`,
        fullName: "Other Synthetic Worker",
        phone: "0200000333",
        role: "worker",
        status: "active",
        passwordHash: "x",
      },
    });
    await prisma.dailyAccount.create({
      data: {
        tenantId,
        locationId: location.id,
        workerId: otherWorker.id,
        businessDate: new Date("2026-11-07T00:00:00.000Z"),
        status: "reviewed",
        reviewedAt: new Date("2026-11-08T00:00:00.000Z"),
      },
    });
    const listed = await listClosedRiskSignalSources(workerId);
    expect(listed.success, listed.error).toBe(true);
    expect(listed.data?.sources.map((row) => row.sourceId)).toEqual([own.id]);
  });

  it("ENG-06 and ENG-08 allow contribution only after notices and agreements", async () => {
    const noticeText = "Synthetic employee privacy notice text for the disposable unit test.";
    actAsPlatform();
    const published = await publishEmployeePrivacyNotice({
      version: "gov-notice-1",
      title: "Employee Privacy Notice",
      documentText: noticeText,
      effectiveDate: "2026-11-01T00:00:00.000Z",
      policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
    });
    expect(published.success, published.error).toBe(true);
    platformHolder.current = null;
    sessionHolder.current = { userId: adminId, tenantId };
    const notices = await getPrivacyNotices();
    expect(notices.data?.some((notice) => notice.version === "gov-notice-1")).toBe(true);
    expect(
      (
        await recordEmployeeNoticeAttestation({
          userId: workerId,
          noticeVersion: "gov-notice-1",
          deliveryMethod: "portal_acknowledgement",
          deliveryEvidence: "synthetic delivery evidence",
          acknowledgementState: "acknowledged",
        })
      ).success
    ).toBe(true);

    const agreementHash = createHash("sha256")
      .update("Synthetic agreement text supplied for the unit test.")
      .digest("hex");
    process.env.RISK_AGREEMENT_HASHES = JSON.stringify({
      participation_terms: agreementHash,
      joint_controller: agreementHash,
    });
    const presented = await presentParticipationAgreement({
      type: "participation_terms",
      version: "gov-agreement-1",
      effectiveDate: "2026-11-01T00:00:00.000Z",
      documentText: "Synthetic agreement text supplied for the unit test.",
    });
    if (!presented.success || !presented.data) throw new Error("presentation failed");
    const hash = createHash("sha256")
      .update("Synthetic agreement text supplied for the unit test.")
      .digest("hex");
    expect(presented.data.documentSha256).toBe(hash);
    const accepted = await acceptParticipationAgreement({
      agreementId: presented.data.id,
      signatoryName: "Governance Admin",
      signatoryRole: "owner",
      signatoryAuthority: "authorised business representative",
      authenticationMethod: "unit-test-authentication",
      acceptedDocumentSha256: hash,
    });
    expect(accepted.success, accepted.error).toBe(true);
    expect((await countersignParticipationAgreement({ agreementId: presented.data.id })).success).toBe(true);
    expect((await activateParticipationAgreement({ agreementId: presented.data.id })).success).toBe(true);
    await prisma.participationAgreement.create({
      data: {
        tenantId,
        type: "joint_controller",
        title: "Joint Controller Agreement",
        version: "gov-agreement-1",
        effectiveDate: new Date("2026-11-01T00:00:00.000Z"),
        documentText: "Synthetic agreement text supplied for the unit test.",
        documentSha256: agreementHash,
        documentRef: "unit-test",
        state: "active",
        signatoryId: adminId,
        signatoryName: "Governance Admin",
        signatoryRole: "owner",
        signatoryAuthority: "authorised business representative",
        authenticationMethod: "unit-test-authentication",
        acceptedAt: new Date(),
        executedAt: new Date(),
      },
    });
    expect(
      (await joinRiskIntelligence({
        scope: "share_signals",
        acceptedPolicyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
      })).success
    ).toBe(true);
    expect(
      (
        await setParticipationVerification({
          tenantId,
          eligibilityVerified: true,
          controllerRegistrationChecked: true,
          reason: "Synthetic eligibility verification for the unit test.",
        })
      ).success
    ).toBe(true);

    const account = await prisma.dailyAccount.create({
      data: {
        tenantId,
        locationId: (
          await prisma.location.create({
            data: { tenantId, name: "Counter", code: `GA${Date.now() % 100000}` },
          })
        ).id,
        workerId,
        businessDate: new Date("2026-11-05T00:00:00.000Z"),
        status: "reviewed",
        reviewedAt: new Date("2026-11-06T00:00:00.000Z"),
      },
    });
    const contributed = await contributeRiskSignal({
      userId: workerId,
      category: "shortage",
      severity: "high",
      sourceType: "dailyAccount",
      sourceId: account.id,
      note: "The synthetic day ended short and was never explained.",
      observedFrom: "2026-11-05T00:00:00.000Z",
      observedTo: "2026-11-05T00:00:00.000Z",
      goodFaith: true,
    });
    expect(contributed.success, contributed.error).toBe(true);
  });

  it("ENG-04 keeps a legally held signal beyond its deletion deadline", async () => {
    actAsPlatform();
    const keys = candidateSubjectKeys("Synthetic Subject", "0200000222");
    const signal = await prisma.agentRiskSignal.create({
      data: {
        tenantId,
        subjectKey: keys[0].subjectKey,
        keyBasis: "name+phone",
        category: "shortage",
        severity: "high",
        sourceType: "dailyAccount",
        sourceId: "held-record",
        observedFrom: new Date("2019-12-31T00:00:00.000Z"),
        observedTo: new Date("2019-12-31T00:00:00.000Z"),
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        status: "expired",
      },
    });
    const held = await placeLegalHold({
      scopeType: "signal",
      scopeId: signal.id,
      reference: "HOLD-UNIT-1",
      reason: "A synthetic DPC investigation requires this record.",
    });
    if (!held.success || !held.data) throw new Error("hold failed");
    const blocked = await runRiskRetentionSweep();
    expect(blocked.data?.scrubbed).toBe(0);
    expect((await prisma.agentRiskSignal.findUniqueOrThrow({ where: { id: signal.id } })).deletedAt).toBeNull();
    expect(
      (await releaseLegalHold({ holdId: held.data.id, reason: "The synthetic investigation closed." })).success
    ).toBe(true);
    const swept = await runRiskRetentionSweep();
    expect(swept.data?.scrubbed).toBe(1);
    const scrubbed = await prisma.agentRiskSignal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(scrubbed.subjectKey).toBe(`scrubbed:${signal.id}`);
    expect(scrubbed.internalNote).toBeNull();
  });

  it("ENG-05 records rotation metadata without storing a secret", async () => {
    actAsPlatform();
    process.env.RISK_INTELLIGENCE_KEY_V2 = "rotation-key-v2-local-only-000000001";
    process.env.RISK_INTELLIGENCE_ACTIVE_KEY_VERSION = "2";
    const rotated = await recordKeyRotation({
      newVersion: 2,
      previousVersion: 1,
      reason: "Synthetic dual-key rotation rehearsal.",
    });
    expect(rotated.success, rotated.error).toBe(true);
    const versions = await prisma.riskKeyVersion.findMany({ orderBy: { version: "asc" } });
    expect(versions.map((row) => row.version)).toEqual([1, 2]);
    expect(versions.find((row) => row.version === 2)?.status).toBe("active");
    expect(versions.find((row) => row.version === 1)?.status).toBe("previous");
    expect(JSON.stringify(versions)).not.toContain(SALT);
  });
  it("limits a delegated privacy administrator to their own business", async () => {
    const otherTenant = await prisma.businessTenant.create({
      data: {
        code: `GOV-OTHER-${Math.random().toString(36).slice(2, 6)}`,
        name: "Other governance tenant",
        status: "ACTIVE",
      },
    });
    const otherAdmin = await prisma.user.create({
      data: {
        tenantId: otherTenant.id,
        email: `other-admin-${Math.random().toString(36).slice(2, 8)}@test.invalid`,
        fullName: "Other Governance Admin",
        role: "admin",
        status: "active",
        passwordHash: "x",
      },
    });
    await prisma.riskPrivacyAccess.create({
      data: {
        userId: otherAdmin.id,
        role: "privacy_admin",
        grantedById: adminId,
        reason: "Synthetic second-business privacy administrator grant for isolation testing.",
      },
    });
    const keys = candidateSubjectKeys("Synthetic Subject", "0200000222");
    const signal = await prisma.agentRiskSignal.create({
      data: {
        tenantId,
        subjectKey: keys[0].subjectKey,
        keyBasis: "name+phone",
        category: "shortage",
        severity: "high",
        sourceType: "dailyAccount",
        sourceId: "cross-tenant-signal",
        observedFrom: new Date("2026-11-05T00:00:00.000Z"),
        observedTo: new Date("2026-11-05T00:00:00.000Z"),
        expiresAt: new Date("2027-05-05T00:00:00.000Z"),
      },
    });
    ctxHolder.current = {
      tenantId: otherTenant.id,
      userId: otherAdmin.id,
      role: "admin",
      modules: ["admin"],
    };
    sessionHolder.current = { userId: otherAdmin.id };
    expect(
      (await setGlobalRiskControl({ enabled: false, reason: "Cross-tenant global control attempt." })).success
    ).toBe(false);
    expect(
      (
        await placeLegalHold({
          scopeType: "signal",
          scopeId: signal.id,
          reference: "HOLD-CROSS-1",
          reason: "Cross-tenant legal hold attempt must be refused.",
        })
      ).success
    ).toBe(false);
    expect(
      (
        await setParticipationVerification({
          tenantId,
          eligibilityVerified: true,
          controllerRegistrationChecked: false,
          reason: "Cross-tenant verification attempt must be refused.",
        })
      ).success
    ).toBe(false);
  });

});
