/**
 * Outbound governance notifications, agent notice acknowledgement and
 * agreement execution evidence. All recipients are synthetic and delivery is
 * forced into the in-memory outbox; no real email is sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { prisma, cleanDatabase } from "./setup";
import { clearEmailOutbox, getEmailOutbox } from "@/lib/email/resend";

const { ctxHolder, sessionHolder, momoHolder, platformHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as null | Record<string, unknown> },
  sessionHolder: { current: null as null | Record<string, unknown> },
  momoHolder: { current: null as null | Record<string, unknown> },
  platformHolder: {
    current: null as null | { adminId: string; forcePasswordReset: boolean },
  },
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
  getMomoSession: async () => momoHolder.current,
  getSusuSession: async () => null,
  // platform-auth imports these; the real implementations are unrelated to
  // these governance tests but must exist for the partial platform mock.
  hashPassword: async () => "synthetic-hash",
  verifyPassword: async () => false,
  SESSION_POLICY: {
    idleSeconds: 900,
    backgroundSeconds: 300,
    absoluteSeconds: 28800,
  },
}));
vi.mock("@/lib/platform-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform-auth")>();
  return {
    ...actual,
    getPlatformAdminOrNull: async () => platformHolder.current,
  };
});

/** Notice publication and countersignature are platform-only controls. */
function asPlatform() {
  sessionHolder.current = null;
  platformHolder.current = { adminId: "platform-test", forcePasswordReset: false };
}
function asTenant() {
  platformHolder.current = null;
  sessionHolder.current = { userId: adminIdForTest, tenantId: tenantIdForTest };
}
let adminIdForTest = "";
let tenantIdForTest = "";

import {
  acceptParticipationAgreement,
  acknowledgeRightsRequest,
  countersignParticipationAgreement,
  getParticipationAgreementDocument,
  presentParticipationAgreement,
  publishControlledEmployeeNotice,
  publishEmployeePrivacyNotice,
  submitSubjectRightsRequest,
} from "@/lib/actions/risk-governance.actions";
import {
  acknowledgeOnboardingNotice,
  getMyOnboardingNotice,
} from "@/lib/actions/onboarding-notice.actions";
import {
  RISK_NOTIFICATION_TEMPLATE_VERSION,
  recipientHash,
  retryFailedRiskNotifications,
  sendRiskNotification,
} from "@/lib/risk-intelligence/notifications";
import { RISK_INTELLIGENCE_POLICY_VERSION } from "@/lib/risk-intelligence/policy";

const NOTICE_VERSION = "onboarding-notice-1";
const NOTICE_TEXT = "Synthetic employee privacy notice text for the unit test.";

