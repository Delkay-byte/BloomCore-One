/**
 * Shared agent risk intelligence — DPC governance safeguards.
 *
 * Pure, code-level regression coverage for ENG-01..ENG-08. No database is
 * provisioned here: every rule is exercised against supplied facts so the
 * thresholds remain testable without touching the application database.
 */

import { describe, expect, it } from "vitest";
import {
  RISK_INTELLIGENCE_MIN_NETWORK,
  RISK_INTELLIGENCE_POLICY_VERSION,
  evaluateRiskQuery,
  validateRiskContribution,
  type RiskConsentState,
  type RiskQueryInput,
  type RiskSignalFact,
} from "@/lib/risk-intelligence/policy";
import {
  RISK_AUDIT_RETENTION_MONTHS,
  RISK_LEGAL_HOLD_REVIEW_DAYS,
  addMonthsUtc,
  riskAuditDeletionDeadline,
  signalDeletionDeadline,
  legalHoldDeadline,
} from "@/lib/risk-intelligence/retention";
import {
  RIGHTS_ACK_BUSINESS_DAYS,
  RIGHTS_EXTENSION_CALENDAR_DAYS,
  RIGHTS_RESOLUTION_CALENDAR_DAYS,
  addBusinessDays,
  applyRightsExtension,
  computeRightsDeadlines,
  isOverdue,
} from "@/lib/risk-intelligence/subject-rights";
import {
  candidateKeyVersions,
  retirementPlan,
} from "@/lib/risk-intelligence/key-rotation";
import {
  DISCLOSURE_EXPLANATION,
  NOTICE_ACKNOWLEDGEMENT_IS_NOT_CONSENT,
} from "@/lib/risk-intelligence/notices";
import {
  AGREEMENT_CATALOGUE,
  AGREEMENT_STATES,
  canTransitionAgreement,
  participationEligibility,
  type ParticipationFacts,
} from "@/lib/risk-intelligence/agreements";

const consent: RiskConsentState = {
  active: true,
  scope: "share_signals",
  policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
};

function signal(overrides: Partial<RiskSignalFact> = {}): RiskSignalFact {
  return {
    category: "repeated_shortage",
    severity: "high",
    tenantId: "biz-a",
    observedAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2027-05-01T00:00:00.000Z",
    status: "open",
    ...overrides,
  };
}

function baseInput(overrides: Partial<RiskQueryInput> = {}): RiskQueryInput {
  return {
    consent,
    tenantAvailable: true,
    globalEnabled: true,
    role: "admin",
    subjectKnownToCaller: true,
    reason: "Considering this person for a counter role",
    callerTenantId: "biz-viewer",
    subjectFrozen: false,
    network: { activeEligibleBusinesses: RISK_INTELLIGENCE_MIN_NETWORK },
    asOf: "2026-12-01T00:00:00.000Z",
    signals: [],
    ...overrides,
  };
}

function cohort(count: number, category = "repeated_shortage"): RiskSignalFact[] {
  return Array.from({ length: count }, (_, index) =>
    signal({ tenantId: `biz-${index}`, category })
  );
}

