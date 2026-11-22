import {
  getEffectiveProviderPolicy,
  syntheticTestingEnabled,
  type EffectiveProviderPolicy,
} from "../provider-control";
import {
  resolveConversationEntitlement,
  type ConversationEntitlement,
} from "../conversation-entitlement";

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
 * conversational processing on its own, and the reviewed code approval is not an
 * entitlement either: a business must additionally hold a paid, current package that
 * includes Zeli and be inside its monthly allowance. That check lives in
 * `conversation-entitlement.ts` and is applied here so no caller can skip it.
 */

/**
 * Reviewed approval for external conversation with **paid** businesses.
 *
 * The owner authorised this narrowly: conversation is included in eligible paid
 * monthly and annual MaaCash packages, subject to the tier's monthly allowance. It is
 * not general permission to send anything anywhere — the aggregate/provider gate in
 * `provider-control.ts` (`PRODUCTION_PROVIDER_APPROVED`) is unrelated and unchanged,
 * and the investigation add-on keeps its own separate entitlement.
 */
export const PRODUCTION_CONVERSATION_APPROVED = true;

export const CONVERSATION_POLICY_VERSION = "2026-11-conv.1";
export const CONVERSATION_SCHEMA_VERSION = "zeli-conversation-v1";

export type ConversationProviderState =
  | "disabled"
  | "synthetic"
  | "team_testing"
  | "approved";

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
  teamTesting?: boolean;
  teamTesterActive?: boolean;
  teamDisclosureAccepted?: boolean;
  teamDisclosureVersion?: string;
  /** The paid-package entitlement that conversation requires. */
  entitlement?: ConversationEntitlement | null;
  /** Underlying aggregate policy, kept for diagnostics only. */
  control: EffectiveProviderPolicy;
}

export const CONVERSATION_DISABLED_MESSAGE =
  "External conversational AI is not approved for this workspace. Zeli continues to answer locally from your authorized records.";

export async function getConversationPolicy(
  tenantId?: string | null,
  userId?: string | null
): Promise<ConversationProviderPolicy> {
  const control = await getEffectiveProviderPolicy(tenantId, userId);
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
    teamTesting: control.control.mode === "team_testing",
    teamTesterActive: control.teamTesterActive,
    teamDisclosureAccepted: control.teamDisclosureAccepted,
    teamDisclosureVersion: control.teamDisclosureVersion,
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

  if (control.control.mode === "team_testing") {
    if (control.state !== "team_testing" || !control.allowed) {
      return {
        ...base,
        state: "disabled",
        allowed: false,
        reason: control.reason,
        syntheticOnly: true,
      };
    }
    return {
      ...base,
      state: "team_testing",
      allowed: true,
      reason:
        "Team Testing is enabled: live DeepSeek conversations with synthetic business data only.",
      syntheticOnly: true,
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

    // Last gate: the business must actually be paying for a package that includes
    // Zeli. The client never supplies this, and it is re-read on every turn.
    const entitlement = await resolveConversationEntitlement(tenantId);
    if (!entitlement.allowed) {
      return {
        ...base,
        entitlement,
        state: "disabled",
        allowed: false,
        reason: entitlement.guidance,
        syntheticOnly: false,
      };
    }
    return {
      ...base,
      entitlement,
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
