/**
 * Single-use email verification tokens.
 *
 * The raw token exists only in the email link. The database stores a SHA-256
 * hash. Tokens are bound to one user, expire, are invalidated when reissued and
 * can be consumed once.
 */

import { createHash, randomBytes } from "crypto";
import { db } from "@/lib/db";
import { sendTransactionalEmail } from "@/lib/email/resend";
import { verificationEmail } from "@/lib/email/templates";

export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;

export function hashAccountToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateAccountToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface IssueVerificationResult {
  sent: boolean;
  cooldown?: boolean;
  reason?: "not_found" | "inactive" | "already_verified" | "send_failed" | "cooldown";
}

/**
 * Issue and send a verification email. Callers must keep the response generic;
 * this result is for audit and tests only.
 */
export async function issueEmailVerification(
  userId: string
): Promise<IssueVerificationResult> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      fullName: true,
      status: true,
      emailVerified: true,
      tenantId: true,
    },
  });
  if (!user) return { sent: false, reason: "not_found" };
  if (user.status !== "active") return { sent: false, reason: "inactive" };
  if (user.emailVerified) return { sent: false, reason: "already_verified" };

  const latest = await db.emailVerificationToken.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (
    latest &&
    Date.now() - latest.createdAt.getTime() < VERIFICATION_RESEND_COOLDOWN_MS
  ) {
    return { sent: false, cooldown: true, reason: "cooldown" };
  }

  const rawToken = generateAccountToken();
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

  await db.$transaction(async (tx) => {
    await tx.emailVerificationToken.deleteMany({
      where: { userId, usedAt: null },
    });
    await tx.emailVerificationToken.create({
      data: {
        userId,
        tenantId: user.tenantId,
        tokenHash: hashAccountToken(rawToken),
        expiresAt,
      },
    });
  });

  const template = verificationEmail({
    fullName: user.fullName,
    email: user.email,
    token: rawToken,
    expiresInHours: 24,
  });
  const delivery = await sendTransactionalEmail({
    to: user.email,
    ...template,
    tag: "email_verification",
  });

  if (!delivery.ok) {
    // Never leave a token that the user cannot receive; it would also start the
    // resend cooldown for an undelivered link.
    await db.emailVerificationToken
      .deleteMany({ where: { tokenHash: hashAccountToken(rawToken), usedAt: null } })
      .catch(() => undefined);
    return { sent: false, reason: "send_failed" };
  }
  return { sent: true };
}

export type ConsumeVerificationResult =
  | { ok: true; userId: string; alreadyVerified: boolean }
  | { ok: false; reason: "invalid" | "expired" | "used" | "inactive" };

/**
 * Consume a verification token and mark the email verified.
 *
 * The conditional update makes concurrent submissions safe: only one request
 * can turn `usedAt` from null to a timestamp.
 */
export async function consumeEmailVerification(
  rawToken: string
): Promise<ConsumeVerificationResult> {
  if (!rawToken || rawToken.length > 512) return { ok: false, reason: "invalid" };
  const tokenHash = hashAccountToken(rawToken);
  const record = await db.emailVerificationToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, expiresAt: true, usedAt: true },
  });
  if (!record) return { ok: false, reason: "invalid" };
  const user = await db.user.findUnique({
    where: { id: record.userId },
    select: { id: true, status: true, emailVerified: true },
  });
  if (record.usedAt) {
    // Idempotent for the same account: a second click after a successful
    // verification reports success, but a token consumed for an account that is
    // not verified remains invalid.
    return user?.emailVerified
      ? { ok: true, userId: record.userId, alreadyVerified: true }
      : { ok: false, reason: "used" };
  }
  if (record.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };

  if (!user || user.status !== "active") return { ok: false, reason: "inactive" };

  const consumed = await db.$transaction(async (tx) => {
    const update = await tx.emailVerificationToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (update.count !== 1) return false;
    await tx.user.update({
      where: { id: record.userId },
      data: { emailVerified: true, emailVerifiedAt: new Date() },
    });
    // Any other outstanding verification links become unusable.
    await tx.emailVerificationToken.updateMany({
      where: { userId: record.userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    return true;
  });
  if (!consumed) return { ok: false, reason: "used" };
  return { ok: true, userId: record.userId, alreadyVerified: false };
}