describe("ENG-01 — minimum participating network", () => {
  it("refuses to answer below twenty eligible businesses", () => {
    const result = evaluateRiskQuery(
      baseInput({
        network: { activeEligibleBusinesses: RISK_INTELLIGENCE_MIN_NETWORK - 1 },
        signals: cohort(5),
      })
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.denial).toBe("insufficient_network");
      expect(result.guidance).toMatch(/cannot answer/i);
    }
  });

  it("progresses at exactly twenty eligible businesses", () => {
    const result = evaluateRiskQuery(
      baseInput({
        network: { activeEligibleBusinesses: RISK_INTELLIGENCE_MIN_NETWORK },
        signals: cohort(3),
      })
    );
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.verdict).toBe("review_recommended");
  });

  it("requires three distinct other contributors and two per disclosed category", () => {
    const two = evaluateRiskQuery(baseInput({ signals: cohort(2) }));
    if (!two.allowed) throw new Error(two.denial);
    expect(two.verdict).toBe("no_shared_signals");

    const mixed = evaluateRiskQuery(
      baseInput({
        signals: [
          signal({ tenantId: "biz-a", category: "shortage" }),
          signal({ tenantId: "biz-b", category: "evidence_gap" }),
          signal({ tenantId: "biz-c", category: "unreconciled_day" }),
        ],
      })
    );
    if (!mixed.allowed) throw new Error(mixed.denial);
    expect(mixed.signals).toHaveLength(0);

    const withCaller = evaluateRiskQuery(
      baseInput({
        signals: [
          signal({ tenantId: "biz-viewer" }),
          signal({ tenantId: "biz-a" }),
          signal({ tenantId: "biz-b" }),
        ],
      })
    );
    if (!withCaller.allowed) throw new Error(withCaller.denial);
    expect(withCaller.contributorCount).toBe(2);
    expect(withCaller.signals).toHaveLength(0);
  });

  it("excludes expired, withdrawn, frozen and disputed signals", () => {
    const result = evaluateRiskQuery(
      baseInput({
        signals: [
          signal({ tenantId: "biz-a", status: "expired" }),
          signal({ tenantId: "biz-b", status: "withdrawn" }),
          signal({ tenantId: "biz-c", status: "frozen" }),
          signal({ tenantId: "biz-d", status: "disputed_frozen" }),
          signal({ tenantId: "biz-e", expiresAt: "2026-11-30T00:00:00.000Z" }),
        ],
      })
    );
    if (!result.allowed) throw new Error(result.denial);
    expect(result.verdict).toBe("no_shared_signals");
    expect(result.contributorCount).toBe(0);
  });

  it("never renders an insufficient network as a clean history", () => {
    const result = evaluateRiskQuery(
      baseInput({ network: { activeEligibleBusinesses: 6 }, signals: [] })
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.guidance).toMatch(/must not be read as a clean report/i);
    }
  });
});

describe("ENG-02 / ENG-07 — frozen subjects and explicit unavailable states", () => {
  it("refuses disclosure while a subject is frozen", () => {
    const result = evaluateRiskQuery(
      baseInput({ subjectFrozen: true, signals: cohort(3) })
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.denial).toBe("subject_frozen");
  });

  it("refuses disclosure when the global control is disabled", () => {
    const result = evaluateRiskQuery(baseInput({ globalEnabled: false }));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.denial).toBe("feature_unavailable");
      expect(result.guidance).toMatch(/not.*clean|do not read/i);
    }
  });

  it("refuses disclosure when the tenant is suspended", () => {
    const result = evaluateRiskQuery(baseInput({ tenantAvailable: false }));
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.denial).toBe("tenant_unavailable");
  });
});

describe("ENG-03 — subject rights service levels", () => {
  it("counts three business days for acknowledgement", () => {
    // Friday 2026-11-20 -> Monday 2026-11-23 is business day 1.
    expect(addBusinessDays("2026-11-20T09:00:00.000Z", 3)).toBe("2026-11-25T09:00:00.000Z");
  });

  it("skips a gazetted Ghana public holiday in the acknowledgement clock", () => {
    // Wednesday 2026-12-23 -> Thu 24 is day 1, Fri 25 (Christmas) is skipped,
    // Mon 28 is the observed Boxing Day holiday (26 December is a Saturday),
    // Tue 29 is day 2 and Wed 30 is day 3.
    const deadlines = computeRightsDeadlines("2026-12-23T09:00:00.000Z");
    expect(deadlines.ackDeadline).toBe("2026-12-30T09:00:00.000Z");
    expect(deadlines.holidayCalendarVersion).toMatch(/^gh-act601-/);
  });

  it("sets a 21-day resolution and one 14-day extension", () => {
    const deadlines = computeRightsDeadlines("2026-11-24T09:00:00.000Z");
    expect(deadlines.ackDeadline).toBe("2026-11-27T09:00:00.000Z");
    expect(deadlines.resolutionDeadline).toBe("2026-12-15T09:00:00.000Z");
    const extended = applyRightsExtension(deadlines.resolutionDeadline, "Written privacy reason");
    expect(extended).toBe("2026-12-29T09:00:00.000Z");
    expect(RIGHTS_ACK_BUSINESS_DAYS).toBe(3);
    expect(RIGHTS_RESOLUTION_CALENDAR_DAYS).toBe(21);
    expect(RIGHTS_EXTENSION_CALENDAR_DAYS).toBe(14);
  });

  it("tracks overdue deadlines", () => {
    expect(isOverdue("2026-12-01T00:00:00.000Z", "2026-12-02T00:00:00.000Z")).toBe(true);
    expect(isOverdue("2026-12-03T00:00:00.000Z", "2026-12-02T00:00:00.000Z")).toBe(false);
  });
});

