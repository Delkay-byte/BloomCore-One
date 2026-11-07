import type { ZeliIdentity } from "../types";
import {
  circuitState,
  checkProviderLimits,
  auditReference,
  providerRequestId,
  recordCircuitFailure,
  recordCircuitSuccess,
  recordProviderUsage,
} from "../provider-audit";
import {
  CONVERSATION_SCHEMA_VERSION,
  getConversationPolicy,
  type ConversationProviderPolicy,
} from "./conversation-policy";
import {
  ConversationProviderError,
  requestDeepSeekConversation,
} from "./deepseek-conversation";
import type { ZeliConversationAct } from "../conversation/acts";

/**
 * Provider-neutral selection for external conversational reasoning.
 *
 * Local Zeli never depends on this module. When the policy denies a request —
 * which is the default and the production state — callers fall back to the
 * local deterministic answer. Nothing here is reachable from the browser.
 */

export interface ExternalConversationResult {
  text: string;
  provider: "deepseek-conversation";
  model: string;
  synthetic: boolean;
  redactions: number;
}

const CIRCUIT_KEY = "deepseek-conversation";

export function conversationModeFor(policy: ConversationProviderPolicy): "local" | "external" {
  return policy.allowed ? "external" : "local";
}

export function conversationDisclosure(synthetic: boolean): string {
  return synthetic
    ? "[EXTERNAL AI · SYNTHETIC TEST] This reply came from the external provider in synthetic test mode. No tenant records were sent."
    : "[EXTERNAL AI · CONVERSATIONAL] This reply came from an approved external provider. No business records or figures were sent. Business facts are answered only by MaaCash's local engine.";
}

/**
 * Attempt one external conversational turn. Returns null when policy, limits or
 * the provider itself deny the request; the caller must then answer locally.
 */
export async function generateExternalConversation(params: {
  identity: ZeliIdentity;
  message: string;
  act: ZeliConversationAct;
  /** Marks a synthetic test request. Never true for a real tenant message. */
  synthetic?: boolean;
}): Promise<ExternalConversationResult | null> {
  if (!params.act) return null;

  const policy = await getConversationPolicy(params.identity.tenantId);
  if (!policy.allowed) return null;
  if (circuitState(CIRCUIT_KEY) === "open") return null;

  const requestId = providerRequestId();
  const tenantHash = auditReference(params.identity.tenantId ?? "none");
  const userHash = auditReference(params.identity.userId);
  const purpose = `conversation:${params.act}`;

  const limits = await checkProviderLimits(tenantHash, userHash);
  if (!limits.allowed) {
    await recordProviderUsage({
      requestId,
      tenantId: params.identity.tenantId,
      userId: params.identity.userId,
      roleCategory: params.identity.role,
      provider: "deepseek",
      model: policy.model,
      purpose,
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      decision: "denied",
      reasonCategory: limits.reason,
    });
    return null;
  }

  const synthetic = policy.state === "synthetic";
  try {
    const result = await requestDeepSeekConversation({
      message: params.message,
      policy,
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
      // Tenant-level authorization is the consent basis recorded by the
      // business owner. It is re-read on every turn by the policy above.
      consent: policy.tenantAuthorized,
      synthetic: synthetic || params.synthetic === true,
    });
    recordCircuitSuccess(CIRCUIT_KEY);
    await recordProviderUsage({
      requestId,
      tenantId: params.identity.tenantId,
      userId: params.identity.userId,
      roleCategory: params.identity.role,
      provider: "deepseek",
      model: policy.model,
      purpose,
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      decision: "success",
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens ?? undefined,
      outputTokens: result.outputTokens ?? undefined,
    });
    return {
      text: `${result.text}\n\n${conversationDisclosure(synthetic)}`,
      provider: "deepseek-conversation",
      model: policy.model,
      synthetic,
      redactions: result.redactions,
    };
  } catch (error) {
    recordCircuitFailure(CIRCUIT_KEY);
    const code =
      error instanceof ConversationProviderError ? error.code : "provider_error";
    await recordProviderUsage({
      requestId,
      tenantId: params.identity.tenantId,
      userId: params.identity.userId,
      roleCategory: params.identity.role,
      provider: "deepseek",
      model: policy.model,
      purpose,
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      decision: "error",
      reasonCategory: code,
    });
    // Never surface provider internals or secrets to the user or the log.
    if (process.env.NODE_ENV !== "test") {
      console.warn(`[ZELI CONVERSATION] external provider unavailable (${code})`);
    }
    return null;
  }
}

/** Status for the workspace banner. Contains no secrets or approval values. */
export async function getConversationStatus(tenantId?: string | null) {
  const policy = await getConversationPolicy(tenantId);
  return {
    mode: conversationModeFor(policy),
    state: policy.allowed ? policy.state : "disabled",
    provider: policy.allowed ? policy.provider : null,
    model: policy.allowed ? policy.model : null,
    message: policy.reason,
    approvalRequired: policy.approvalRequired,
    credentialConfigured: policy.credentialConfigured,
  };
}
