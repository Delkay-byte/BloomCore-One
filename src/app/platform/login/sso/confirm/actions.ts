"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import {
  PLATFORM_AUDIT_ACTIONS,
} from "@/lib/platform-audit";
import { verifyPlatformPassword } from "@/lib/platform-auth";
import {
  confirmLinking,
  getOidcConfig,
  oidcEnabled,
  attemptExpired,
  verifyOidcBlob,
  type OidcAttempt,
  auditSsoEvent,
} from "@/lib/security/oidc";
import {
  accountThrottleKey,
  clearThrottle,
  readThrottle,
  registerFailure,
} from "@/lib/security/login-throttle";

/**
 * Link confirmation (Control Center `pending` path).
 *
 * The administrator proves the CURRENT local password for the platform
 * administrator account that matches the IdP-asserted email. On success:
 *   * the local PlatformOidcLink is created
 *   * a HMAC-SHA256 signed proof is sent to the Control Center
 *     POST /api/v1/products/bloomcore-one/linking/confirm
 *
 * No session is minted here: the administrator completes sign-in via SSO
 * afterwards, now that the link exists. Failed proofs are audited and rate
 * limited by the same account the next SSO attempt binds to.
 */

const DUMMY_HASH =
  "$2b$12$Liry.nw.u149hj.S6S6JfexTBF7uu1EZY8StKjQTA39/jdAco3ZLK"; // no timing oracle for unknown accounts

export async function confirmPlatformSsoLink(formData: FormData): Promise<void> {
  if (!oidcEnabled()) redirect("/platform/login");

  const attemptToken = String(formData.get("attempt") ?? "");
  const password = String(formData.get("password") ?? "");
  const config = getOidcConfig();

  const attempt = verifyOidcBlob<OidcAttempt>(attemptToken);
  if (!attempt || attemptExpired(attempt)) {
    redirect("/platform/login?error=sso_attempt_expired");
  }
  if (!password) {
    redirect(
      `/platform/login/sso/confirm?attempt=${encodeURIComponent(attemptToken)}&error=missing_password`
    );
  }

  const email = attempt.idpEmail.trim().toLowerCase();

  // Progressive cooldown on the account dimension, mirroring platform login.
  const throttleKey = accountThrottleKey(`sso-confirm:${email}`);
  const throttle = await readThrottle(throttleKey, Date.now());
  if (throttle.blocked) {
    redirect(
      `/platform/login/sso/confirm?attempt=${encodeURIComponent(attemptToken)}&error=throttled`
    );
  }

  const admin = await db.platformSuperAdmin.findUnique({
    where: { email },
  });
  if (!admin) {
    // Comparable work whether or not the account exists.
    await verifyPlatformPassword(password, DUMMY_HASH);
    await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_LINK_FAILED, {
      actorEmail: email,
      reason: "no_matching_local_admin",
    });
    redirect("/platform/login?error=sso_not_authorised");
  }

  const valid = await verifyPlatformPassword(password, admin.passwordHash);
  if (!valid) {
    await registerFailure([throttleKey], Date.now());
    await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_LINK_FAILED, {
      actorId: admin.id,
      actorEmail: admin.email,
      reason: "bad_password",
    });
    redirect(
      `/platform/login/sso/confirm?attempt=${encodeURIComponent(attemptToken)}&error=bad_password`
    );
  }
  await clearThrottle([throttleKey]);

  if (admin.status !== "active") {
    await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_DENIED, {
      actorId: admin.id,
      actorEmail: admin.email,
      reason: "admin_inactive",
    });
    redirect("/platform/login?error=sso_not_authorised");
  }

  // A previously created link for another admin with this sub must not exist
  // (idpSub is unique); a link for the SAME admin is idempotent.
  const existing = await db.platformOidcLink.findUnique({
    where: { idpSub: attempt.sub },
  });
  if (existing && existing.platformAdminId !== admin.id) {
    await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_LINK_FAILED, {
      actorId: admin.id,
      actorEmail: admin.email,
      reason: "sub_already_linked",
    });
    redirect("/platform/login?error=sso_not_authorised");
  }

  const link =
    existing ??
    (await db.platformOidcLink.create({
      data: {
        platformAdminId: admin.id,
        issuer: attempt.issuer,
        idpSub: attempt.sub,
        linkedVia: "local_credential_proof",
        createdBy: admin.id,
      },
    }));

  const ccOk = attempt.ccEmail
    ? await confirmLinking(config, {
        identitySub: attempt.sub,
        ccEmail: attempt.ccEmail,
        productAdminEmail: attempt.idpEmail,
      })
    : false; // no CC identity email: refuse to confirm centrally

  if (!ccOk) {
    await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_LINK_FAILED, {
      actorId: admin.id,
      actorEmail: admin.email,
      entityId: link.id,
      reason: "cc_confirm_failed",
    });
    redirect("/platform/login?error=sso_link_failed");
  }

  await auditSsoEvent(PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_LINK_CREATED, {
    actorId: admin.id,
    actorEmail: admin.email,
    entityId: link.id,
    details: { linkedVia: "local_credential_proof" },
  });

  redirect("/platform/login?notice=sso_linked");
}
