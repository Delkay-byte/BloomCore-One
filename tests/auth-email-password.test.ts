import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { prisma, cleanDatabase } from "./setup";
import {
  adminLogin,
  completeRequiredCustomerPasswordChange,
  completeRequiredPasswordChange,
  resolveCustomerAuth,
  resolveStaffAuth,
} from "@/lib/actions/auth.actions";
import {
  completeRequiredPlatformPasswordChange,
  platformLogin,
} from "@/lib/actions/platform.actions";
import { createModuleSession, isSessionCurrent, verifyToken, type JwtPayload } from "@/lib/auth";
import { requestPasswordReset, completePasswordReset } from "@/lib/actions/password-recovery.actions";
import {
  confirmEmailVerification,
  requestVerificationEmail,
} from "@/lib/actions/email-verification.actions";
import { consumeEmailVerification, issueEmailVerification } from "@/lib/security/account-tokens";
import { verifyPasswordChangeChallenge } from "@/lib/security/password-change-challenge";
import {
  confirmMfaEnrollmentAction,
  finishMfaEnrollmentAction,
  startMfaEnrollmentAction,
  verifyMfaLoginAction,
} from "@/lib/security/mfa.actions";
import { beginMfaEnrollment, confirmMfaEnrollment } from "@/lib/security/mfa";
import { totpCode } from "@/lib/security/totp";
import { validatePasswordPolicy } from "@/lib/security/password-policy";
import { clearEmailOutbox, getEmailOutbox } from "@/lib/email/resend";

const OLD_PASSWORD = "OldPass123!";
const NEW_PASSWORD = "NewStrong!Pass123";

vi.setConfig({ testTimeout: 30_000 });

async function makeUser(overrides: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: "user@example.com",
      fullName: "Test User",
      role: "worker",
      status: "active",
      passwordHash: await bcrypt.hash(OLD_PASSWORD, 12),
      momoEnabled: true,
      emailVerified: true,
      ...overrides,
    },
  });
}

function extractToken(text: string, path: string): string {
  const match = text.match(new RegExp(`${path}\\?token=([^\\s]+)`));
  if (!match) throw new Error("Token not found in email");
  return decodeURIComponent(match[1]);
}

