/**
 * Phase 4 — withdrawal policy evaluation (pure, no database).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WITHDRAWAL_POLICY,
  evaluateWithdrawalPolicy,
  validateWithdrawalPolicy,
} from "@/lib/withdrawal-policy";

describe("withdrawal policy validation", () => {
  it("accepts the safe default legacy policy", () => {
    const result = validateWithdrawalPolicy(DEFAULT_WITHDRAWAL_POLICY);
    expect(result.ok).toBe(true);
  });

  it("rejects a minimum greater than the maximum", () => {
    const result = validateWithdrawalPolicy({
      ...DEFAULT_WITHDRAWAL_POLICY,
      minAmountPesewa: 5000,
      maxAmountPesewa: 1000,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a high-value threshold outside the configured limits", () => {
    const result = validateWithdrawalPolicy({
      ...DEFAULT_WITHDRAWAL_POLICY,
      minAmountPesewa: 100,
      maxAmountPesewa: 100000,
      highValueThresholdPesewa: 200000,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unsupported approval count", () => {
    const result = validateWithdrawalPolicy({
      ...DEFAULT_WITHDRAWAL_POLICY,
      requiredApprovals: 9,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects evidence requirements without an evidence field", () => {
    const result = validateWithdrawalPolicy({
      ...DEFAULT_WITHDRAWAL_POLICY,
      requirePaymentEvidence: true,
      requiredEvidenceFields: [],
    });
    expect(result.ok).toBe(false);
  });
});

describe("withdrawal policy evaluation", () => {
  it("keeps an ordinary withdrawal on the fast path under the safe default", () => {
    const evaluation = evaluateWithdrawalPolicy(DEFAULT_WITHDRAWAL_POLICY, 5000);
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.highValue).toBe(false);
    expect(evaluation.requiredApprovals).toBe(0);
    expect(evaluation.requiresIndependentPayment).toBe(false);
  });

  it("rejects amounts below the configured minimum", () => {
    const evaluation = evaluateWithdrawalPolicy(
      { ...DEFAULT_WITHDRAWAL_POLICY, minAmountPesewa: 1000 },
      500
    );
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reason).toMatch(/minimum/i);
  });

  it("rejects amounts above the configured maximum", () => {
    const evaluation = evaluateWithdrawalPolicy(
      { ...DEFAULT_WITHDRAWAL_POLICY, maxAmountPesewa: 10000 },
      20000
    );
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reason).toMatch(/maximum/i);
  });

  it("flags a high-value withdrawal and requires configured approvals", () => {
    const evaluation = evaluateWithdrawalPolicy(
      {
        ...DEFAULT_WITHDRAWAL_POLICY,
        highValueThresholdPesewa: 10000,
        highValueRequiresApproval: true,
        requiredApprovals: 2,
        separationOfDuties: true,
      },
      20000
    );
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.highValue).toBe(true);
    expect(evaluation.requiredApprovals).toBe(2);
    expect(evaluation.requiresIndependentPayment).toBe(true);
  });

  it("does not require approval for a high value when the policy says no", () => {
    const evaluation = evaluateWithdrawalPolicy(
      {
        ...DEFAULT_WITHDRAWAL_POLICY,
        highValueThresholdPesewa: 10000,
        highValueRequiresApproval: false,
      },
      20000
    );
    expect(evaluation.highValue).toBe(true);
    expect(evaluation.requiredApprovals).toBe(0);
  });
});
