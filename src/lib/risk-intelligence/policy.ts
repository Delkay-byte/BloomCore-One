/**
 * Shared agent risk intelligence: the policy layer.
 *
 * The idea is narrow and worth stating plainly. A dishonest agent moves to the next
 * business, where nobody knows. If businesses choose to share a *signal* — "a shortage
 * was found in this person's day and was never explained" — the next employer gets a
 * prompt to check, not a verdict and not a public accusation.
 *
 * What this layer guarantees, in code:
 *
 *   * **Opt in, or nothing.** No business is enrolled implicitly, and a business that
 *     withdraws stops contributing immediately.
 *   * **A cohort, never a whisper.** One business's claim is never shown to another.
 *     A signal is only disclosed when at least three distinct other businesses
 *     reported the same subject, and at least two reported the same category.
 *   * **No identities, no notes, no evidence.** The response carries category bands and
 *     a coarse contributor count. It never carries a name, a phone number, a note, the
 *     contributing businesses, or the underlying record.
 *   * **Never a blacklist.** There is no browsable list, no search-by-name endpoint and
 *     no "flagged" state on a person. A query must name a subject the caller already has
 *     a working relationship with, and the answer says "review", not "reject".
 *   * **Fading.** A signal expires. An event two years old cannot follow someone forever.
 *   * **Every disclosure audited.** The reader is recorded before they see the answer.
 *
 * This module is pure: no database, no clock reading, no hashing. The caller supplies
 * the facts, which makes the rules exhaustively testable.
 */

export const RISK_INTELLIGENCE_POLICY_VERSION = "risk-intelligence-policy-2026.12";
/** ENG-01: the minimum eligible, participating network before any disclosure. */
export const RISK_INTELLIGENCE_MIN_NETWORK = 20;
export const RISK_INTELLIGENCE_MIN_CONTRIBUTORS = 3;
export const RISK_INTELLIGENCE_MIN_CATEGORY_CONTRIBUTORS = 2;
export const RISK_INTELLIGENCE_MIN_CATEGORIES = 1;
export const RISK_INTELLIGENCE_DECAY_DAYS = 180;
export const RISK_INTELLIGENCE_MAX_SIGNALS_PER_SUBJECT = 12;

export const RISK_CATEGORIES = [
  "shortage",
  "repeated_shortage",
  "unreconciled_day",
  "evidence_gap",
  "unconfirmed_handover",
  "policy_breach",
] as const;

export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const RISK_CATEGORY_LABELS: Record<RiskCategory, string> = {
  shortage: "A day ended short",
  repeated_shortage: "Shortages repeated across several days",
  unreconciled_day: "A day was never reconciled",
  evidence_gap: "A day had missing supporting evidence",
  unconfirmed_handover: "A handover of cash or float was never confirmed",
  policy_breach: "A recorded policy breach",
};

export const RISK_SEVERITIES = ["high", "medium", "low"] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

export interface RiskConsentState {
  /** The business has an active consent row at the current policy version. */
  active: boolean;
  /** share_signals contributes and may query; query_only may only query. */
  scope: "share_signals" | "query_only" | null;
  policyVersion: string | null;
}

export type RiskQueryDenial =
  | "consent_missing"
  | "consent_withdrawn"
  | "policy_version_stale"
  | "agreement_missing"
  | "feature_unavailable"
  | "tenant_unavailable"
  | "role_not_permitted"
  | "subject_not_known_to_business"
  | "subject_frozen"
  | "reason_required"
  | "insufficient_network";

export const RISK_QUERY_GUIDANCE: Record<RiskQueryDenial, string> = {
  consent_missing:
    "Your business has not joined shared risk intelligence. The business owner can join from the risk intelligence page.",
  consent_withdrawn:
    "Your business withdrew from shared risk intelligence, so it neither shares nor receives signals.",
  policy_version_stale:
    "The shared risk policy has changed since your business agreed to it. The owner needs to review and accept the current version.",
  agreement_missing:
    "The required participation agreements are not executed for this business. No answer can be given, and this must not be read as a clean report.",
  feature_unavailable:
    "Shared risk intelligence is unavailable on this deployment. No answer can be given, and this must not be read as a clean report.",
  tenant_unavailable: "This business account is not currently able to use shared intelligence.",
  role_not_permitted: "Only a business owner or administrator can ask for shared risk signals.",
  subject_not_known_to_business:
    "Shared signals can only be asked about someone this business has its own record for.",
  subject_frozen:
    "This subject is under an active objection or challenge. No cross-business disclosure can be given while it is frozen; this is not a clean report.",
  reason_required: "Write why you are asking, so the request can be reviewed later.",
  insufficient_network:
    "The participating network is too small to answer safely. We cannot answer; no cross-business disclosure can be given, and this must not be read as a clean report.",
};

