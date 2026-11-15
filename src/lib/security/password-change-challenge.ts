/**
 * Short-lived, purpose-bound password-change challenge.
 *
 * Issued only after a correct password when the account must upgrade its
 * password. It is NOT a session: no module guard accepts it, it carries no role
 * or tenant authorization, and it expires after ten minutes. It authorises one
 * action only: choose a compliant new password.
 */

import { SignJWT, jwtVerify } from "jose";
import { randomUUID } from "crypto";

const ISSUER = "bloomcore-one";
const AUDIENCE = "bloomcore-one:password-change";
const PURPOSE = "forced_password_change";
export const PASSWORD_CHANGE_CHALLENGE_TTL_SECONDS = 10 * 60;

export type PasswordChangeSubject = "user" | "customer" | "platform";

export interface PasswordChangeChallenge {
  subjectId: string;
  subjectType: PasswordChangeSubject;
  module?: "admin" | "momo" | "susu" | "customer" | "platform";
  jti?: string;
  exp?: number;
}

function secret(): Uint8Array {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error("JWT_SECRET is required");
  return new TextEncoder().encode(value);
}

export async function createPasswordChangeChallenge(
  subjectType: PasswordChangeSubject,
  subjectId: string,
  module?: PasswordChangeChallenge["module"]
): Promise<string> {
  return new SignJWT({
    purpose: PURPOSE,
    subjectType,
    subjectId,
    module,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(randomUUID())
    .setExpirationTime(`${PASSWORD_CHANGE_CHALLENGE_TTL_SECONDS / 60}m`)
    .sign(secret());
}

export async function verifyPasswordChangeChallenge(
  token: string
): Promise<PasswordChangeChallenge | null> {
  if (!token || token.length > 4096) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const claims = payload as Record<string, unknown>;
    if (claims.purpose !== PURPOSE) return null;
    if (
      claims.subjectType !== "user" &&
      claims.subjectType !== "customer" &&
      claims.subjectType !== "platform"
    ) {
      return null;
    }
    if (typeof claims.subjectId !== "string" || !claims.subjectId) return null;
    return {
      subjectType: claims.subjectType,
      subjectId: claims.subjectId,
      module:
        claims.module === "admin" ||
        claims.module === "momo" ||
        claims.module === "susu" ||
        claims.module === "customer" ||
        claims.module === "platform"
          ? claims.module
          : undefined,
      jti: typeof claims.jti === "string" ? claims.jti : undefined,
      exp: typeof claims.exp === "number" ? claims.exp : undefined,
    };
  } catch {
    return null;
  }
}
