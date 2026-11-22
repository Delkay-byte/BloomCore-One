/**
 * Server-only subject hashing for shared risk intelligence.
 *
 * Lives apart from the policy module because it needs `node:crypto`, and importing that
 * into a client graph is a hard build failure. The rule it enforces: a shared signal is
 * keyed on a salted hash, so the shared dataset cannot be read as a directory of people
 * even if it were copied out.
 */

import { createHmac } from "node:crypto";

export const RISK_SUBJECT_SALT_VERSION = 1;

/**
 * The salt is deployment configuration, never a repository constant.
 *
 * An absent salt is a hard failure rather than a silent default: a shared product keyed
 * on a default salt would let anyone recompute the hash of a phone number and reverse it.
 */
export function riskSubjectSalt(): string {
  const salt = process.env.RISK_INTELLIGENCE_SALT;
  if (!salt || salt.trim().length < 24) {
    throw new Error(
      "RISK_INTELLIGENCE_SALT is not configured. Shared risk intelligence is unavailable until it is."
    );
  }
  return salt.trim();
}

export function riskIntelligenceConfigured(): boolean {
  const salt = process.env.RISK_INTELLIGENCE_SALT;
  return Boolean(salt && salt.trim().length >= 24);
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

/**
 * The shared subject key.
 *
 * A name-only or phone-only key would collide strangers, so both are required; the name
 * is included second so two people at the same number (a family phone) stay distinct.
 */
export function hashRiskSubject(fullName: string, phone: string): {
  subjectKey: string;
  keyBasis: string;
  saltVersion: number;
} {
  const { basis, normalisedName, normalisedPhone } = normaliseSubjectIdentity(fullName, phone);
  if (normalisedName.length < 3 || normalisedPhone.length < 9) {
    throw new Error("A subject needs both a name and a mobile number to be matched.");
  }
  const subjectKey = createHmac("sha256", riskSubjectSalt())
    .update(`v${RISK_SUBJECT_SALT_VERSION}|${normalisedName}|${normalisedPhone}`)
    .digest("hex");
  return { subjectKey, keyBasis: basis, saltVersion: RISK_SUBJECT_SALT_VERSION };
}