beforeEach(async () => {
  await cleanDatabase();
  clearEmailOutbox();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function forceProviderTest() {
  vi.stubEnv("EMAIL_TEST_FORCE_PROVIDER", "true");
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("EMAIL_FROM_SECURITY", "MaaCash <security@example.com>");
}

describe("password policy", () => {
  it("accepts only 12+ characters with upper, lower, number and symbol", () => {
    expect(validatePasswordPolicy(NEW_PASSWORD)).toBeNull();
    expect(validatePasswordPolicy("short")).toMatch(/12 characters/);
    expect(validatePasswordPolicy("alllowercase123!")).toMatch(/uppercase/);
    expect(validatePasswordPolicy("ALLUPPERCASE123!")).toMatch(/lowercase/);
    expect(validatePasswordPolicy("NoNumbers!!!Abc")).toMatch(/number/);
    expect(validatePasswordPolicy("NoSymbols123Abc")).toMatch(/symbol/);
  });
});

describe("email verification", () => {
  it("issues a hashed single-use token and verifies the account", async () => {
    const user = await makeUser({ emailVerified: false });
    const issued = await issueEmailVerification(user.id);
    expect(issued.sent).toBe(true);

    const outbox = getEmailOutbox();
    expect(outbox).toHaveLength(1);
    const token = extractToken(outbox[0].text, "/verify-email");

    const stored = await prisma.emailVerificationToken.findFirst({
      where: { userId: user.id },
    });
    expect(stored?.tokenHash).not.toBe(token);
    expect(stored?.tokenHash).toMatch(/^[a-f0-9]{64}$/);

    const first = await confirmEmailVerification(token);
    expect(first.success).toBe(true);
    // Staff and customers continue to the shared login.
    expect(first.signInPath).toBe("/login");
    const verified = await prisma.user.findUnique({ where: { id: user.id } });
    expect(verified?.emailVerified).toBe(true);
    expect(verified?.emailVerifiedAt).toBeTruthy();

    const reused = await confirmEmailVerification(token);
    // Idempotent for the same, now-verified account; it cannot verify another.
    expect(reused.success).toBe(true);
    expect(reused.verified).toBe(true);
  });

  it("sends a verified administrator to the private administrator login", async () => {
    const admin = await makeUser({ email: "owner@example.com", role: "admin", emailVerified: false });
    await issueEmailVerification(admin.id);
    const token = extractToken(getEmailOutbox()[0].text, "/verify-email");
    const result = await confirmEmailVerification(token);
    expect(result.success).toBe(true);
    expect(result.signInPath).toBe("/admin/login");
  });

  it("rejects expired and invalid tokens", async () => {
    const user = await makeUser({ emailVerified: false });
    await issueEmailVerification(user.id);
    const token = extractToken(getEmailOutbox()[0].text, "/verify-email");
    await prisma.emailVerificationToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(consumeEmailVerification(token)).resolves.toMatchObject({
      ok: false,
      reason: "expired",
    });
    await expect(consumeEmailVerification("not-a-token")).resolves.toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("enforces a resend cooldown without exposing account state", async () => {
    const user = await makeUser({ emailVerified: false });
    await issueEmailVerification(user.id);
    const second = await issueEmailVerification(user.id);
    expect(second.reason).toBe("cooldown");
    expect(getEmailOutbox()).toHaveLength(1);

    const unknown = await requestVerificationEmail("missing@example.com");
    expect(unknown.success).toBe(true);
    expect(getEmailOutbox()).toHaveLength(1);
  });

  it("does not verify or crash when Resend delivery fails", async () => {
    const user = await makeUser({ emailVerified: false });
    forceProviderTest();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const issued = await issueEmailVerification(user.id);
    expect(issued.sent).toBe(false);
    expect(issued.reason).toBe("send_failed");
    const unchanged = await prisma.user.findUnique({ where: { id: user.id } });
    expect(unchanged?.emailVerified).toBe(false);
  });

  it("blocks login until the address is verified", async () => {
    await makeUser({ emailVerified: false });
    const result = await resolveStaffAuth("user@example.com", OLD_PASSWORD, "momo");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.emailUnverified).toBe(true);
      expect(result.error).toMatch(/verify your email/i);
    }
  });
});

describe("mandatory password upgrade", () => {
  it("issues a challenge instead of a session and consumes the requirement", async () => {
    const user = await makeUser({ forcePasswordReset: true });

    const login = await resolveStaffAuth(user.email, OLD_PASSWORD, "momo");
    expect(login).toHaveProperty("passwordChangeRequired", true);
    expect(login).not.toHaveProperty("payload");
    expect(login).not.toHaveProperty("sessionToken");
    const challengeToken = (login as { challengeToken: string }).challengeToken;
    const challenge = await verifyPasswordChangeChallenge(challengeToken);
    expect(challenge?.subjectType).toBe("user");
    // The challenge is not a session and cannot pass the session verifier.
    expect(await verifyToken(challengeToken)).toBeNull();

    const weak = new FormData();
    weak.set("challengeToken", challengeToken);
    weak.set("newPassword", "weak");
    weak.set("confirmPassword", "weak");
    expect((await completeRequiredPasswordChange(weak)).success).toBe(false);

    const strong = new FormData();
    strong.set("challengeToken", challengeToken);
    strong.set("newPassword", NEW_PASSWORD);
    strong.set("confirmPassword", NEW_PASSWORD);
    const changed = await completeRequiredPasswordChange(strong);
    expect(changed.success).toBe(true);
    expect(changed).not.toHaveProperty("sessionToken");

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.forcePasswordReset).toBe(false);
    expect(updated?.passwordPolicyVersion).toBe(1);

    // The same challenge cannot perform a second change.
    const replay = await completeRequiredPasswordChange(strong);
    expect(replay.success).toBe(false);

    const nextLogin = await resolveStaffAuth(user.email, NEW_PASSWORD, "momo");
    expect("payload" in nextLogin).toBe(true);
    const oldLogin = await resolveStaffAuth(user.email, OLD_PASSWORD, "momo");
    expect("error" in oldLogin).toBe(true);
  });

  it("applies to the administrator login entry point", async () => {
    const admin = await makeUser({
      email: "admin@example.com",
      role: "admin",
      momoEnabled: false,
      forcePasswordReset: true,
    });
    const form = new FormData();
    form.set("email", admin.email);
    form.set("password", OLD_PASSWORD);
    const result = await adminLogin(form);
    expect(result).toMatchObject({ success: true, passwordChangeRequired: true });
    expect(result).not.toHaveProperty("sessionToken");
  });
});

describe("password reset email", () => {
  it("returns a generic response and sends only to a verified account", async () => {
    await makeUser({ email: "verified@example.com", emailVerified: true });
    await makeUser({ email: "unverified@example.com", emailVerified: false });

    const unknown = await requestPasswordReset("nobody@example.com");
    expect(unknown).toEqual({ success: true });
    expect(getEmailOutbox()).toHaveLength(0);

    const unverified = await requestPasswordReset("unverified@example.com");
    expect(unverified).toEqual({ success: true });
    expect(getEmailOutbox()).toHaveLength(0);

    const verified = await requestPasswordReset("verified@example.com");
    expect(verified).toEqual({ success: true });
    expect(getEmailOutbox()).toHaveLength(1);
    expect(getEmailOutbox()[0].text).toContain("/reset-password?token=");
    expect(JSON.stringify(verified)).not.toContain("token=");
  });

  it("changes the password, revokes the old one and consumes the token", async () => {
    const user = await makeUser({ email: "reset@example.com", forcePasswordReset: true });
    await requestPasswordReset(user.email);
    const token = extractToken(getEmailOutbox()[0].text, "/reset-password");

    const weak = await completePasswordReset({
      token,
      newPassword: "short",
      confirmPassword: "short",
    });
    expect(weak.success).toBe(false);

    const changed = await completePasswordReset({
      token,
      newPassword: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });
    expect(changed.success).toBe(true);

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.forcePasswordReset).toBe(false);
    expect(updated?.passwordPolicyVersion).toBe(1);
    expect(await bcrypt.compare(OLD_PASSWORD, updated!.passwordHash)).toBe(false);
    expect(await bcrypt.compare(NEW_PASSWORD, updated!.passwordHash)).toBe(true);

    const reused = await completePasswordReset({
      token,
      newPassword: "Another!Pass1234",
      confirmPassword: "Another!Pass1234",
    });
    expect(reused.success).toBe(false);
    expect(reused.error).toMatch(/already been used|invalid or has expired/i);
  });

  it("does not leave a usable reset token when delivery fails", async () => {
    const user = await makeUser({ emailVerified: true });
    forceProviderTest();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const response = await requestPasswordReset(user.email);
    expect(response).toEqual({ success: true });
    expect(
      await prisma.passwordResetToken.count({ where: { userId: user.id, usedAt: null } })
    ).toBe(0);
  });

  it("cannot reset another tenant's account from a token", async () => {
    const tenantA = await prisma.businessTenant.create({
      data: { code: "TEN-A", name: "Tenant A" },
    });
    const tenantB = await prisma.businessTenant.create({
      data: { code: "TEN-B", name: "Tenant B" },
    });
    const userA = await makeUser({
      email: "a@example.com",
      tenantId: tenantA.id,
    });
    await makeUser({ email: "b@example.com", tenantId: tenantB.id });

    await requestPasswordReset(userA.email);
    const token = extractToken(getEmailOutbox()[0].text, "/reset-password");
    await completePasswordReset({
      token,
      newPassword: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });

    const a = await prisma.user.findUnique({ where: { id: userA.id } });
    const b = await prisma.user.findUnique({ where: { email: "b@example.com" } });
    expect(a?.passwordPolicyVersion).toBe(1);
    expect(await bcrypt.compare(NEW_PASSWORD, b!.passwordHash)).toBe(false);
    expect(a?.tenantId).toBe(tenantA.id);
    expect(b?.tenantId).toBe(tenantB.id);
  });
});