describe("governance notification and onboarding evidence", () => {
  let tenantId: string;
  let adminId: string;
  let workerId: string;

  beforeEach(async () => {
    process.env.RISK_INTELLIGENCE_SALT = "notification-salt-local-only-00000000001";
    delete process.env.EMAIL_TEST_FORCE_PROVIDER;
    delete process.env.RISK_AGREEMENT_HASHES;
    clearEmailOutbox();
    await cleanDatabase();
    const tenant = await prisma.businessTenant.create({
      data: {
        code: `NTF-${Math.random().toString(36).slice(2, 7)}`,
        name: "Notification tenant",
        status: "ACTIVE",
      },
    });
    tenantId = tenant.id;
    const admin = await prisma.user.create({
      data: {
        tenantId,
        email: `ntf-admin-${Math.random().toString(36).slice(2, 8)}@test.invalid`,
        fullName: "Notification Owner",
        role: "admin",
        status: "active",
        passwordHash: "x",
      },
    });
    adminId = admin.id;
    const worker = await prisma.user.create({
      data: {
        tenantId,
        email: `ntf-worker-${Math.random().toString(36).slice(2, 8)}@test.invalid`,
        fullName: "Synthetic Agent",
        phone: "0200000333",
        role: "worker",
        status: "active",
        passwordHash: "x",
      },
    });
    workerId = worker.id;
    ctxHolder.current = { tenantId, userId: adminId, role: "admin", modules: ["admin"] };
    adminIdForTest = adminId;
    tenantIdForTest = tenantId;
    platformHolder.current = null;
    sessionHolder.current = { userId: adminId, tenantId };
    momoHolder.current = {
      tenantId,
      userId: workerId,
      role: "worker",
      modules: ["momo"],
    };
    await prisma.riskPrivacyAccess.create({
      data: {
        userId: adminId,
        role: "privacy_admin",
        grantedById: adminId,
        reason: "Synthetic privacy administrator grant for the unit test.",
      },
    });
  });

  afterEach(() => {
    delete process.env.EMAIL_TEST_FORCE_PROVIDER;
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM_SECURITY;
    vi.unstubAllGlobals();
  });

  it("sends one idempotent notification and records metadata-only evidence", async () => {
    const first = await sendRiskNotification({
      eventType: "signal_disputed",
      scopeType: "signal",
      scopeId: "signal-1",
      tenantId,
      recipientUserId: adminId,
      reference: "SR-TEST-1",
      actorId: adminId,
    });
    const second = await sendRiskNotification({
      eventType: "signal_disputed",
      scopeType: "signal",
      scopeId: "signal-1",
      tenantId,
      recipientUserId: adminId,
      reference: "SR-TEST-1",
      actorId: adminId,
    });
    expect(first.status).toBe("skipped");
    expect(second.status).toBe("duplicate");
    expect(getEmailOutbox()).toHaveLength(1);
    const row = await prisma.governanceDocumentDelivery.findUniqueOrThrow({
      where: {
        eventType_scopeId_recipientHash: {
          eventType: "signal_disputed",
          scopeId: "signal-1",
          recipientHash: recipientHash(
            (await prisma.user.findUniqueOrThrow({ where: { id: adminId }, select: { email: true } })).email
          ),
        },
      },
    });
    expect(row.templateVersion).toBe(RISK_NOTIFICATION_TEMPLATE_VERSION);
    expect(row.status).toBe("skipped");
    expect(row.providerMessageId).toBeNull();
    expect(JSON.stringify(row)).not.toContain("@");
    expect(getEmailOutbox()[0].html).not.toContain("subjectKey");
    expect(getEmailOutbox()[0].html).not.toContain("Synthetic Agent");
  });

  it("keeps failure evidence retryable and retries without duplicating", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.EMAIL_TEST_FORCE_PROVIDER = "true";
    // Synthetic placeholders only; fetch is stubbed and no real provider is called.
    process.env.RESEND_API_KEY = "unit-test-not-a-real-key";
    process.env.EMAIL_FROM_SECURITY = "security@test.invalid";
    const failed = await sendRiskNotification({
      eventType: "signal_challenged",
      scopeType: "signal",
      scopeId: "signal-2",
      tenantId,
      recipientUserId: adminId,
      reference: "SR-TEST-2",
      actorId: adminId,
    });
    expect(failed.status).toBe("failed");
    const failedRow = await prisma.governanceDocumentDelivery.findFirstOrThrow({
      where: { eventType: "signal_challenged", scopeId: "signal-2" },
    });
    expect(failedRow.lastError).toBe("retryable");
    expect(await prisma.auditLog.count({ where: { action: "risk_notification.signal_challenged" } })).toBe(1);

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "provider-message-1" }),
    });
    const retried = await retryFailedRiskNotifications();
    expect(retried.retried).toBe(1);
    expect(retried.sent).toBe(1);
    const sentRow = await prisma.governanceDocumentDelivery.findUniqueOrThrow({
      where: { id: failedRow.id },
    });
    expect(sentRow.status).toBe("sent");
    expect(sentRow.providerMessageId).toBe("provider-message-1");
    expect(sentRow.attempts).toBe(2);
    expect(JSON.parse(sentRow.retryHistory!)).toHaveLength(2);
    expect(await prisma.governanceDocumentDelivery.count()).toBe(1);
  });

  it("records the exact notice version and hash on agent acknowledgement", async () => {
    asPlatform();
    expect(
      (
        await publishEmployeePrivacyNotice({
          version: NOTICE_VERSION,
          title: "Employee Privacy Notice",
          documentText: NOTICE_TEXT,
          effectiveDate: "2026-11-01T00:00:00.000Z",
          policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
        })
      ).success
    ).toBe(true);
    const before = await getMyOnboardingNotice();
    expect(before.data?.acknowledged).toBe(false);
    expect(before.data?.documentText).toBe(NOTICE_TEXT);

    const acknowledged = await acknowledgeOnboardingNotice({
      version: NOTICE_VERSION,
      confirmed: true,
    });
    expect(acknowledged.success, acknowledged.error).toBe(true);
    const after = await getMyOnboardingNotice();
    expect(after.data?.acknowledged).toBe(true);
    expect(after.data?.acknowledgedAt).toBeTruthy();

    const row = await prisma.employeeNoticeAttestation.findUniqueOrThrow({
      where: {
        tenantId_userId_noticeVersion: {
          tenantId,
          userId: workerId,
          noticeVersion: NOTICE_VERSION,
        },
      },
    });
    expect(row.documentSha256).toBe(createHash("sha256").update(NOTICE_TEXT).digest("hex"));
    expect(row.acknowledgedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "risk_notice.agent_acknowledged" } })).toBe(1);
  });

  it("refuses a stale notice acknowledgement", async () => {
    asPlatform();
    await publishEmployeePrivacyNotice({
      version: NOTICE_VERSION,
      title: "Employee Privacy Notice",
      documentText: NOTICE_TEXT,
      effectiveDate: "2026-11-01T00:00:00.000Z",
      policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
    });
    const result = await acknowledgeOnboardingNotice({ version: "old-version", confirmed: true });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/changed|current/i);
  });

  it("personalises the controlled employee notice with verified facts only", async () => {
    asPlatform();
    await prisma.businessTenant.update({
      where: { id: tenantId },
      data: {
        legalName: "Synthetic Notifying Business",
        registrationNumber: "CS-TEST-0001",
        address: "12 Test Street, Accra",
        contactEmail: "privacy@synthetic.invalid",
        contactPhone: "0302000000",
      },
    });
    const published = await publishControlledEmployeeNotice({
      version: "controlled-notice-1",
      effectiveDate: "2026-11-25T00:00:00.000Z",
    });
    expect(published.success, published.error).toBe(true);
    const view = await getMyOnboardingNotice();
    expect(view.success, view.error).toBe(true);
    expect(view.data?.documentText).toContain("Synthetic Agent");
    expect(view.data?.documentText).toContain("0333");
    expect(view.data?.documentText).toContain("Synthetic Notifying Business");
    expect(view.data?.documentText).not.toContain("{{");
    expect(view.data?.documentHash).toBe(
      createHash("sha256").update(view.data!.documentText).digest("hex")
    );
    const ack = await acknowledgeOnboardingNotice({
      version: "controlled-notice-1",
      confirmed: true,
    });
    expect(ack.success, ack.error).toBe(true);
    const row = await prisma.employeeNoticeAttestation.findFirstOrThrow({
      where: { tenantId, userId: workerId, noticeVersion: "controlled-notice-1" },
    });
    expect(row.documentSha256).toBe(view.data?.documentHash);
    expect(row.verified).toBe(true);
  });

  it("binds agreement execution, email evidence and exact document retrieval", async () => {
    const text = "Synthetic agreement text for the unit test.";
    const hash = createHash("sha256").update(text).digest("hex");
    process.env.RISK_AGREEMENT_HASHES = JSON.stringify({ participation_terms: hash });
    const presented = await presentParticipationAgreement({
      type: "participation_terms",
      version: "exec-1",
      effectiveDate: "2026-11-01T00:00:00.000Z",
      documentText: text,
    });
    if (!presented.success || !presented.data) throw new Error("presentation failed");
    const duplicate = await presentParticipationAgreement({
      type: "participation_terms",
      version: "exec-1",
      effectiveDate: "2026-11-01T00:00:00.000Z",
      documentText: text,
    });
    expect(duplicate.success).toBe(false);
    const accepted = await acceptParticipationAgreement({
      agreementId: presented.data.id,
      signatoryName: "Notification Owner",
      signatoryRole: "owner",
      signatoryAuthority: "authorised representative",
      authenticationMethod: "unit-test-authentication",
      authenticationEvidence: "synthetic verification record",
      acceptedDocumentSha256: hash,
    });
    expect(accepted.success, accepted.error).toBe(true);
    asPlatform();
    const executed = await countersignParticipationAgreement({ agreementId: presented.data.id });
    expect(executed.success, executed.error).toBe(true);

    const delivery = await prisma.governanceDocumentDelivery.findFirstOrThrow({
      where: { eventType: "agreement_executed", scopeId: presented.data.id },
    });
    expect(delivery.templateVersion).toBe(RISK_NOTIFICATION_TEMPLATE_VERSION);
    expect(delivery.status).toBe("skipped");
    expect(delivery.recipientUserId).toBe(adminId);

    const document = await getParticipationAgreementDocument({ id: presented.data.id });
    expect(document.success, document.error).toBe(true);
    expect(document.data?.documentText).toBe(text);
    expect(document.data?.documentSha256).toBe(hash);
    expect(document.data?.authenticationEvidence).toBe("synthetic verification record");
    expect(document.data?.state).toBe("executed");

    // Audit survives a failed delivery path and is not rewritten by a retry.
    expect(await prisma.auditLog.count({ where: { action: "risk_notification.agreement_executed" } })).toBe(1);
  });

  it("refuses agreement acceptance by another tenant and wrong document hash", async () => {
    const text = "Synthetic agreement text for the unit test.";
    const hash = createHash("sha256").update(text).digest("hex");
    process.env.RISK_AGREEMENT_HASHES = JSON.stringify({ participation_terms: hash });
    const presented = await presentParticipationAgreement({
      type: "participation_terms",
      version: "exec-2",
      effectiveDate: "2026-11-01T00:00:00.000Z",
      documentText: text,
    });
    if (!presented.success || !presented.data) throw new Error("presentation failed");
    ctxHolder.current = {
      tenantId: "someone-else",
      userId: "someone-else",
      role: "admin",
      modules: ["admin"],
    };
    const accepted = await acceptParticipationAgreement({
      agreementId: presented.data.id,
      signatoryName: "Other Person",
      signatoryRole: "owner",
      signatoryAuthority: "authorised representative",
      authenticationMethod: "unit-test-authentication",
      acceptedDocumentSha256: hash,
    });
    expect(accepted.success).toBe(false);
    const mismatch = await acceptParticipationAgreement({
      agreementId: presented.data.id,
      signatoryName: "Notification Owner",
      signatoryRole: "owner",
      signatoryAuthority: "authorised representative",
      authenticationMethod: "unit-test-authentication",
      acceptedDocumentSha256: "0".repeat(64),
    });
    expect(mismatch.success).toBe(false);
  });

  it("creates a case notification without exposing subject identity", async () => {
    asPlatform();
    await publishEmployeePrivacyNotice({
      version: NOTICE_VERSION,
      title: "Employee Privacy Notice",
      documentText: NOTICE_TEXT,
      effectiveDate: "2026-11-01T00:00:00.000Z",
      policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
    });
    const submitted = await submitSubjectRightsRequest({
      subjectUserId: workerId,
      type: "objection",
      details: "The synthetic subject objects to the shared signal.",
    });
    expect(submitted.success, submitted.error).toBe(true);
    asTenant();
    // No contributing signal exists, so no contributor message is produced.
    const acknowledged = await acknowledgeRightsRequest({
      caseRef: submitted.data!.caseRef,
      message: "The case was acknowledged by the synthetic privacy administrator.",
    });
    expect(acknowledged.success, acknowledged.error).toBe(true);
    expect(getEmailOutbox().every((message) => !message.html.includes("Synthetic Agent"))).toBe(true);
  });
});
