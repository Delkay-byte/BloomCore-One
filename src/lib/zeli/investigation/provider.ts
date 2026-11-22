/**
 * The narrow external provider used by AI investigation.
 *
 * This is a separate path from the aggregate insight provider and from general
 * conversation. It is approved only for the dedicated paid package, sends only the
 * minimised evidence pack, and validates the answer against the same draft schema and
 * numeric grounding a human reviewer sees. Any failure — timeout, rate limit, bad
 * JSON, an ungrounded figure — returns control to the deterministic explanation
 * rather than showing a half-checked answer.
 */

import type { InvestigationEvidence } from "./evidence";
import { ungroundedClaims, validateDraft, type InvestigationDraftPayload } from "./schema";
import { buildPromptPackage } from "./prompt";

export const INVESTIGATION_PROVIDER_ENDPOINT = "https://api.deepseek.com/chat/completions";
export const INVESTIGATION_PROVIDER_DEFAULT_MODEL = "deepseek-chat";
export const INVESTIGATION_PROVIDER_TIMEOUT_MS = 20_000;
export const INVESTIGATION_PROVIDER_MAX_RESPONSE_BYTES = 256 * 1024;
export const INVESTIGATION_PROVIDER_MAX_OUTPUT_TOKENS = 1_200;

export type ProviderFailureCode =
  | "not_configured"
  | "runtime_not_permitted"
  | "timeout"
  | "rate_limited"
  | "provider_status"
  | "oversized_response"
  | "invalid_json"
  | "empty_response"
  | "schema_rejected"
  | "ungrounded"
  | "network";

export class InvestigationProviderError extends Error {
  readonly code: ProviderFailureCode;
  constructor(code: ProviderFailureCode, message: string) {
    super(message);
    this.name = "InvestigationProviderError";
    this.code = code;
  }
}

export interface ExternalProviderSettings {
  apiKey: string;
  model: string;
  configured: boolean;
}

/** Credentials are read from the environment at call time, never cached. */
export function externalProviderSettings(
  env: NodeJS.ProcessEnv = process.env
): ExternalProviderSettings {
  const apiKey = (env.DEEPSEEK_API_KEY ?? "").trim();
  const model = (env.DEEPSEEK_INVESTIGATION_MODEL ?? env.DEEPSEEK_MODEL ?? "").trim();
  return {
    apiKey,
    model: model || INVESTIGATION_PROVIDER_DEFAULT_MODEL,
    configured: apiKey.length > 0,
  };
}

/**
 * Whether this runtime may call a real provider at all.
 *
 * Tests never call out, and an E2E build has no credential by construction. This is
 * checked in addition to the package gates, so a configured key in a test run still
 * cannot send evidence anywhere.
 */
export function externalProviderPermittedForRuntime(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.NODE_ENV === "test") return false;
  if ((env.ZELI_EXTERNAL_AI_DISABLED ?? "").trim() === "1") return false;
  return externalProviderSettings(env).configured;
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > INVESTIGATION_PROVIDER_MAX_RESPONSE_BYTES) {
    throw new InvestigationProviderError("oversized_response", "The provider response was too large.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > INVESTIGATION_PROVIDER_MAX_RESPONSE_BYTES) {
    throw new InvestigationProviderError("oversized_response", "The provider response was too large.");
  }
  return text;
}

/**
 * Ask the provider for a draft and accept it only if it passes every check.
 *
 * The prompt tells the model that the pack is data. Validation does not rely on the
 * model obeying that: an answer that cites an unapproved source, states a figure that
 * was not measured, or omits its limitations is rejected outright.
 */
export async function requestExternalDraft(
  evidence: InvestigationEvidence,
  options: {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<{ payload: InvestigationDraftPayload; model: string; latencyMs: number }> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const settings = externalProviderSettings(env);
  if (!settings.configured) {
    throw new InvestigationProviderError("not_configured", "No provider credential is configured.");
  }
  if (!externalProviderPermittedForRuntime(env)) {
    throw new InvestigationProviderError(
      "runtime_not_permitted",
      "This runtime may not call an external provider."
    );
  }

  const prompt = buildPromptPackage(JSON.stringify(evidence));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INVESTIGATION_PROVIDER_TIMEOUT_MS);
  const started = Date.now();
  let text: string;
  try {
    const response = await fetchImpl(INVESTIGATION_PROVIDER_ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: INVESTIGATION_PROVIDER_MAX_OUTPUT_TOKENS,
        stream: false,
      }),
    });
    if (response.status === 429) {
      throw new InvestigationProviderError("rate_limited", "The provider is rate limiting.");
    }
    text = await readBounded(response);
    if (!response.ok) {
      throw new InvestigationProviderError(
        "provider_status",
        `The provider returned ${response.status}.`
      );
    }
  } catch (error) {
    if (error instanceof InvestigationProviderError) throw error;
    const name = (error as Error)?.name;
    throw new InvestigationProviderError(
      name === "AbortError" ? "timeout" : "network",
      name === "AbortError" ? "The provider did not answer in time." : "The provider could not be reached."
    );
  } finally {
    clearTimeout(timer);
  }

  let body: { choices?: Array<{ message?: { content?: string | null } }> } | null;
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new InvestigationProviderError("invalid_json", "The provider returned invalid JSON.");
  }
  const content = body?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new InvestigationProviderError("empty_response", "The provider returned no answer.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new InvestigationProviderError("invalid_json", "The provider answer was not JSON.");
  }

  const validated = validateDraft({ raw, evidence });
  if (!validated.ok || !validated.payload) {
    throw new InvestigationProviderError(
      "schema_rejected",
      `The provider answer was rejected: ${validated.errors.slice(0, 3).join(" ")}`
    );
  }
  const ungrounded = ungroundedClaims(validated.payload, evidence);
  if (ungrounded.length > 0) {
    throw new InvestigationProviderError(
      "ungrounded",
      `The provider answer contained unmeasured values: ${ungrounded.slice(0, 3).join(" ")}`
    );
  }

  return {
    payload: validated.payload,
    model: settings.model,
    latencyMs: Date.now() - started,
  };
}