describe("MFA is never bypassed by the mandatory password upgrade", () => {
  async function enrollMfa(user: { id: string; email: string }) {
    const started = await beginMfaEnrollment({
      subjectType: "user",
      subjectId: user.id,
      accountName: user.email,
    });
    const confirmed = await confirmMfaEnrollment({
      subjectType: "user",
      subjectId: user.id,
      code: totpCode(started.secret),
    });
    if (!confirmed) throw new Error("MFA enrolment failed");
    return { secret: started.secret, recoveryCodes: confirmed.recoveryCodes };
  }

  it("requires MFA verification before issuing the password-change challenge", async () => {
    vi.stubEnv("MFA_ENFORCEMENT", "enforce");
    const user = await makeUser({
      forcePasswordReset: true,
      mfaEnabled: false,
    });
    const mfa = await enrollMfa(user);

    const login = await resolveStaffAuth(user.email, OLD_PASSWORD, "momo");
    expect(login).toHaveProperty("mfa", "verify");
    expect(login).not.toHaveProperty("challengeToken");
    expect(login).not.toHaveProperty("payload");
    const mfaToken = (login as { mfaToken: string }).mfaToken;

    const verification = new FormData();
    verification.set("challenge", mfaToken);
    verification.set("code", mfa.recoveryCodes[0]);
    const verified = await verifyMfaLoginAction(verification);
    expect(verified.success).toBe(true);
    expect(verified.passwordChangeRequired).toBe(true);
    expect(verified.challengeToken).toBeTruthy();
    expect(verified.sessionToken).toBeUndefined();

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.forcePasswordReset).toBe(true);

    const change = new FormData();
    change.set("challengeToken", verified.challengeToken!);
    change.set("newPassword", NEW_PASSWORD);
    change.set("confirmPassword", NEW_PASSWORD);
    expect((await completeRequiredPasswordChange(change)).success).toBe(true);
  });

  it("requires MFA enrolment before the password-change challenge", async () => {
    vi.stubEnv("MFA_ENFORCEMENT", "enforce");
    const user = await makeUser({ forcePasswordReset: true, mfaEnabled: false });

    const login = await resolveStaffAuth(user.email, OLD_PASSWORD, "momo");
    expect(login).toHaveProperty("mfa", "enroll");
    const mfaToken = (login as { mfaToken: string }).mfaToken;

    const started = await startMfaEnrollmentAction(mfaToken);
    expect(started.success).toBe(true);
    expect(started.manualKey).toBeTruthy();

    const confirm = new FormData();
    confirm.set("challenge", mfaToken);
    confirm.set("code", totpCode(started.manualKey!));
    const confirmed = await confirmMfaEnrollmentAction(confirm);
    expect(confirmed.success).toBe(true);

    const finish = new FormData();
    finish.set("challenge", mfaToken);
    const finished = await finishMfaEnrollmentAction(finish);
    expect(finished.success).toBe(true);
    expect(finished.passwordChangeRequired).toBe(true);
    expect(finished.challengeToken).toBeTruthy();
    expect(finished.sessionToken).toBeUndefined();
  });

  it("still enforces MFA after the upgrade when the user signs in again", async () => {
    vi.stubEnv("MFA_ENFORCEMENT", "enforce");
    const user = await makeUser({ forcePasswordReset: true, mfaEnabled: false });
    const mfa = await enrollMfa(user);

    const first = await resolveStaffAuth(user.email, OLD_PASSWORD, "momo");
    const mfaToken = (first as { mfaToken: string }).mfaToken;
    const verify = new FormData();
    verify.set("challenge", mfaToken);
    verify.set("code", mfa.recoveryCodes[0]);
    const verified = await verifyMfaLoginAction(verify);
    const change = new FormData();
    change.set("challengeToken", verified.challengeToken!);
    change.set("newPassword", NEW_PASSWORD);
    change.set("confirmPassword", NEW_PASSWORD);
    expect((await completeRequiredPasswordChange(change)).success).toBe(true);

    const second = await resolveStaffAuth(user.email, NEW_PASSWORD, "momo");
    expect(second).toHaveProperty("mfa", "verify");
    expect(second).not.toHaveProperty("payload");

    const secondVerify = new FormData();
    secondVerify.set("challenge", (second as { mfaToken: string }).mfaToken);
    secondVerify.set("code", mfa.recoveryCodes[1]);
    const session = await verifyMfaLoginAction(secondVerify);
    expect(session.success).toBe(true);
    expect(session.sessionToken).toBeTruthy();
    expect(session.passwordChangeRequired).toBeUndefined();
  });

  it("issues the challenge directly when the MFA policy is optional and no MFA is enrolled", async () => {
    vi.stubEnv("MFA_ENFORCEMENT", "optional");
    const user = await makeUser({ forcePasswordReset: true, mfaEnabled: false });
    const login = await resolveStaffAuth(user.email, OLD_PASSWORD, "momo");
    expect(login).toHaveProperty("passwordChangeRequired", true);
    expect(login).not.toHaveProperty("mfa");
    expect(login).not.toHaveProperty("payload");
  });

  it("rejects an expired challenge and a challenge used on the wrong account type", async () => {
    const user = await makeUser({ forcePasswordReset: true });
    const login = await resolveStaffAuth(user.email, OLD_PASSWORD, "momo");
    const challengeToken = (login as { challengeToken: string }).challengeToken;

    const realNow = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(realNow + 11 * 60 * 1000);
    try {
      const form = new FormData();
      form.set("challengeToken", challengeToken);
      form.set("newPassword", NEW_PASSWORD);
      form.set("confirmPassword", NEW_PASSWORD);
      const expired = await completeRequiredPasswordChange(form);
      expect(expired.success).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    const customer = await prisma.customer.create({
      data: {
        customerId: `BIK-C-WRONG-${Date.now()}`,
        fullName: "Wrong Type",
        status: "active",
        portalEnabled: true,
        portalPasswordHash: await bcrypt.hash(OLD_PASSWORD, 12),
        forcePortalPasswordReset: true,
      },
    });
    const customerLogin = await resolveCustomerAuth(customer.customerId, OLD_PASSWORD);
    const customerChallenge = (customerLogin as { challengeToken: string })
      .challengeToken;
    const wrongAction = new FormData();
    wrongAction.set("challengeToken", customerChallenge);
    wrongAction.set("newPassword", NEW_PASSWORD);
    wrongAction.set("confirmPassword", NEW_PASSWORD);
    expect((await completeRequiredPasswordChange(wrongAction)).success).toBe(false);

    const platformForm = new FormData();
    platformForm.set("challengeToken", challengeToken);
    platformForm.set("newPassword", NEW_PASSWORD);
    platformForm.set("confirmPassword", NEW_PASSWORD);
    expect((await completeRequiredPlatformPasswordChange(platformForm)).success).toBe(
      false
    );
  });

  it("does not clear the flag on a failed upgrade and cannot upgrade another account", async () => {
    const first = await makeUser({ email: "first@example.com", forcePasswordReset: true });
    const second = await makeUser({ email: "second@example.com", forcePasswordReset: true });
    const login = await resolveStaffAuth(first.email, OLD_PASSWORD, "momo");
    const challengeToken = (login as { challengeToken: string }).challengeToken;

    const weak = new FormData();
    weak.set("challengeToken", challengeToken);
    weak.set("newPassword", "weak");
    weak.set("confirmPassword", "weak");
    expect((await completeRequiredPasswordChange(weak)).success).toBe(false);
    expect(
      (await prisma.user.findUnique({ where: { id: first.id } }))?.forcePasswordReset
    ).toBe(true);

    const strong = new FormData();
    strong.set("challengeToken", challengeToken);
    strong.set("newPassword", NEW_PASSWORD);
    strong.set("confirmPassword", NEW_PASSWORD);
    expect((await completeRequiredPasswordChange(strong)).success).toBe(true);

    const secondAfter = await prisma.user.findUnique({ where: { id: second.id } });
    expect(secondAfter?.forcePasswordReset).toBe(true);
    expect(await bcrypt.compare(OLD_PASSWORD, secondAfter!.passwordHash)).toBe(true);
  });
});