export interface RiskSignalFact {
  category: string;
  severity: string;
  /** The business that contributed it. Used for the cohort count, never disclosed. */
  tenantId: string;
  observedAt: string;
  expiresAt: string;
  /** open | expired | withdrawn | frozen | disputed_frozen */
  status?: string;
  /** A signal under dispute or an individual freeze is never eligible. */
  disputed?: boolean;
  frozen?: boolean;
}

export interface RiskQueryInput {
  consent: RiskConsentState;
  /** The global emergency control. Disabled means no answer at all. */
  globalEnabled: boolean;
  tenantAvailable: boolean;
  role: string;
  /** True when the caller's business has its own record of this person. */
  subjectKnownToCaller: boolean;
  /** True when the matched subject is under an active objection or challenge. */
  subjectFrozen: boolean;
  reason: string;
  /** Signals observed by the caller's own business are excluded from the cohort. */
  callerTenantId: string;
  /** Server-side network facts: active, eligible, share-signals businesses. */
  network: { activeEligibleBusinesses: number };
  /** False when a required agreement is missing; undefined is treated as satisfied. */
  agreementsExecuted?: boolean;
  signals: RiskSignalFact[];
  /** The day the query is made, so expiry is evaluated against a supplied clock. */
  asOf: string;
}

export interface RiskSignalSummary {
  category: RiskCategory;
  label: string;
  /** Coarse band, never an exact number that could identify a small market. */
  contributorBand: string;
  severity: RiskSeverity;
  mostRecentObservation: string;
}

export type RiskQueryResult =
  | { allowed: false; denial: RiskQueryDenial; guidance: string }
  | {
      allowed: true;
      /** What to do about it, in the product's own words. */
      verdict: "review_recommended" | "no_shared_signals";
      headline: string;
      signals: RiskSignalSummary[];
      contributorCount: number;
      /** Always true: a signal is a prompt to check. */
      requiresHumanJudgement: true;
      /** Always false: nothing here is a decision about a person. */
      isBlacklist: false;
      /** Always false: no identity is disclosed. */
      disclosesIdentity: false;
      notes: string[];
    };

function bandFor(count: number): string {
  if (count >= 10) return "10 or more businesses";
  if (count >= 6) return "6 to 9 businesses";
  return "3 to 5 businesses";
}

function normaliseSeverity(value: string): RiskSeverity {
  return (RISK_SEVERITIES as readonly string[]).includes(value)
    ? (value as RiskSeverity)
    : "medium";
}

function higherSeverity(left: RiskSeverity, right: RiskSeverity): RiskSeverity {
  const order: RiskSeverity[] = ["low", "medium", "high"];
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}

/**
 * Decide whether a business may be shown shared signals, and if so, what it may see.
 *
 * The checks run in the order a caller would meet them, and the first failure names the
 * actual obstacle, so a business owner is told what to do rather than that they failed.
 */
