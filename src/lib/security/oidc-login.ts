import { randomUUID } from "crypto";
import { db } from "../db";
import {
  auditSsoEvent,
  amrHasSecondFactor,
  storeSsoRefreshToken,
} from "./oidc";
import { mfaPolicy } from "./config";
import {
  PLATFORM_AUDIT_ACTIONS,
} from "../platform-audit";
import {
  setPlatformSession,
  type PlatformSession,
} from "../platform-auth";

/**
 * Mint the NATIVE platform session for a proven SSO identity.
 *
 * Called only after the Control Center has authorised the identity (verified
 * link) and the ID token has been fully validated. The session is identical to
 * a local platform login: same JWT claims, same cookie, same SessionRecord
 * registry entry — middleware and every platform guard keep working unchanged.
 *
 * The IdP-attested amr array is mapped onto the platform token's amr literal:
 *   * any IdP second factor  → "pwd+mfa"
 *   * password only          → "pwd"
 * When MFA_ENFORCEMENT=enforce, a password-only IdP session is refused, exactly
 * like the local login path.
 */
export type SsoSignInResult =
  | { ok: true; admin: PlatformSession; forcePasswordReset: boolean }
  | {
      ok: false;
      reason: "no_link" | "inactive" | "mfa_required";
    };

export async function completeSsoSignIn(input: {
  issuer: string;
  idpSub: string;
  idpAmr: string[];
  refreshToken?: string;
}): Promise<SsoSignInResult> {
  const link = await db.platformOidcLink.findUnique({
    where: { idpSub: input.idpSub },
  });
  if (
    !link ||
    link.issuer !== input.issuer
  ) {
    await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_DENIED, {
      actorId: link?.platformAdminId ?? null,
      reason: "no_local_link",
      details: { idpSub: input.idpSub },
    });
    return { ok: false, reason: "no_link" };
  }

  const admin = await db.platformSuperAdmin.findUnique({
    where: { id: link.platformAdminId },
  });
  if (!admin || admin.status !== "active") {
    await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_DENIED, {
      actorId: link.platformAdminId,
      actorEmail: admin?.email ?? null,
      reason: admin ? "admin_inactive" : "admin_missing",
    });
    return { ok: false, reason: "inactive" };
  }

  const secondFactor = amrHasSecondFactor(input.idpAmr);
  if (mfaPolicy() === "enforce" && !secondFactor) {
    await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_DENIED, {
      actorId: admin.id,
      actorEmail: admin.email,
      reason: "mfa_required",
      details: { idpAmr: input.idpAmr },
    });
    return { ok: false, reason: "mfa_required" };
  }

  const jti = randomUUID();
  await setPlatformSession({
    adminId: admin.id,
    email: admin.email,
    fullName: admin.fullName,
    forcePasswordReset: admin.forcePasswordReset,
    tokenVersion: admin.tokenVersion,
    amr: secondFactor ? "pwd+mfa" : "pwd",
    // IdP-attested method list, carried for auditability. Not consulted by
    // guards; the mapped `amr` literal above is what middleware enforces.
    idpAmr: input.idpAmr,
    jti,
  });

  try {
    await storeSsoRefreshToken(
      jti,
      admin.id,
      input.refreshToken,
      new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    );
  } catch {
    // The platform session is valid regardless; central logout simply won't
    // have a refresh token to revoke.
  }

  await db.platformSuperAdmin.update({
    where: { id: admin.id },
    data: { lastLoginAt: new Date() },
  });

  await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_SUCCESS, {
    actorId: admin.id,
    actorEmail: admin.email,
    details: { linkedVia: link.linkedVia, idpAmr: input.idpAmr },
  });

  return {
    ok: true,
    forcePasswordReset: admin.forcePasswordReset,
    admin: {
      adminId: admin.id,
      email: admin.email,
      fullName: admin.fullName,
      forcePasswordReset: admin.forcePasswordReset,
    },
  };
}