describe("ENG-04 — retention, deletion and legal holds", () => {
  it("deletes signals ninety days after the applicable trigger", () => {
    expect(
      signalDeletionDeadline({ status: "expired", expiresAt: "2027-05-05T00:00:00.000Z" })
    ).toBe("2027-08-03T00:00:00.000Z");
    expect(
      signalDeletionDeadline({
        status: "withdrawn",
        expiresAt: "2027-05-05T00:00:00.000Z",
        withdrawnAt: "2026-12-01T00:00:00.000Z",
      })
    ).toBe("2027-03-01T00:00:00.000Z");
    expect(
      signalDeletionDeadline({
        status: "disputed_frozen",
        expiresAt: "2027-05-05T00:00:00.000Z",
        resolvedAt: "2026-12-20T00:00:00.000Z",
      })
    ).toBe("2027-03-20T00:00:00.000Z");
  });

  it("keeps disclosure audit records for twenty-four months", () => {
    expect(RISK_AUDIT_RETENTION_MONTHS).toBe(24);
    expect(riskAuditDeletionDeadline("2026-01-31T00:00:00.000Z")).toBe(
      "2028-01-31T00:00:00.000Z"
    );
    expect(addMonthsUtc("2026-01-31T00:00:00.000Z", 1)).toBe("2026-02-28T00:00:00.000Z");
  });

  it("applies and releases a scoped legal hold", () => {
    const deadline = "2027-01-01T00:00:00.000Z";
    expect(legalHoldDeadline(deadline, null)).toBe(deadline);
    expect(
      legalHoldDeadline(deadline, {
        active: true,
        reviewDate: "2027-06-01T00:00:00.000Z",
        extensionUntil: null,
      })
    ).toBeNull();
    expect(
      legalHoldDeadline(deadline, {
        active: true,
        reviewDate: "2027-06-01T00:00:00.000Z",
        extensionUntil: "2027-09-01T00:00:00.000Z",
      })
    ).toBe("2027-09-01T00:00:00.000Z");
    expect(RISK_LEGAL_HOLD_REVIEW_DAYS).toBe(14);
  });
});

describe("ENG-05 — dual key rotation", () => {
  it("matches against current and previous key versions only", () => {
    // Version 1 is retired; only the active key and its supported predecessor
    // are candidate keys. The caller supplies the supported set explicitly.
    expect(candidateKeyVersions(3, [2, 3])).toEqual([3, 2]);
    expect(candidateKeyVersions(3, [3, 2, 2])).toEqual([3, 2]);
    expect(candidateKeyVersions(3, [3])).toEqual([3]);
  });

  it("requires an explicit retirement decision", () => {
    expect(retirementPlan({ active: 3, previous: [2], retired: [] })).toContain(2);
    expect(retirementPlan({ active: 3, previous: [2], retired: [1] })).not.toContain(1);
  });
});

