import { SignJWT, jwtVerify } from "jose";
import { randomUUID } from "crypto";

/**
 * Short-lived, single-use MFA challenge.
 *
 * The challenge is NOT a session and carries no authorization. It is returned
 * to the tab that submitted the password and supplied back to the verification
 * action from that tab's sessionStorage. There is no browser-wide MFA cookie,
 * so a challenge started in one tab cannot be completed from another tab.
 *
 * The token remains signed and time-limited (5 minutes) to prevent tampering.
 */

const ISSUER = "bloomcore-one";
const AUDIENCE = "bloomcore-one:mfa-challenge";

export type MfaModule = "admin" | "momo" | "susu" | "customer" | "platform";
export type MfaMode = "verify" | "enroll";

export interface MfaChallenge {
  subjectType: "user" | "platform" | "customer";
  subjectId: string;
  module: MfaModule;
  email: string;
  fullName: string;
  mode: MfaMode;
  forcePasswordReset: boolean;
  tokenVersion: number;
  tokenUse: "mfa-challenge";
  jti?: string;
  exp?: number;
}

function secret(): Uint8Array {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error("JWT_SECRET environment variable is required.");
  return new TextEncoder().encode(value);
}

export async function createMfaChallenge(
  challenge: Omit<MfaChallenge, "tokenUse" | "jti">
): Promise<string> {
  return new SignJWT({
    ...challenge,
    tokenUse: "mfa-challenge",
    jti: randomUUID(),
  } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(secret());
}

export async function readMfaChallenge(
  token: string | null | undefined
): Promise<MfaChallenge | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const challenge = payload as unknown as MfaChallenge;
    if (challenge.tokenUse !== "mfa-challenge") return null;
    if (challenge.mode !== "verify" && challenge.mode !== "enroll") return null;
    if (!challenge.subjectId) return null;
    return challenge;
  } catch {
    return null;
  }
}
