import { mfaPolicy } from "./config";
import { setMfaChallenge } from "./mfa-challenge";

/**
 * Called by every login action after a correct password. Returns the MFA mode
 * that must be completed before a session is issued, or null when no step is
 * required. Kept separate from the server-action module to avoid an import
 * cycle with auth.actions.ts.
 */
export async function beginMfaStepIfRequired(params: {
  subjectType: "user" | "platform";
  subjectId: string;
  module: "admin" | "momo" | "susu" | "platform";
  email: string;
  fullName: string;
  role: string;
  mfaEnabled: boolean;
  forcePasswordReset: boolean;
  tokenVersion: number;
}): Promise<"verify" | "enroll" | null> {
  const enforced =
    mfaPolicy() === "enforce" &&
    (params.subjectType === "platform" || params.role === "admin");

  const mode = params.mfaEnabled ? "verify" : enforced ? "enroll" : null;
  if (!mode) return null;

  await setMfaChallenge({
    subjectType: params.subjectType,
    subjectId: params.subjectId,
    module: params.module,
    email: params.email,
    fullName: params.fullName,
    mode,
    forcePasswordReset: params.forcePasswordReset,
    tokenVersion: params.tokenVersion,
  });
  return mode;
}
