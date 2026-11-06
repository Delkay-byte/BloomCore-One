import type { EffectiveProviderPolicy } from "./provider-control";

/**
 * Response header values derived from the effective external-AI policy.
 *
 * These headers are informational only. They must never contain credentials,
 * approval references, tenant identifiers or other private configuration, and
 * they are never used to authorize a provider call: the gateway and policy
 * checks run on the request path regardless of what the browser was told.
 */
export type ExternalAiHeaderState = "disabled" | "synthetic" | "approved";

export interface ProviderPolicyHeaders {
  "x-zeli-external-ai": ExternalAiHeaderState;
  "x-zeli-external-ai-allowed": "true" | "false";
}

export function providerPolicyHeaders(
  policy: EffectiveProviderPolicy
): ProviderPolicyHeaders {
  return {
    "x-zeli-external-ai": policy.allowed ? policy.state : "disabled",
    "x-zeli-external-ai-allowed": policy.allowed ? "true" : "false",
  };
}