describe("all authentication entry points enforce the upgrade", () => {
  it("customer login returns a challenge and completes without a session", async () => {
    const customer = await prisma.customer.create({
      data: {
        customerId: "BIK-C-900001",
        fullName: "Portal Customer",
        phone: "+233240009001",
        status: "active",
        portalEnabled: true,
        portalPasswordHash: await bcrypt.hash(OLD_PASSWORD, 12),
        forcePortalPasswordReset: true,
      },
    });

    const login = await resolveCustomerAuth(customer.customerId, OLD_PASSWORD);
    expect(login).toHaveProperty("passwordChangeRequired", true);
    expect(login).not.toHaveProperty("payload");
    const challengeToken = (login as { challengeToken: string }).challengeToken;

    const form = new FormData();
    form.set("challengeToken", challengeToken);
    form.set("newPassword", NEW_PASSWORD);
    form.set("confirmPassword", NEW_PASSWORD);
    const changed = await completeRequiredCustomerPasswordChange(form);
    expect(changed.success).toBe(true);

    const updated = await prisma.customer.findUnique({ where: { id: customer.id } });
    expect(updated?.forcePortalPasswordReset).toBe(false);
    expect(updated?.passwordPolicyVersion).toBe(1);
    expect(await bcrypt.compare(NEW_PASSWORD, updated!.portalPasswordHash!)).toBe(true);
  });

  it("platform login returns a challenge and completes without a session", async () => {
    const admin = await prisma.platformSuperAdmin.create({
      data: {
        email: "platform@example.com",
        fullName: "Platform Operator",
        passwordHash: await bcrypt.hash(OLD_PASSWORD, 12),
        forcePasswordReset: true,
      },
    });

    const form = new FormData();
    form.set("email", admin.email);
    form.set("password", OLD_PASSWORD);
    const login = await platformLogin(form);
    if (!login) throw new Error("platform login returned no response");
    expect(login).toMatchObject({ success: true, passwordChangeRequired: true });
    expect(login).not.toHaveProperty("sessionToken");
    const challengeToken = login.challengeToken!;

    const change = new FormData();
    change.set("challengeToken", challengeToken);
    change.set("newPassword", NEW_PASSWORD);
    change.set("confirmPassword", NEW_PASSWORD);
    const changed = await completeRequiredPlatformPasswordChange(change);
    expect(changed.success).toBe(true);

    const updated = await prisma.platformSuperAdmin.findUnique({
      where: { id: admin.id },
    });
    expect(updated?.forcePasswordReset).toBe(false);
    expect(updated?.passwordPolicyVersion).toBe(1);
  });

  it("rejects a live session while a mandatory password upgrade is pending", async () => {
    const user = await makeUser({ forcePasswordReset: true, tokenVersion: 4 });
    const token = await createModuleSession("momo", {
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      role: "worker",
      modules: ["momo"],
      module: "momo",
      tenantId: user.tenantId,
      forcePasswordReset: true,
      tokenVersion: user.tokenVersion,
    });
    const payload = await verifyToken<JwtPayload>(token);
    expect(payload).not.toBeNull();
    // The upgrade cannot be skipped by keeping a session that predates the
    // flag: the challenge flow issues a fresh session only after completion.
    expect(await isSessionCurrent(payload!)).toBe(false);
  });

  it("rejects a session for an unverified account", async () => {
    const user = await makeUser({ emailVerified: false });
    const token = await createModuleSession("momo", {
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      role: "worker",
      modules: ["momo"],
      module: "momo",
      tenantId: user.tenantId,
      tokenVersion: user.tokenVersion,
    });
    const payload = await verifyToken<JwtPayload>(token);
    expect(await isSessionCurrent(payload!)).toBe(false);
  });

  it("rejects a live customer portal session while a portal upgrade is pending", async () => {
    const customer = await prisma.customer.create({
      data: {
        customerId: "CUST-SEC-02",
        fullName: "Portal Customer",
        phone: "0200000000",
        status: "active",
        portalEnabled: true,
        portalPasswordHash: await bcrypt.hash(OLD_PASSWORD, 12),
        forcePortalPasswordReset: true,
        tokenVersion: 2,
      },
    });
    const token = await createModuleSession("customer", {
      userId: customer.id,
      email: "portal@example.com",
      fullName: customer.fullName,
      role: "customer",
      modules: ["customer"],
      module: "customer",
      tenantId: customer.tenantId,
      forcePasswordReset: true,
      tokenVersion: customer.tokenVersion ?? 0,
    });
    const payload = await verifyToken<JwtPayload>(token);
    expect(payload).not.toBeNull();
    expect(await isSessionCurrent(payload!)).toBe(false);
  });
});
