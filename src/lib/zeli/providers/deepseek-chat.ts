import type { ConversationProviderPolicy } from "./conversation-policy";

/**
 * DeepSeek chat transport with tool calling.
 *
 * Server-only. One fixed endpoint, allow-listed model, bounded timeout and
 * response size, redirects rejected. This module performs no business logic and
 * executes no tool: it only carries messages between the orchestrator and the
 * provider.
 */

export const DEEPSEEK_CHAT_ENDPOINT = "https://api.deepseek.com/chat/completions";

const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_TOKENS = 700;

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export class ChatTransportError extends Error {
  code: string;
  constructor(message: string, code = "provider_error") {
    super(message);
    this.name = "ChatTransportError";
    this.code = code;
  }
}

export interface ChatResult {
  message: ChatMessage;
  finishReason: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  model: string;
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) {
    throw new ChatTransportError("Provider response was too large.", "oversized_response");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new ChatTransportError("Provider response was too large.", "oversized_response");
  }
  return text;
}

export async function requestDeepSeekChat(params: {
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  toolChoice?: "auto" | "required" | "none";
  policy: ConversationProviderPolicy;
  apiKey: string;
  maxTokens?: number;
}): Promise<ChatResult> {
  if (!params.policy.allowed) {
    throw new ChatTransportError("Conversational provider policy denied this request.", "policy_denied");
  }
  if (!params.apiKey) {
    throw new ChatTransportError("Provider credential is missing.", "missing_credential");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  try {
    const response = await fetch(DEEPSEEK_CHAT_ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${params.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: params.policy.model,
        messages: params.messages,
        ...(params.tools && params.tools.length
          ? { tools: params.tools, tool_choice: params.toolChoice ?? "auto" }
          : {}),
        thinking: { type: "disabled" },
        temperature: 0.2,
        max_tokens: params.maxTokens ?? MAX_OUTPUT_TOKENS,
        stream: false,
      }),
    });

    const body = await readBounded(response);
    if (!response.ok) {
      let providerType = "";
      try {
        const parsedError = JSON.parse(body) as {
          error?: { type?: unknown; code?: unknown };
        };
        const raw = parsedError.error?.type ?? parsedError.error?.code ?? "";
        providerType = String(raw).replace(/[^a-z0-9_]/gi, "").slice(0, 40);
      } catch {
        providerType = "";
      }
      throw new ChatTransportError(
        `Provider returned ${response.status}.`,
        `provider_status_${response.status}${providerType ? `:${providerType}` : ""}`
      );
    }

    let parsed: {
      model?: string;
      choices?: Array<{
        message?: {
          role?: string;
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ChatTransportError("Provider returned invalid JSON.", "invalid_response");
    }

    const choice = parsed.choices?.[0];
    const message = choice?.message;
    if (!message) {
      throw new ChatTransportError("Provider returned no message.", "empty_response");
    }

    const toolCalls = (message.tool_calls ?? []).map((call, index) => ({
      id: call.id || `call_${index}`,
      type: "function" as const,
      function: {
        name: String(call.function?.name ?? ""),
        arguments: String(call.function?.arguments ?? "{}"),
      },
    }));

    const content = typeof message.content === "string" ? message.content : "";
    if (!content.trim() && toolCalls.length === 0) {
      throw new ChatTransportError("Provider returned no content.", "empty_response");
    }
    if (toolCalls.length > 4) {
      throw new ChatTransportError("Provider requested too many tools.", "too_many_tools");
    }

    return {
      message: {
        role: "assistant",
        content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finishReason: choice?.finish_reason ?? null,
      latencyMs: Date.now() - started,
      inputTokens: parsed.usage?.prompt_tokens ?? null,
      outputTokens: parsed.usage?.completion_tokens ?? null,
      model: String(parsed.model ?? params.policy.model),
    };
  } catch (error) {
    if (error instanceof ChatTransportError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new ChatTransportError("Provider timed out.", "timeout");
    }
    throw new ChatTransportError("Provider request failed.", "network_error");
  } finally {
    clearTimeout(timer);
  }
}
