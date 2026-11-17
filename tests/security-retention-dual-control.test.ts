/**
 * Residual risks C, D, E and F.
 *
 * C — security-event retention and alerting never touches financial audit rows.
 * D — platform break-glass MFA recovery requires step-up, reason and (when one
 *     exists) a second platform administrator.
 * E — financial maker-checker: a second tenant administrator approves sensitive
 *     corrections, with an audited single-administrator exception.
 * F — first MFA enrolment requires a verified channel.
 *
 * Run PostgreSQL concurrency coverage in tests/pg-dual-control.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import {
  cleanDatabase,
  createTestAdmin,
  createTestCustomer,
  createTestTenant,
  prisma,
  recordContribution,
} from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name)
        ? { name, value: mockCookieStore.get(name)! }
        : undefined,
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

import { verifyPasswordAction } from "@/lib/actions/auth.actions";
import {
  reverseContribution,
  reverseWithdrawal,
} from "@/lib/actions/financial-reversal.actions";
import {
  approveFinancialApproval,
  rejectFinancialApproval,
} from "@/lib/actions/financial-approval.actions";
import {
  persistSecurityEvent,
  pruneSecurityEvents,
  raiseSecurityAlert,
  SECURITY_EVENT_RETENTION_DAYS,
} from "@/lib/security/events";
import { getEmailOutbox, clearEmailOutbox } from "@/lib/email/resend";
import { createMfaChallenge } from "@/lib/security/mfa-challenge";
import { startMfaEnrollmentAction } from "@/lib/security/mfa.actions";
import type { StepUpPurpose } from "@/lib/security/step-up";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");
const PASSWORD = "Test1234!";

async function setAdminSession(user: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Admin",
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

async function stepUpToken(
  purpose: StepUpPurpose,
  targetType: string,
  targetId: string
): Promise<string> {
  const result = await verifyPasswordAction(PASSWORD, {
    module: "admin",
    purpose,
    targetType,
    targetId,
  });
  if (!result.success) throw new Error(result.error ?? "step-up failed");
  return (result.data as { stepUpToken: string }).stepUpToken;
}

/** A tenant with one admin, one customer and one posted contribution. */
async function fixture(withSecondAdmin: boolean) {
  const tenant = await createTestTenant();
  const admin = await createTestAdmin({ tenantId: tenant.id });
  const second = withSecondAdmin
    ? await createTestAdmin({ tenantId: tenant.id })
    : null;
  const customer = await createTestCustomer(
    admin.id,
    10,
    String(Math.floor(Math.random() * 900000) + 100000)
  );
  const { contribution } = await recordContribution(
    customer.account.id,
    customer.cycle.id,
    200,
    admin.id
  );
  // The fixture helper predates tenant stamping on contributions.
  await prisma.contribution.update({
    where: { id: contribution.id },
    data: { tenantId: tenant.id },
  });
  return { tenant, admin, second, customer, contribution };
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
  clearEmailOutbox();
  vi.stubEnv("SECURITY_EVENT_PERSIST", "force");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("security event retention and alerting (residual C)", () => {
  it("retains events for 365 days and never deletes financial audit history", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });

    await persistSecurityEvent({
      event: "auth.login_failed",
      outcome: "failure",
      actorType: "anonymous",
      route: "login",
      reason: "invalid_credentials",
    });

    const stale = new Date(
      Date.now() - (SECURITY_EVENT_RETENTION_DAYS + 30) * 24 * 60 * 60 * 1000
    );
    await prisma.securityEventRecord.updateMany({ data: { createdAt: stale } });

    // Financial audit history that must survive the retention sweep.
    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        userId: admin.id,
        action: "susu.withdrawal_processed",
        entityType: "withdrawal",
        entityId: "historic-withdrawal",
      },
    });
    await prisma.platformAuditLog.create({
      data: { action: "tenant.created", entityType: "BusinessTenant", entityId: tenant.id },
    });

    const counts = await pruneSecurityEvents();
    expect(counts.events).toBe(1);
    expect(await prisma.securityEventRecord.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(1);
    // The pre-existing platform audit row survives; the sweep adds its own
    // auditable retention record on top of it.
    expect(await prisma.platformAuditLog.count()).toBe(2);
    expect(
      await prisma.platformAuditLog.count({ where: { action: "tenant.created" } })
    ).toBe(1);

    const retentionAudit = await prisma.platformAuditLog.findFirst({
      where: { action: "security.retention_pruned" },
    });
    expect(retentionAudit).not.toBeNull();
  });

  it("creates a durable alert and emails platform administrators for a critical event", async () => {
    await prisma.platformSuperAdmin.create({
      data: {
        email: "platform-alert@test.invalid",
        fullName: "Platform Owner",
        passwordHash: "$2b$12$Liry.nw.u149hj.S6S6JfexTBF7uu1EZY8StKjQTA39/jdAco3ZLK",
      },
    });
    clearEmailOutbox();
    const id = await raiseSecurityAlert({
      event: "mfa.disabled",
      severity: "critical",
      title: "MFA disabled",
      body: "An administrator disabled MFA.",
      audience: "platform",
      dedupeKey: "test-critical-alert",
    });
    expect(id).toBeTruthy();
    const row = await prisma.securityAlert.findUnique({ where: { id: id! } });
    expect(row?.emailStatus).toBe("sent");
    const outbox = getEmailOutbox();
    expect(outbox.some((mail) => mail.to === "platform-alert@test.invalid")).toBe(true);
    expect(outbox[0].text).not.toContain(PASSWORD);

    // A repeated event with the same dedupe key does not duplicate the alert.
    const again = await raiseSecurityAlert({
      event: "mfa.disabled",
      severity: "critical",
      title: "MFA disabled",
      body: "An administrator disabled MFA.",
      audience: "platform",
      dedupeKey: "test-critical-alert",
    });
    expect(again).toBe(id);
    expect(await prisma.securityAlert.count()).toBe(1);
  });
});

