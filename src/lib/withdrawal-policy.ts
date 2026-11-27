/**
 * Phase 4 — tenant-level withdrawal policy.
 *
 * Pure validation and evaluation only. The database row is read and written by
 * server actions; thresholds, approval counts and role claims are never taken
 * from the browser. The default policy preserves the existing withdrawal path.
 */

export const MAX_APPROVALS = 3;
export const EVIDENCE_FIELDS = [
  "paymentMethod",
  "paymentReference",
  "evidenceAttachment",
  "acknowledgedBy",
] as const;

export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];

export interface WithdrawalPolicyValues {
  active: boolean;
  minAmountPesewa: number;
  maxAmountPesewa: number;
  highValueThresholdPesewa: number | null;
  highValueRequiresApproval: boolean;
  requiredApprovals: number;
  separationOfDuties: boolean;
  requireStepUp: boolean;
  requirePaymentEvidence: boolean;
  requiredEvidenceFields: EvidenceField[];
}

export const DEFAULT_WITHDRAWAL_POLICY: WithdrawalPolicyValues = {
  active: true,
  minAmountPesewa: 0,
  maxAmountPesewa: 99_999_999,
  highValueThresholdPesewa: null,
  highValueRequiresApproval: false,
  requiredApprovals: 0,
  separationOfDuties: false,
  requireStepUp: true,
  requirePaymentEvidence: false,
  requiredEvidenceFields: [],
};

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function validateWithdrawalPolicy(input: WithdrawalPolicyValues): ValidationResult {
  if (!isNonNegativeInteger(input.minAmountPesewa)) {
    return { ok: false, error: "The minimum must be a whole pesewa amount." };
  }
  if (!isNonNegativeInteger(input.maxAmountPesewa) || input.maxAmountPesewa <= 0) {
    return { ok: false, error: "The maximum must be a positive whole pesewa amount." };
  }
  if (input.minAmountPesewa > input.maxAmountPesewa) {
    return { ok: false, error: "The minimum cannot exceed the maximum." };
  }
  const threshold = input.highValueThresholdPesewa;
  if (threshold !== null) {
    if (!isNonNegativeInteger(threshold) || threshold <= 0) {
      return { ok: false, error: "The high-value threshold must be a positive amount." };
    }
    if (threshold <= input.minAmountPesewa || threshold > input.maxAmountPesewa) {
      return { ok: false, error: "The high-value threshold must be inside the withdrawal limits." };
    }
  }
  if (
    !Number.isInteger(input.requiredApprovals) ||
    input.requiredApprovals < 0 ||
    input.requiredApprovals > MAX_APPROVALS
  ) {
    return { ok: false, error: `Approvals must be between 0 and ${MAX_APPROVALS}.` };
  }
  if (input.highValueRequiresApproval && threshold === null) {
    return { ok: false, error: "Set a high-value threshold before requiring approval." };
  }
  if (!Array.isArray(input.requiredEvidenceFields)) {
    return { ok: false, error: "Evidence requirements must be a list." };
  }
  if (input.requirePaymentEvidence && input.requiredEvidenceFields.length === 0) {
    return { ok: false, error: "Choose at least one required evidence field." };
  }
  for (const field of input.requiredEvidenceFields) {
    if (!(EVIDENCE_FIELDS as readonly string[]).includes(field)) {
      return { ok: false, error: `Unsupported evidence field: ${field}` };
    }
  }
  return { ok: true };
}

export interface PolicyEvaluation {
  allowed: boolean;
  reason?: string;
  highValue: boolean;
  requiredApprovals: number;
  requiresIndependentPayment: boolean;
  requireStepUp: boolean;
  requirePaymentEvidence: boolean;
  requiredEvidenceFields: EvidenceField[];
  active: boolean;
}

/** Evaluate a validated policy against one integer-pesewa amount. */
export function evaluateWithdrawalPolicy(
  policy: WithdrawalPolicyValues,
  amountPesewa: number
): PolicyEvaluation {
  const base = {
    highValue: false,
    requiredApprovals: 0,
    requiresIndependentPayment: false,
    requireStepUp: policy.requireStepUp,
    requirePaymentEvidence: policy.requirePaymentEvidence,
    requiredEvidenceFields: policy.requiredEvidenceFields,
    active: policy.active,
  };
  if (!policy.active) {
    // An inactive policy falls back to the safe legacy path rather than
    // blocking legitimate withdrawals.
    return { ...base, allowed: true };
  }
  if (!Number.isFinite(amountPesewa) || amountPesewa <= 0) {
    return { ...base, allowed: false, reason: "Enter a valid withdrawal amount." };
  }
  if (amountPesewa < policy.minAmountPesewa) {
    return { ...base, allowed: false, reason: "This withdrawal is below the business minimum." };
  }
  if (amountPesewa > policy.maxAmountPesewa) {
    return { ...base, allowed: false, reason: "This withdrawal is above the business maximum." };
  }
  const highValue =
    policy.highValueThresholdPesewa !== null &&
    amountPesewa >= policy.highValueThresholdPesewa;
  const requiredApprovals =
    policy.requiredApprovals > 0
      ? policy.requiredApprovals
      : highValue && policy.highValueRequiresApproval
        ? 1
        : 0;
  return {
    ...base,
    allowed: true,
    highValue,
    requiredApprovals,
    requiresIndependentPayment: policy.separationOfDuties && requiredApprovals > 0,
  };
}

/** Convert a persisted policy row (Decimal/string values) to plain values. */
export function policyFromRow(row: {
  active: boolean;
  minAmountPesewa: number;
  maxAmountPesewa: number;
  highValueThresholdPesewa: number | null;
  highValueRequiresApproval: boolean;
  requiredApprovals: number;
  separationOfDuties: boolean;
  requireStepUp: boolean;
  requirePaymentEvidence: boolean;
  requiredEvidenceFields: string;
}): WithdrawalPolicyValues {
  let fields: EvidenceField[] = [];
  try {
    const parsed = JSON.parse(row.requiredEvidenceFields || "[]");
    if (Array.isArray(parsed)) fields = parsed.filter((f): f is EvidenceField => EVIDENCE_FIELDS.includes(f));
  } catch {
    fields = [];
  }
  return {
    active: row.active,
    minAmountPesewa: Number(row.minAmountPesewa),
    maxAmountPesewa: Number(row.maxAmountPesewa),
    highValueThresholdPesewa:
      row.highValueThresholdPesewa === null ? null : Number(row.highValueThresholdPesewa),
    highValueRequiresApproval: row.highValueRequiresApproval,
    requiredApprovals: row.requiredApprovals,
    separationOfDuties: row.separationOfDuties,
    requireStepUp: row.requireStepUp,
    requirePaymentEvidence: row.requirePaymentEvidence,
    requiredEvidenceFields: fields,
  };
}
