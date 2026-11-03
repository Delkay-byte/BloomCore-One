/**
 * External AI provider policy.
 *
 * THIS RELEASE IS HARD-OFF.
 *
 * DeepSeek is retained in the repository only as a future integration surface.
 * The gate is a reviewed code constant, not an environment flag: setting
 * ZELI_PROVIDER=deepseek, ZELI_DEEPSEEK_APPROVED=true or adding an API key
 * cannot enable external processing. Enabling it requires a code change that
 * passes review, a signed privacy assessment and an owner decision.
 *
 * The browser is never consulted. There is no UI toggle that can enable it.
 */

/** Change only through a reviewed privacy-approved commit. */
export const EXTERNAL_AI_PHASE = "disabled" as const;

/** Bump when the outbound payload policy changes. */
export const PROVIDER_POLICY_VERSION = "2026-11.1";

export interface ExternalAiStatus {
  externalProcessing: boolean;
  phase: "disabled" | "approved";
  provider: "deepseek" | "none";
  deepSeekDisabled: boolean;
  approvalRecorded: boolean;
  approvalRequired: boolean;
  credentialConfigured: boolean;
  message: string;
  futureApprovalProcedure: string[];
}

export const PROVIDER_DISABLED_MESSAGE =
  "External AI processing is currently disabled. Zeli's private analytics and local intelligence features remain available.";

export const APPROVAL_PROCEDURE = [
  "Complete a Data Protection Impact Assessment and a purpose-specific privacy assessment for the proposed outbound data.",
  "Obtain written owner approval and, where required, a data processing agreement with the provider.",
  "Implement and test the outbound gateway allow-list for the approved fields and minimum aggregation thresholds.",
  "Change EXTERNAL_AI_PHASE to \"approved\" in a reviewed commit, add the provider approval identifier to the deployment environment, and record the approval in docs/zeli.",
  "Configure the provider credential only in the approved environment. Never commit it.",
  "Run the provider-isolation tests with outbound HTTP interception and confirm the gateway audit log.",
];

/**
 * The single source of truth for external processing. It deliberately does not
 * read any environment variable: presence of a key or an old approval flag is
 * not authorization.
 */
export function externalAiStatus(): ExternalAiStatus {
  const credentialConfigured = Boolean(process.env.DEEPSEEK_API_KEY);
  return {
    externalProcessing: false,
    phase: EXTERNAL_AI_PHASE,
    provider: "none",
    deepSeekDisabled: true,
    approvalRecorded: false,
    approvalRequired: true,
    // A boolean is safe to expose; the value never is.
    credentialConfigured,
    message: PROVIDER_DISABLED_MESSAGE,
    futureApprovalProcedure: APPROVAL_PROCEDURE,
  };
}

export class ProviderDisabledError extends Error {
  constructor(message = PROVIDER_DISABLED_MESSAGE) {
    super(message);
    this.name = "ProviderDisabledError";
  }
}

/** Fail closed before any request construction or network call. */
export function assertExternalProviderDisabled(): never {
  throw new ProviderDisabledError();
}

/**
 * A provider id from configuration is reported for diagnostics only. It can
 * never select an external provider while the phase is disabled.
 */
export function configuredProviderLabel(): string {
  const configured = (process.env.ZELI_PROVIDER || "internal").toLowerCase();
  if (configured === "deepseek") return "deepseek (disabled)";
  return "internal";
}
