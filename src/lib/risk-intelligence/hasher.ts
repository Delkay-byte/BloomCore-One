/**
 * Server-only subject hashing for shared risk intelligence.
 *
 * Lives apart from the policy module because it needs `node:crypto`, and importing that
 * into a client graph is a hard build failure. The rule it enforces: a shared signal is
 * keyed on a salted HMAC, so the shared dataset cannot be read as a directory of people
 * even if it were copied out.
 *
 * Rotation: new contributions use the active key version. Queries try the active
 * version and every supported previous version. A hash is never regenerated —
 * the original identity inputs are not retained.
 */

import { createHmac } from "node:crypto";
import {
  getRiskSecretProvider,
  keyForVersion,
  riskSecretsConfigured,
} from "./secret-provider";

export const RISK_SUBJECT_SALT_VERSION = 1;

/**
 * The legacy local salt accessor. Kept for callers that expect it; new code
 * should use the provider so rotation and audit metadata are respected.
 */
export function riskSubjectSalt(): string {
  try {
    return keyForVersion(1, "configuration");
  } catch {
    throw new Error(
      "RISK_INTELLIGENCE_SALT is not configured. Shared risk intelligence is unavailable until it is."
    );
  }
}

export function riskIntelligenceConfigured(): boolean {
  return riskSecretsConfigured();
}

/**
 * Normalise the identity fields before hashing.
 *
 * Only what a business would genuinely share is used: a normalised name and a normalised
 * phone number. No national id, no photograph, no address — those would make the hash a
 * stronger identifier than the product needs.
 */
export function normaliseSubjectIdentity(fullName: string, phone: string): {
  basis: string;
  normalisedName: string;
  normalisedPhone: string;
} {
  const normalisedName = fullName
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const digits = phone.replace(/\D/g, "");
  const normalisedPhone = digits.length > 9 ? digits.slice(-9) : digits;
  return {
    basis: "name+phone",
    normalisedName,
    normalisedPhone,
  };
}

function identityBasis(fullName: string, phone: string): {
  normalisedName: string;
  normalisedPhone: string;
} {
  const { normalisedName, normalisedPhone } = normaliseSubjectIdentity(fullName, phone);
  if (normalisedName.length < 3 || normalisedPhone.length < 9) {
    throw new Error("A subject needs both a name and a mobile number to be matched.");
  }
  return { normalisedName, normalisedPhone };
}

/** Hash an identity with an explicit key version and key. */
export function hashRiskSubjectWithKey(
  fullName: string,
  phone: string,
  version: number,
  key: string
): string {
  const { normalisedName, normalisedPhone } = identityBasis(fullName, phone);
  return createHmac("sha256", key)
    .update(`v${version}|${normalisedName}|${normalisedPhone}`)
    .digest("hex");
}

/**
 * The shared subject key for a new contribution: the active provider version.
 */
export function hashRiskSubject(fullName: string, phone: string): {
  subjectKey: string;
  keyBasis: string;
  saltVersion: number;
} {
  // Validate the identity first: a bad name/phone must not be masked by a
  // configuration error, and the caller needs the actionable message.
  identityBasis(fullName, phone);
  const version = getRiskSecretProvider().activeVersion();
  let key: string;
  try {
    key = keyForVersion(version, "contribute");
  } catch {
    throw new Error(
      `RISK_INTELLIGENCE_SALT / key version ${version} is not configured. Shared risk intelligence is unavailable until it is.`
    );
  }
  return {
    subjectKey: hashRiskSubjectWithKey(fullName, phone, version, key),
    keyBasis: "name+phone",
    saltVersion: version,
  };
}

/**
 * Candidate keys for a lookup. A missing previous-version key is skipped so a
 * partial rotation cannot break matching; the active key is always attempted.
 */
export function candidateSubjectKeys(
  fullName: string,
  phone: string,
  versions?: readonly number[]
): { version: number; subjectKey: string }[] {
  const provider = getRiskSecretProvider();
  const out: { version: number; subjectKey: string }[] = [];
  for (const version of versions ?? provider.supportedVersions()) {
    const key = provider.keyFor(version);
    if (!key) continue;
    out.push({
      version,
      subjectKey: hashRiskSubjectWithKey(fullName, phone, version, key),
    });
  }
  return out;
}
