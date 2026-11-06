import { mfaPolicy } from "./config";
import { createMfaChallenge, type MfaMode } from "./mfa-challenge";

/**
 * Called by every login action after a correct password. Returns the challenge
 * token and mode that must be completed before a session is issued, or null
 * when no step is required.
 *
 * The challenge is returned to the calling tab, not written to a browser-wide
 * cookie. It is kept separate from the server-action module to avoid an import
 * cycle with auth.actions.ts.
 */
export async function beginMfaStepIfRequired(params: {
  subjectType: "user" | "platform" | "customer";
  subjectId: string;
  module: "admin" | "momo" | "susu" | "customer" | "platform";
  email: string;
  fullName: string;
  role: string;
  mfaEnabled: boolean;
  forcePasswordReset: boolean;
  tokenVersion: number;
}): Promise<{ mode: MfaMode; token: string } | null> {
  // Policy: when enforcement is on, EVERY account type must enrol. During the
  // controlled rollout ("optional") already-enrolled accounts still verify.
  const enforced = mfaPolicy() === "enforce";

  const mode = params.mfaEnabled ? "verify" : enforced ? "enroll" : null;
  if (!mode) return null;

  const token = await createMfaChallenge({
    subjectType: params.subjectType,
    subjectId: params.subjectId,
    module: params.module,
    email: params.email,
    fullName: params.fullName,
    mode,
    forcePasswordReset: params.forcePasswordReset,
    tokenVersion: params.tokenVersion,
  });
  return { mode, token };
}
