import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { randomUUID } from "crypto";

/**
 * Short-lived MFA challenge.
 *
 * Set only AFTER a correct password, and exchanged for a real session only
 * after a valid TOTP or recovery code. It carries no authorization of its own:
 * middleware never treats it as a login, and every MFA route re-validates it.
 */

export const MFA_CHALLENGE_COOKIE = "bik-mfa-challenge";
const ISSUER = "bloomcore-one";
const AUDIENCE = "bloomcore-one:mfa-challenge";

export type MfaModule = "admin" | "momo" | "susu" | "customer" | "platform";
export type MfaMode = "verify" | "enroll";

export interface MfaChallenge {
  subjectType: "user" | "platform";
  subjectId: string;
  module: MfaModule;
  email: string;
  fullName: string;
  mode: MfaMode;
  forcePasswordReset: boolean;
  tokenVersion: number;
  tokenUse: "mfa-challenge";
  jti?: string;
}

function secret(): Uint8Array {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error("JWT_SECRET environment variable is required.");
  return new TextEncoder().encode(value);
}

export async function setMfaChallenge(
  challenge: Omit<MfaChallenge, "tokenUse" | "jti">
): Promise<void> {
  const token = await new SignJWT({
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

  const store = await cookies();
  store.set(MFA_CHALLENGE_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 5 * 60,
    priority: "high",
  });
}

export async function readMfaChallenge(): Promise<MfaChallenge | null> {
  try {
    const store = await cookies();
    const token = store.get(MFA_CHALLENGE_COOKIE)?.value;
    if (!token) return null;
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

export async function clearMfaChallenge(): Promise<void> {
  const store = await cookies();
  store.delete(MFA_CHALLENGE_COOKIE);
}
