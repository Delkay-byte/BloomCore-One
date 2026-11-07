import type { ZeliIdentity } from "../types";
import { db } from "@/lib/db";
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
  requestDeepSeekTeamConversation,
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

/* ------------------------------------------------------------------------- *
 * Restricted Team Testing conversation
 * ------------------------------------------------------------------------- */

const TEAM_CIRCUIT_KEY = "deepseek-team-testing";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove known tenant customer/staff identifiers from a team-testing message
 * before it can reach the provider. The records are used only as a local
 * redaction dictionary; no values are returned, logged or sent.
 */
export async function redactKnownTenantIdentifiers(
  tenantId: string | null,
  text: string
): Promise<string> {
  if (!tenantId) return text;
  let out = text;
  try {
    const [customers, users] = await Promise.all([
      db.customer.findMany({
        where: { tenantId },
        select: { fullName: true, customerId: true, phone: true, email: true },
        take: 500,
      }),
      db.user.findMany({
        where: { tenantId },
        select: { fullName: true, email: true, phone: true },
        take: 500,
      }),
    ]);
    const values: string[] = [];
    for (const customer of customers) {
      values.push(customer.fullName, customer.customerId);
      if (customer.phone) values.push(customer.phone);
      if (customer.email) values.push(customer.email);
    }
    for (const user of users) {
      values.push(user.fullName);
      if (user.email) values.push(user.email);
      if (user.phone) values.push(user.phone);
    }
    for (const value of values) {
      const candidate = value?.trim();
      if (!candidate || candidate.length < 3) continue;
      out = out.replace(
        new RegExp(escapeRegExp(candidate), "gi"),
        "[redacted identifier]"
      );
    }
  } catch {
    // Redaction failure must not leak data: the caller still applies the
    // generic sanitizer and the strict synthetic prompt.
  }
  return out;
}

export function teamTestingDisclosure(): string {
  return "[TEAM TESTING · LIVE DEEPSEEK API · SYNTHETIC BUSINESS DATA] This reply came from the external provider. No live customer or financial records were sent.";
}

export async function generateTeamConversation(params: {
  identity: ZeliIdentity;
  message: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<ExternalConversationResult | null> {
  const policy = await getConversationPolicy(
    params.identity.tenantId,
    params.identity.userId
  );
  if (policy.state !== "team_testing" || !policy.allowed) return null;
  if (circuitState(TEAM_CIRCUIT_KEY) === "open") return null;

  const userHash = auditReference(params.identity.userId);
  const tenantHash = auditReference(params.identity.tenantId ?? "none");
  const requestId = providerRequestId();
  const limits = await checkProviderLimits(tenantHash, userHash);
  if (!limits.allowed) {
    await recordProviderUsage({
      requestId,
      tenantId: params.identity.tenantId,
      userId: params.identity.userId,
      roleCategory: params.identity.role,
      provider: "deepseek",
      model: policy.model,
      purpose: "team_testing:limits",
      schemaVersion: "zeli-team-testing-v1",
      decision: "denied",
      reasonCategory: limits.reason,
    });
    return null;
  }

  try {
    const message = await redactKnownTenantIdentifiers(
      params.identity.tenantId,
      params.message
    );
    const history = await Promise.all(
      params.history.map(async (item) => ({
        role: item.role,
        content: await redactKnownTenantIdentifiers(
          params.identity.tenantId,
          item.content
        ),
      }))
    );

    const result = await requestDeepSeekTeamConversation({
      message,
      history,
      policy,
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
    });
    recordCircuitSuccess(TEAM_CIRCUIT_KEY);
    await recordProviderUsage({
      requestId,
      tenantId: params.identity.tenantId,
      userId: params.identity.userId,
      roleCategory: params.identity.role,
      provider: "deepseek",
      model: policy.model,
      purpose: "team_testing:conversation",
      schemaVersion: "zeli-team-testing-v1",
      decision: "success",
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens ?? undefined,
      outputTokens: result.outputTokens ?? undefined,
    });
    return {
      text: `${result.text}\n\n${teamTestingDisclosure()}`,
      provider: "deepseek-conversation",
      model: policy.model,
      synthetic: true,
      redactions: result.redactions,
    };
  } catch (error) {
    recordCircuitFailure(TEAM_CIRCUIT_KEY);
    const code =
      error instanceof ConversationProviderError ? error.code : "provider_error";
    await recordProviderUsage({
      requestId,
      tenantId: params.identity.tenantId,
      userId: params.identity.userId,
      roleCategory: params.identity.role,
      provider: "deepseek",
      model: policy.model,
      purpose: "team_testing:conversation",
      schemaVersion: "zeli-team-testing-v1",
      decision: "error",
      reasonCategory: code,
    });
    if (process.env.NODE_ENV !== "test") {
      console.warn(`[ZELI TEAM TESTING] external provider unavailable (${code})`);
    }
    return null;
  }
}

/** Status for the workspace banner. Contains no secrets or approval values. */
export async function getConversationStatus(
  tenantId?: string | null,
  userId?: string | null
) {
  const policy = await getConversationPolicy(tenantId, userId);
  return {
    mode: conversationModeFor(policy),
    state: policy.allowed ? policy.state : "disabled",
    provider: policy.allowed ? policy.provider : null,
    model: policy.allowed ? policy.model : null,
    message: policy.reason,
    approvalRequired: policy.approvalRequired,
    credentialConfigured: policy.credentialConfigured,
    teamTesting: policy.teamTesting,
    teamTesterActive: policy.teamTesterActive,
    teamDisclosureAccepted: policy.teamDisclosureAccepted,
    teamDisclosureVersion: policy.teamDisclosureVersion,
  };
}
