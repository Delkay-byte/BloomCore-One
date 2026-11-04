import { db } from "@/lib/db";
import { PROVIDER_DISABLED_MESSAGE, PROVIDER_POLICY_VERSION } from "./provider-policy";

/**
 * Single centralized external-AI policy.
 *
 * States:
 *   disabled  — no external request, ever
 *   synthetic — synthetic packages only, explicitly enabled in environment
 *   approved  — aggregate-only production processing, additionally gated by a
 *               reviewed code constant, privacy policy version, approval
 *               reference, provider configuration and tenant authorization
 *
 * The database switch cannot activate approved production mode by itself.
 */

/** Change only through a reviewed, privacy-approved code commit. */
export const PRODUCTION_PROVIDER_APPROVED = false;

export type ProviderMode = "disabled" | "synthetic" | "approved";

export interface ProviderControlRecord {
  mode: string;
  enabled: boolean;
  emergencyDisabled: boolean;
  approvedProvider: string | null;
  approvedPurposes: string[] | null;
  policyVersion: string | null;
  approvalReference: string | null;
  reason: string | null;
  updatedById: string | null;
  updatedAt: Date;
}

export interface EffectiveProviderPolicy {
  state: "disabled" | "synthetic" | "approved";
  allowed: boolean;
  provider: "deepseek" | null;
  model: string;
  reason: string;
  syntheticOnly: boolean;
  productionApproved: boolean;
  emergencyDisabled: boolean;
  control: ProviderControlRecord;
  credentialConfigured: boolean;
  codeApprovalPresent: boolean;
  privacyVersionPresent: boolean;
  approvalReferencePresent: boolean;
  tenantAuthorized: boolean;
}

export const DEFAULT_CONTROL: ProviderControlRecord = {
  mode: "disabled",
  enabled: false,
  emergencyDisabled: true,
  approvedProvider: null,
  approvedPurposes: null,
  policyVersion: null,
  approvalReference: null,
  reason: null,
  updatedById: null,
  updatedAt: new Date(0),
};

export function deepSeekModel(): string {
  const configured = (process.env.DEEPSEEK_MODEL || "deepseek-flash").trim();
  return ["deepseek-flash", "deepseek-v4-pro"].includes(configured)
    ? configured
    : "deepseek-flash";
}

export async function getProviderControl(): Promise<ProviderControlRecord> {
  try {
    const row = await db.zeliProviderControl.findUnique({ where: { id: "global" } });
    if (!row) return DEFAULT_CONTROL;
    let purposes: string[] | null = null;
    if (row.approvedPurposes) {
      try {
        const parsed = JSON.parse(row.approvedPurposes);
        purposes = Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : null;
      } catch {
        purposes = null;
      }
    }
    return {
      mode: row.mode,
      enabled: row.enabled,
      emergencyDisabled: row.emergencyDisabled,
      approvedProvider: row.approvedProvider,
      approvedPurposes: purposes,
      policyVersion: row.policyVersion,
      approvalReference: row.approvalReference,
      reason: row.reason,
      updatedById: row.updatedById,
      updatedAt: row.updatedAt,
    };
  } catch {
    return DEFAULT_CONTROL;
  }
}

export async function getTenantAiAuthorization(tenantId: string): Promise<boolean> {
  if (!tenantId) return false;
  try {
    const row = await db.zeliAiTenantAuthorization.findUnique({ where: { tenantId } });
    return Boolean(row?.enabled);
  } catch {
    return false;
  }
}

export function syntheticTestingEnabled(): boolean {
  return process.env.ZELI_SYNTHETIC_TESTING_ALLOWED === "true";
}

/**
 * Fail-closed evaluation. Every condition is additive; no single flag or key
 * can enable processing.
 */