export function evaluateRiskQuery(input: RiskQueryInput): RiskQueryResult {
  // Emergency controls and network adequacy are checked before any signal is
  // read. An unavailable or undersized network is never a "clean" answer.
  if (!input.globalEnabled) {
    return { allowed: false, denial: "feature_unavailable", guidance: RISK_QUERY_GUIDANCE.feature_unavailable };
  }
  if (!input.tenantAvailable) {
    return { allowed: false, denial: "tenant_unavailable", guidance: RISK_QUERY_GUIDANCE.tenant_unavailable };
  }
  if (input.role !== "admin") {
    return { allowed: false, denial: "role_not_permitted", guidance: RISK_QUERY_GUIDANCE.role_not_permitted };
  }
  if (!input.consent.policyVersion) {
    return { allowed: false, denial: "consent_missing", guidance: RISK_QUERY_GUIDANCE.consent_missing };
  }
  if (!input.consent.active || input.consent.scope === null) {
    return { allowed: false, denial: "consent_withdrawn", guidance: RISK_QUERY_GUIDANCE.consent_withdrawn };
  }
  if (input.consent.policyVersion !== RISK_INTELLIGENCE_POLICY_VERSION) {
    return { allowed: false, denial: "policy_version_stale", guidance: RISK_QUERY_GUIDANCE.policy_version_stale };
  }
  if (input.agreementsExecuted === false) {
    return { allowed: false, denial: "agreement_missing", guidance: RISK_QUERY_GUIDANCE.agreement_missing };
  }
  if (input.subjectFrozen) {
    return { allowed: false, denial: "subject_frozen", guidance: RISK_QUERY_GUIDANCE.subject_frozen };
  }
  if (!input.subjectKnownToCaller) {
    return {
      allowed: false,
      denial: "subject_not_known_to_business",
      guidance: RISK_QUERY_GUIDANCE.subject_not_known_to_business,
    };
  }
  if (input.reason.trim().length < 10) {
    return { allowed: false, denial: "reason_required", guidance: RISK_QUERY_GUIDANCE.reason_required };
  }
  if (
    !Number.isFinite(input.network.activeEligibleBusinesses) ||
    input.network.activeEligibleBusinesses < RISK_INTELLIGENCE_MIN_NETWORK
  ) {
    return {
      allowed: false,
      denial: "insufficient_network",
      guidance: RISK_QUERY_GUIDANCE.insufficient_network,
    };
  }

  const asOf = new Date(input.asOf).getTime();
  // Only live, eligible signals count. Expired, withdrawn, disputed, frozen and
  // unknown-category signals are excluded at query time whether or not a job ran.
  const live = input.signals.filter((signal) => {
    if (signal.status && signal.status !== "open") return false;
    if (signal.disputed || signal.frozen) return false;
    if (!(RISK_CATEGORIES as readonly string[]).includes(signal.category)) return false;
    const expires = new Date(signal.expiresAt).getTime();
    return Number.isFinite(expires) && expires > asOf;
  });

  // The cohort is distinct *other* businesses. A business's own signals never
  // count towards the threshold that unlocks disclosure to it.
  const others = live.filter((signal) => signal.tenantId !== input.callerTenantId);
  const contributors = new Set(others.map((signal) => signal.tenantId));

  if (contributors.size < RISK_INTELLIGENCE_MIN_CONTRIBUTORS) {
    return {
      allowed: true,
      verdict: "no_shared_signals",
      headline:
        contributors.size === 0
          ? "No other eligible business taking part has reported a signal about this person."
          : "Not enough independent reports to share anything, so nothing is disclosed.",
      signals: [],
      contributorCount: contributors.size,
      requiresHumanJudgement: true,
      isBlacklist: false,
      disclosesIdentity: false,
      notes: [
        "This is not a clean history. It means only that no eligible business's report can be shared under the threshold rules.",
        "A single business's report is never shown to another business, because an accusation from one employer is not evidence about a person.",
      ],
    };
  }

  const byCategory = new Map<RiskCategory, { severity: RiskSeverity; latest: string; contributors: Set<string> }>();
  for (const signal of others) {
    const category = signal.category as RiskCategory;
    const current = byCategory.get(category);
    const severity = normaliseSeverity(signal.severity);
    if (!current) {
      byCategory.set(category, {
        severity,
        latest: signal.observedAt,
        contributors: new Set([signal.tenantId]),
      });
      continue;
    }
    current.severity = higherSeverity(current.severity, severity);
    if (signal.observedAt > current.latest) current.latest = signal.observedAt;
    current.contributors.add(signal.tenantId);
  }

  const signals: RiskSignalSummary[] = [...byCategory.entries()]
    .filter(([, value]) => value.contributors.size >= RISK_INTELLIGENCE_MIN_CATEGORY_CONTRIBUTORS)
    .slice(0, RISK_INTELLIGENCE_MAX_SIGNALS_PER_SUBJECT)
    .map(([category, value]) => ({
      category,
      label: RISK_CATEGORY_LABELS[category],
      contributorBand: bandFor(value.contributors.size),
      severity: value.severity,
      mostRecentObservation: value.latest,
    }));

  if (signals.length < RISK_INTELLIGENCE_MIN_CATEGORIES) {
    return {
      allowed: true,
      verdict: "no_shared_signals",
      headline:
        "Reports exist, but no single kind of problem was reported independently by enough businesses.",
      signals: [],
      contributorCount: contributors.size,
      requiresHumanJudgement: true,
      isBlacklist: false,
      disclosesIdentity: false,
      notes: [
        "This is not a clean history. It means only that no category meets the independent-contributor rule.",
        "Signals are only shared when two or more businesses describe the same kind of problem, so unrelated complaints cannot combine into an accusation.",
      ],
    };
  }

  return {
    allowed: true,
    verdict: "review_recommended",
    headline:
      "More than one business taking part has independently reported the same kind of problem. Review your own records before deciding anything.",
    signals,
    contributorCount: contributors.size,
    requiresHumanJudgement: true,
    isBlacklist: false,
    disclosesIdentity: false,
    notes: [
      "This is not a finding about this person. It is a prompt to check your own records, and the product keeps no list of flagged people.",
      "No name, phone number, note, evidence file or contributing business is disclosed here.",
      `Signals expire after ${RISK_INTELLIGENCE_DECAY_DAYS} days, so an old event cannot follow someone indefinitely.`,
    ],
  };
}

