import { MockZeliProvider } from "./mock-provider";
import {
  externalAiStatus,
  PROVIDER_DISABLED_MESSAGE,
  type ExternalAiStatus,
} from "./provider-policy";
import {
  getEffectiveProviderPolicy,
  providerStatusMessage,
  type EffectiveProviderPolicy,
} from "./provider-control";
import type { ZeliProvider } from "./types";

/**
 * The conversational transport always uses the internal deterministic engine.
 * DeepSeek, when allowed, only enhances explanations through the privacy
 * gateway; it never becomes the chat transport or a source of financial facts.
 */
export function getZeliProvider(): ZeliProvider {
  return new MockZeliProvider();
}

/** Async provider status backed by the global control and effective policy. */
export async function getZeliProviderStatus(tenantId?: string | null): Promise<{
  provider: string;
  model: string;
  available: boolean;
  reason?: string;
  external: EffectiveProviderPolicy;
  message: string;
}> {
  const provider = getZeliProvider();
  const availability = provider.available();
  const external = await getEffectiveProviderPolicy(tenantId);
  return {
    provider: provider.name,
    model: provider.model,
    available: availability.ok,
    reason: availability.ok
      ? "Zeli is answering from BloomCore One's internal deterministic engine. External AI is optional and never authoritative."
      : availability.reason,
    external,
    message: providerStatusMessage(external),
  };
}

/**
 * Legacy synchronous status used only where no database context exists. It
 * always describes the production code default (disabled); UI and actions use
 * `getZeliProviderStatus`.
 */
export function zeliProviderStatus(): {
  provider: string;
  model: string;
  available: boolean;
  reason?: string;
  external: ExternalAiStatus;
} {
  const provider = getZeliProvider();
  const availability = provider.available();
  const external = externalAiStatus();
  return {
    provider: provider.name,
    model: provider.model,
    available: availability.ok,
    reason: availability.ok
      ? "Zeli is answering from BloomCore One's internal deterministic engine. No external AI provider is used."
      : availability.reason,
    external,
  };
}

export { PROVIDER_DISABLED_MESSAGE };
