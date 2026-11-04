import {
  getEffectiveProviderPolicy,
  syntheticTestingEnabled,
  type EffectiveProviderPolicy,
} from "../provider-control";

/**
 * Conversational provider policy.
 *
 * This is deliberately separate from the aggregate "insight explanation"
 * policy. Sending a user's message is a different processing purpose from
 * sending a fixed aggregate package, and it needs its own approval.
 *
 * The gate is a reviewed code constant plus the existing global control:
 *
 *   disabled  — no conversational request, ever
 *   synthetic — synthetic test messages only, never tenant data
 *   approved  — production conversational processing, additionally gated by a
 *               privacy policy version, an approval reference, tenant
 *               authorization and per-request user consent
 *
 * No environment variable, database switch or API key can enable production
 * conversational processing on its own.
 */

/** Change only through a reviewed, privacy-approved commit. */
export const PRODUCTION_CONVERSATION_APPROVED = false;

export const CONVERSATION_POLICY_VERSION = "2026-11-conv.1";
export const CONVERSATION_SCHEMA_VERSION = "zeli-conversation-v1";

export type ConversationProviderState = "disabled" | "synthetic" | "approved";

export interface ConversationProviderPolicy {
  state: ConversationProviderState;
  allowed: boolean;
  reason: string;
  provider: "deepseek" | null;
  model: string;
  syntheticOnly: boolean;
  credentialConfigured: boolean;
  approvalRequired: boolean;
  codeApprovalPresent: boolean;
  privacyVersionPresent: boolean;
  approvalReferencePresent: boolean;
  tenantAuthorized: boolean;
  /** Underlying aggregate policy, kept for diagnostics only. */
  control: EffectiveProviderPolicy;
}

export const CONVERSATION_DISABLED_MESSAGE =
  "External conversational AI is not approved for this workspace. Zeli continues to answer locally from your authorized records.";

export async function getConversationPolicy(
  tenantId?: string | null
): Promise<ConversationProviderPolicy> {
  const control = await getEffectiveProviderPolicy(tenantId);
  const credentialConfigured = control.credentialConfigured;
  const codeApprovalPresent = PRODUCTION_CONVERSATION_APPROVED;

  const base = {
    provider: "deepseek" as const,
    model: control.model,
    control,
    credentialConfigured,
    approvalRequired: true,
    codeApprovalPresent,
    privacyVersionPresent: control.privacyVersionPresent,
    approvalReferencePresent: control.approvalReferencePresent,
    tenantAuthorized: control.tenantAuthorized,
  };

  if (control.emergencyDisabled) {
    return {
      ...base,
      state: "disabled",
      allowed: false,
      reason: "External AI is stopped by the global emergency disable control.",
      syntheticOnly: false,
    };
  }
  if (!control.control.enabled || control.control.mode === "disabled") {
    return {
      ...base,
      state: "disabled",
      allowed: false,
      reason: CONVERSATION_DISABLED_MESSAGE,
      syntheticOnly: false,
    };
  }
  if (control.control.approvedProvider !== "deepseek") {
    return {
      ...base,
      provider: null,
      state: "disabled",
      allowed: false,
      reason: "No approved external provider is configured.",
      syntheticOnly: false,
    };
  }
  if (!credentialConfigured) {
    return {
      ...base,
      state: "disabled",
      allowed: false,
      reason:
        "The external provider credential is not configured. Zeli remains local.",
      syntheticOnly: false,
    };
  }

  if (control.control.mode === "synthetic") {
    if (!syntheticTestingEnabled()) {
      return {
        ...base,
        state: "disabled",
        allowed: false,
        reason:
          "Synthetic provider testing is not enabled in this environment. Set ZELI_SYNTHETIC_TESTING_ALLOWED=true only in an approved test environment.",
        syntheticOnly: true,
      };
    }
    return {
      ...base,
      state: "synthetic",
      allowed: true,
      reason:
        "Synthetic conversational testing is enabled. Only marked synthetic test messages may be sent.",
      syntheticOnly: true,
    };
  }

  if (control.control.mode === "approved") {
    const missing: string[] = [];
    if (!codeApprovalPresent) missing.push("reviewed conversation code approval");
    if (!control.privacyVersionPresent) missing.push("approved privacy policy version");
    if (!control.approvalReferencePresent) missing.push("approval reference");
    if (!control.tenantAuthorized) missing.push("tenant authorization");
    if (missing.length > 0) {
      return {
        ...base,
        state: "disabled",
        allowed: false,
        reason: `External conversational processing is locked: missing ${missing.join(", ")}.`,
        syntheticOnly: false,
      };
    }
    return {
      ...base,
      state: "approved",
      allowed: true,
      reason:
        "Approved external conversational processing is enabled for non-financial messages only.",
      syntheticOnly: false,
    };
  }

  return {
    ...base,
    state: "disabled",
    allowed: false,
    reason: "Unsupported conversational provider mode.",
    syntheticOnly: false,
  };
}