describe("financial maker-checker (residual E)", () => {
  it("posts immediately with an audited exception when the tenant has one administrator", async () => {
    const { admin, contribution, tenant } = await fixture(false);
    await setAdminSession(admin);
    const token = await stepUpToken(
      "susu.contribution.reverse",
      "contribution",
      contribution.id
    );

    const result = await reverseContribution({
      contributionId: contribution.id,
      reason: "Duplicate collection entry recorded by mistake",
      stepUpToken: token,
    });
    expect(result.success).toBe(true);

    const exception = await prisma.financialApproval.findFirst({
      where: { tenantId: tenant.id, action: "susu.contribution.reverse" },
    });
    expect(exception?.exceptionUsed).toBe(true);
    expect(exception?.status).toBe("consumed");
    const audit = await prisma.auditLog.findFirst({
      where: { action: "finance.dual_control_exception", tenantId: tenant.id },
    });
    expect(audit).not.toBeNull();
  });

  it("requires a different administrator when a second one exists, then posts on approval", async () => {
    const { admin, second, contribution, tenant } = await fixture(true);
    await setAdminSession(admin);
    const requesterToken = await stepUpToken(
      "susu.contribution.reverse",
      "contribution",
      contribution.id
    );

    const requested = await reverseContribution({
      contributionId: contribution.id,
      reason: "Duplicate collection entry recorded by mistake",
      stepUpToken: requesterToken,
    });
    expect(requested.success).toBe(false);
    expect(requested.requiresApproval).toBe(true);
    expect(requested.approvalId).toBeTruthy();

    // Nothing financial was posted yet.
    expect(
      await prisma.contribution.count({ where: { reversalOfId: contribution.id } })
    ).toBe(0);

    // The requester cannot approve their own request.
    const selfApproval = await approveFinancialApproval(
      requested.approvalId!,
      requesterToken
    );
    expect(selfApproval.success).toBe(false);

    // The second administrator approves with their own session and step-up.
    await setAdminSession(second!);
    const approverToken = await stepUpToken(
      "susu.contribution.reverse",
      "contribution",
      contribution.id
    );
    const approved = await approveFinancialApproval(
      requested.approvalId!,
      approverToken
    );
    expect(approved.success).toBe(true);
    expect(approved.executed).toBe(true);

    expect(
      await prisma.contribution.count({ where: { reversalOfId: contribution.id } })
    ).toBe(1);
    const approval = await prisma.financialApproval.findUnique({
      where: { id: requested.approvalId! },
    });
    expect(approval?.status).toBe("consumed");
    expect(approval?.approvedBy).toBe(second!.id);
    expect(approval?.exceptionUsed).toBe(false);
    expect(
      await prisma.auditLog.count({
        where: { tenantId: tenant.id, action: "finance.approval_applied" },
      })
    ).toBe(1);
  });

  it("rejects a replayed approval and a mismatched target", async () => {
    const { admin, second, contribution } = await fixture(true);
    await setAdminSession(admin);
    const requested = await reverseContribution({
      contributionId: contribution.id,
      reason: "Duplicate collection entry recorded by mistake",
      stepUpToken: await stepUpToken(
        "susu.contribution.reverse",
        "contribution",
        contribution.id
      ),
    });
    expect(requested.requiresApproval).toBe(true);

    await setAdminSession(second!);
    const token = await stepUpToken(
      "susu.contribution.reverse",
      "contribution",
      contribution.id
    );
    const first = await approveFinancialApproval(requested.approvalId!, token);
    expect(first.success).toBe(true);

    const replayToken = await stepUpToken(
      "susu.contribution.reverse",
      "contribution",
      contribution.id
    );
    const replay = await approveFinancialApproval(requested.approvalId!, replayToken);
    expect(replay.success).toBe(false);
    expect(
      await prisma.contribution.count({ where: { reversalOfId: contribution.id } })
    ).toBe(1);
  });

  it("lets a different administrator reject without posting", async () => {
    const { admin, second, contribution } = await fixture(true);
    await setAdminSession(admin);
    const requested = await reverseContribution({
      contributionId: contribution.id,
      reason: "Duplicate collection entry recorded by mistake",
      stepUpToken: await stepUpToken(
        "susu.contribution.reverse",
        "contribution",
        contribution.id
      ),
    });
    await setAdminSession(second!);
    const rejected = await rejectFinancialApproval(
      requested.approvalId!,
      "Please attach the customer receipt first"
    );
    expect(rejected.success).toBe(true);
    expect(
      await prisma.contribution.count({ where: { reversalOfId: contribution.id } })
    ).toBe(0);
    const row = await prisma.financialApproval.findUnique({
      where: { id: requested.approvalId! },
    });
    expect(row?.status).toBe("rejected");
  });

  it("keeps withdrawal reversals under the same control", async () => {
    const { admin, second, customer } = await fixture(true);
    const withdrawal = await prisma.withdrawal.create({
      data: {
        tenantId: (await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).tenantId,
        accountId: customer.account.id,
        cycleId: customer.cycle.id,
        requestedAmount: 50,
        commissionAmount: 0,
        netAmount: 50,
        remainingBalance: 150,
        status: "completed",
        authorizedById: admin.id,
        referenceId: `WDR-TEST-${Date.now()}`,
      },
    });
    await setAdminSession(admin);
    const requested = await reverseWithdrawal({
      withdrawalId: withdrawal.id,
      reason: "Withdrawal paid to the wrong customer record",
      stepUpToken: await stepUpToken("susu.withdrawal.reverse", "withdrawal", withdrawal.id),
    });
    expect(requested.requiresApproval).toBe(true);

    await setAdminSession(second!);
    const approved = await approveFinancialApproval(
      requested.approvalId!,
      await stepUpToken("susu.withdrawal.reverse", "withdrawal", withdrawal.id)
    );
    expect(approved.success).toBe(true);
    const original = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
    expect(original?.status).toBe("reversed");
  });
});