export async function getEffectiveProviderPolicy(
  tenantId?: string | null
): Promise<EffectiveProviderPolicy> {
  const control = await getProviderControl();
  const credentialConfigured = Boolean(process.env.DEEPSEEK_API_KEY);
  const codeApprovalPresent = PRODUCTION_PROVIDER_APPROVED;
  const privacyVersion = (process.env.ZELI_PRIVACY_POLICY_VERSION || "").trim();
  const approvalRef = (process.env.ZELI_APPROVAL_REFERENCE || "").trim();
  const privacyVersionPresent =
    Boolean(privacyVersion) && privacyVersion === control.policyVersion;
  const approvalReferencePresent = Boolean(approvalRef);
  const tenantAuthorized = tenantId ? await getTenantAiAuthorization(tenantId) : false;

  const base = {
    provider: "deepseek" as const,
    model: deepSeekModel(),
    control,
    credentialConfigured,
    codeApprovalPresent,
    privacyVersionPresent,
    approvalReferencePresent,
    tenantAuthorized,
  };

  if (control.emergencyDisabled) {
    return {
      ...base,
      state: "disabled",
      allowed: false,
      reason: "External AI is stopped by the global emergency disable control.",
      syntheticOnly: false,
      productionApproved: false,
      emergencyDisabled: true,
    };
  }
  if (!control.enabled || control.mode === "disabled") {
    return {
      ...base,
      state: "disabled",
      allowed: false,
      reason: PROVIDER_DISABLED_MESSAGE,
      syntheticOnly: false,
      productionApproved: false,
      emergencyDisabled: false,
    };
  }
  if (control.approvedProvider !== "deepseek") {
    return {
      ...base,
      state: "disabled",
      allowed: false,
      reason: "No approved external provider is configured.",
      syntheticOnly: false,
      productionApproved: false,
      emergencyDisabled: false,
    };
  }
  if (!credentialConfigured) {
    return {
      ...base,
      state: "disabled",
      allowed: false,
      reason: "External provider credential is not configured. Zeli remains local.",
      syntheticOnly: false,
      productionApproved: false,
      emergencyDisabled: false,
    };
  }

  if (control.mode === "synthetic") {
    if (!syntheticTestingEnabled()) {
      return {
        ...base,
        state: "disabled",
        allowed: false,
        reason:
          "Synthetic provider testing is not enabled in this environment. Set ZELI_SYNTHETIC_TESTING_ALLOWED=true only in an approved test environment.",
        syntheticOnly: true,
        productionApproved: false,
        emergencyDisabled: false,
      };
    }
    return {
      ...base,
      state: "synthetic",
      allowed: true,
      reason: "Synthetic provider testing is enabled. Only synthetic insight packages may be sent.",
      syntheticOnly: true,
      productionApproved: false,
      emergencyDisabled: false,
    };
  }

  if (control.mode === "approved") {
    const missing: string[] = [];
    if (!codeApprovalPresent) missing.push("reviewed code approval");
    if (!privacyVersionPresent) missing.push("approved privacy policy version");
    if (!approvalReferencePresent) missing.push("approval reference");
    if (!tenantAuthorized) missing.push("tenant authorization");
    if (missing.length > 0) {
      return {
        ...base,
        state: "disabled",
        allowed: false,
        reason: `Aggregate production processing is locked: missing ${missing.join(", ")}.`,
        syntheticOnly: false,
        productionApproved: codeApprovalPresent,
        emergencyDisabled: false,
      };
    }
    return {
      ...base,
      state: "approved",
      allowed: true,
      reason: "Approved aggregate-only production processing is enabled.",
      syntheticOnly: false,
      productionApproved: true,
      emergencyDisabled: false,
    };
  }

  return {
    ...base,
    state: "disabled",
    allowed: false,
    reason: "Unsupported provider mode.",
    syntheticOnly: false,
    productionApproved: false,
    emergencyDisabled: false,
  };
}

export function providerStatusMessage(policy: EffectiveProviderPolicy): string {
  if (policy.state === "approved") {
    return "External AI is enabled for approved aggregate-only explanations.";
  }
  if (policy.state === "synthetic") {
    return "External AI is in synthetic testing mode. No tenant records may be sent.";
  }
  return PROVIDER_DISABLED_MESSAGE;
}

export const PROVIDER_CONTROL_POLICY_VERSION = PROVIDER_POLICY_VERSION;