/** A contribution is only accepted from the contributing business's own closed record. */
export interface RiskContributionInput {
  consent: RiskConsentState;
  category: string;
  severity: string;
  sourceType: string;
  sourceId: string;
  /** The matrix has to be at least this long before it can be shared. */
  reasonLength: number;
  alreadyContributed: boolean;
  /** ENG-08 gates: every one must hold before a real signal is contributed. */
  businessEligibilityVerified: boolean;
  controllerRegistrationChecked: boolean;
  agreementsExecuted: boolean;
  noticeEvidenceRecorded: boolean;
  businessSuspended: boolean;
  globalEnabled: boolean;
  /** ENG-07: expelled for proven bad-faith reporting. */
  expelled?: boolean;
  /** Declared at submission; false is a hard refusal. */
  goodFaithDeclared?: boolean;
  /** Reference to supporting evidence in the closed source record. */
  evidenceReference?: string | null;
}

export type RiskContributionResult =
  | { ok: true; category: RiskCategory; severity: RiskSeverity; expiresInDays: number }
  | { ok: false; error: string };

export function validateRiskContribution(input: RiskContributionInput): RiskContributionResult {
  if (!input.globalEnabled) {
    return { ok: false, error: "Shared risk intelligence is unavailable, so nothing can be contributed." };
  }
  if (input.businessSuspended) {
    return { ok: false, error: "This business is suspended from shared risk intelligence." };
  }
  if (input.expelled) {
    return { ok: false, error: "This business has been expelled for bad-faith reporting. BloomCore must record a documented reinstatement decision." };
  }
  if (!input.consent.active || input.consent.scope !== "share_signals") {
    return {
      ok: false,
      error:
        "This business shares signals only while its owner has an active agreement. Ask the owner to join first.",
    };
  }
  if (input.consent.policyVersion !== RISK_INTELLIGENCE_POLICY_VERSION) {
    return { ok: false, error: "The shared risk policy has changed. The owner must accept the current version." };
  }
  if (!input.businessEligibilityVerified) {
    return { ok: false, error: "Business eligibility must be confirmed first. Controller registration is recorded for information and is not a participation gate." };
  }
  if (!input.agreementsExecuted) {
    return { ok: false, error: "The required participation agreements must be executed first." };
  }
  if (!input.noticeEvidenceRecorded) {
    return { ok: false, error: "Employee privacy notice delivery evidence must be recorded first." };
  }
  if (!(RISK_CATEGORIES as readonly string[]).includes(input.category)) {
    return { ok: false, error: "That is not a shareable signal type." };
  }
  if (!input.sourceId || !input.sourceType) {
    return {
      ok: false,
      error: "A signal must point at a closed record in your own business, so it can be reviewed or withdrawn.",
    };
  }
  if (input.alreadyContributed) {
    return { ok: false, error: "This record has already been shared." };
  }
  if (input.goodFaithDeclared === false) {
    return { ok: false, error: "A good-faith declaration is required before a signal can be shared." };
  }
  if (input.evidenceReference !== undefined && !input.evidenceReference?.trim()) {
    return { ok: false, error: "A reference to supporting evidence in the closed record is required." };
  }
  if (input.reasonLength < 10) {
    return { ok: false, error: "Write at least a sentence about what happened, for your own future reference." };
  }
  return {
    ok: true,
    category: input.category as RiskCategory,
    severity: normaliseSeverity(input.severity),
    expiresInDays: RISK_INTELLIGENCE_DECAY_DAYS,
  };
}

/** What the product promises on the consent screen, versioned with the policy. */
export const RISK_INTELLIGENCE_PROMISES = [
  "Your business is never enrolled without its owner accepting this policy.",
  "Only the kind of problem and a coarse count are shared. Never a name, a phone number, a note or a file.",
  "Another business's single report is never shown to you, and yours is never shown to them alone.",
  "Nothing here blocks, blacklists or publicly names anybody. A signal asks a person to check.",
  "You can withdraw at any time, which stops your signals being shared from that moment.",
  `Signals expire after ${RISK_INTELLIGENCE_DECAY_DAYS} days.`,
  "Every time a business is shown a shared signal, the disclosure is recorded.",
] as const;
