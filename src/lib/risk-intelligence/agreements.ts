/**
 * Electronic participation agreements and the participation gates.
 *
 * This module holds catalogue metadata and server-side eligibility rules. The
 * operative clause text lives in legal-instruments.ts and is rendered on the
 * server; it is never supplied by a browser. Version, effective date and
 * SHA-256 are bound to the exact rendered text at presentation time. The
 * lawyer opinion remains the authoritative source and is flagged for final
 * confirmation in docs/privacy/LEGAL-SOURCE-DISCREPANCIES.md.
 */

import { legalInstrumentMetadata } from "@/lib/risk-intelligence/legal-instruments";

export const AGREEMENT_TYPES = [
  "joint_controller",
  "participation_terms",
  "processing_addendum",
] as const;

export type AgreementType = (typeof AGREEMENT_TYPES)[number];

export interface AgreementCatalogueEntry {
  type: AgreementType;
  title: string;
  /** Populated from the executed document, never invented here. */
  version: string;
  /** Populated from the executed document, never invented here. */
  effectiveDate: string;
  sourceDocument: string;
  /** True only where the approved package makes a separate addendum applicable. */
  conditional: boolean;
}

export const AGREEMENT_CATALOGUE: readonly AgreementCatalogueEntry[] = [
  {
    ...legalInstrumentMetadata("joint_controller"),
    conditional: false,
  },
  {
    ...legalInstrumentMetadata("participation_terms"),
    conditional: false,
  },
  {
    ...legalInstrumentMetadata("processing_addendum"),
    conditional: true,
  },
];

/** The two agreements required for every share_signals or query_only scope. */
export const REQUIRED_AGREEMENT_TYPES: readonly AgreementType[] = AGREEMENT_CATALOGUE
  .filter((entry) => !entry.conditional)
  .map((entry) => entry.type);

export const ALL_AGREEMENT_TYPES: readonly AgreementType[] = AGREEMENT_CATALOGUE.map(
  (entry) => entry.type
);

/**
 * Approved document hashes come from deployment configuration, never from the
 * browser. Without them no agreement may be presented. This is deliberately
 * fail-closed: a tenant cannot present its own text as an approved agreement.
 */
export function approvedAgreementHash(type: AgreementType): string | null {
  const raw = process.env.RISK_AGREEMENT_HASHES;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[type];
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export const AGREEMENT_STATES = [
  "draft",
  "presented",
  "accepted",
  "awaiting_countersignature",
  "executed",
  "active",
  "superseded",
  "terminated",
] as const;

export type AgreementState = (typeof AGREEMENT_STATES)[number];

const TRANSITIONS: Record<AgreementState, readonly AgreementState[]> = {
  draft: ["presented"],
  presented: ["accepted"],
  accepted: ["awaiting_countersignature", "executed"],
  awaiting_countersignature: ["executed"],
  executed: ["active"],
  active: ["superseded", "terminated"],
  superseded: [],
  terminated: [],
};

export function canTransitionAgreement(
  from: AgreementState,
  to: AgreementState
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Identity and authentication bound into an electronic execution record. */
export interface AgreementExecutionBinding {
  documentVersion: string;
  documentSha256: string;
  businessId: string;
  signatoryId: string;
  signatoryName: string;
  signatoryRole: string;
  signatoryAuthority: string;
  authenticationMethod: string;
  acceptedAt: string;
  countersignedById?: string | null;
  countersignedAt?: string | null;
}

/**
 * Everything the application must verify before real signal contribution.
 *
 * Agreement acceptance alone never bypasses another gate. Employee notice
 * acknowledgement is kept separate from the business's contractual acceptance.
 */
export interface ParticipationFacts {
  businessEligibilityVerified: boolean;
  /** Recorded for accountability; it is not a condition of participation. */
  controllerRegistrationChecked: boolean;
  agreementsExecuted: boolean;
  noticeEvidenceRecorded: boolean;
  consentActive: boolean;
  policyCurrent: boolean;
  businessSuspended: boolean;
  globalEnabled: boolean;
  scope?: "share_signals" | "query_only";
}

export interface ParticipationDecision {
  contribute: boolean;
  query: boolean;
  reasons: string[];
}

export function participationEligibility(
  facts: ParticipationFacts
): ParticipationDecision {
  const reasons: string[] = [];
  if (!facts.globalEnabled) reasons.push("Global Risk Intelligence is disabled.");
  if (!facts.consentActive) reasons.push("No active participation consent.");
  if (!facts.policyCurrent) reasons.push("The accepted policy version is stale.");
  if (facts.businessSuspended) reasons.push("The business is suspended.");
  if (!facts.businessEligibilityVerified) reasons.push("Business eligibility is unverified.");
  // Controller registration is recorded separately for accountability. The
  // owner confirmed it must not be a certificate gate or a condition of use.
  if (!facts.agreementsExecuted) reasons.push("Required agreements are not executed.");

  const baseEligible = reasons.length === 0;
  if (baseEligible && !facts.noticeEvidenceRecorded) {
    reasons.push("Employee notice delivery evidence is missing.");
  }

  return {
    contribute:
      baseEligible &&
      facts.noticeEvidenceRecorded &&
      (facts.scope ?? "share_signals") === "share_signals",
    query: baseEligible,
    reasons,
  };
}