describe("ENG-06 — notices and disclosure explanation", () => {
  it("states that acknowledgement is not consent", () => {
    expect(NOTICE_ACKNOWLEDGEMENT_IS_NOT_CONSENT).toMatch(/not consent/i);
    expect(NOTICE_ACKNOWLEDGEMENT_IS_NOT_CONSENT).toMatch(/rights/i);
  });

  it("explains every required disclosure limitation", () => {
    const text = DISCLOSURE_EXPLANATION.join(" ");
    expect(text).toMatch(/operational review prompt/i);
    expect(text).toMatch(/not proof of misconduct/i);
    expect(text).toMatch(/not a blacklist/i);
    expect(text).toMatch(/must not be the sole basis/i);
    expect(text).toMatch(/independently investigate/i);
    expect(text).toMatch(/access, objection and challenge rights/i);
  });
});

describe("ENG-08 — agreements and participation gates", () => {
  const eligible: ParticipationFacts = {
    businessEligibilityVerified: true,
    controllerRegistrationChecked: true,
    agreementsExecuted: true,
    noticeEvidenceRecorded: true,
    consentActive: true,
    policyCurrent: true,
    businessSuspended: false,
    globalEnabled: true,
  };

  it("lists the required documents without inventing clauses", () => {
    expect(AGREEMENT_CATALOGUE).toHaveLength(3);
    expect(AGREEMENT_CATALOGUE.map((a) => a.type)).toEqual([
      "joint_controller",
      "participation_terms",
      "processing_addendum",
    ]);
    for (const agreement of AGREEMENT_CATALOGUE) {
      expect(agreement.title.length).toBeGreaterThan(0);
      expect(agreement.version.length).toBeGreaterThan(0);
      expect(agreement.effectiveDate.length).toBeGreaterThan(0);
    }
  });

  it("enforces the agreement state machine", () => {
    expect(canTransitionAgreement("draft", "presented")).toBe(true);
    expect(canTransitionAgreement("presented", "accepted")).toBe(true);
    expect(canTransitionAgreement("accepted", "executed")).toBe(true);
    expect(canTransitionAgreement("draft", "executed")).toBe(false);
    expect(canTransitionAgreement("terminated", "active")).toBe(false);
    expect(AGREEMENT_STATES).toContain("awaiting_countersignature");
  });

  it("keeps query-only and share-signals scopes separate", () => {
    expect(participationEligibility({ ...eligible, scope: "share_signals" }).contribute).toBe(true);
    expect(participationEligibility({ ...eligible, scope: "query_only" }).contribute).toBe(false);
    expect(participationEligibility({ ...eligible, scope: "query_only" }).query).toBe(true);
  });

  it("blocks real contribution when any participation gate is missing", () => {
    const gates: (keyof ParticipationFacts)[] = [
      "businessEligibilityVerified",
      "agreementsExecuted",
      "noticeEvidenceRecorded",
      "consentActive",
      "policyCurrent",
      "globalEnabled",
    ];
    for (const gate of gates) {
      const result = participationEligibility({ ...eligible, [gate]: false });
      expect(result.contribute, `gate ${gate}`).toBe(false);
    }
    // DPC registration is recorded for information, not used as a participation gate.
    expect(
      participationEligibility({ ...eligible, controllerRegistrationChecked: false }).contribute
    ).toBe(true);
    expect(participationEligibility({ ...eligible, businessSuspended: true }).contribute).toBe(false);
    expect(participationEligibility({ ...eligible, businessSuspended: true }).query).toBe(false);
  });

  it("refuses a contribution when notice evidence is missing", () => {
    const valid = {
      consent,
      category: "shortage",
      severity: "high",
      sourceType: "dailyAccount",
      sourceId: "record-1",
      reasonLength: 40,
      alreadyContributed: false,
      businessEligibilityVerified: true,
      noticeEvidenceRecorded: false,
      agreementsExecuted: false,
      businessSuspended: false,
      globalEnabled: true,
      controllerRegistrationChecked: true,
    };
    expect(validateRiskContribution(valid).ok).toBe(false);
    expect(
      validateRiskContribution({
        ...valid,
        noticeEvidenceRecorded: true,
        agreementsExecuted: true,
        controllerRegistrationChecked: true,
      }).ok
    ).toBe(true);
  });
});