describe("first MFA enrolment requires a verified channel (residual F)", () => {
  async function enrollChallenge(userId: string, email: string) {
    return createMfaChallenge({
      mode: "enroll",
      subjectType: "user",
      subjectId: userId,
      email,
      fullName: "Test Admin",
      forcePasswordReset: false,
      tokenVersion: 0,
      module: "admin",
    });
  }

  it("refuses enrolment for a user whose e-mail is not verified", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    await prisma.user.update({
      where: { id: admin.id },
      data: { emailVerified: false },
    });
    const challenge = await enrollChallenge(admin.id, admin.email);
    const result = await startMfaEnrollmentAction(challenge);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Verify your e-mail address");
    expect(result.manualKey).toBeUndefined();
    const stored = await prisma.user.findUnique({
      where: { id: admin.id },
      select: { mfaPendingSecretAt: true, mfaSecret: true },
    });
    expect(stored?.mfaSecret).toBeNull();
  });

  it("allows enrolment once the address is verified", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    await prisma.user.update({
      where: { id: admin.id },
      data: { emailVerified: true },
    });
    const challenge = await enrollChallenge(admin.id, admin.email);
    const result = await startMfaEnrollmentAction(challenge);
    expect(result.success).toBe(true);
    expect(result.manualKey).toBeTruthy();
    expect(result.qrDataUrl).toContain("data:image");
  });
});
