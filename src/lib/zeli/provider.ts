import { MockZeliProvider } from "./mock-provider";
import { externalAiStatus, type ExternalAiStatus } from "./provider-policy";
import type { ZeliProvider } from "./types";

/**
 * Provider selection is intentionally not configurable in this release.
 *
 * The conversational workspace answers from the internal deterministic engine
 * and the server-computed business snapshot. ZELI_PROVIDER is ignored for
 * selection; a future external provider must be added behind the privacy
 * gateway and an approved code change.
 */
export function getZeliProvider(): ZeliProvider {
  return new MockZeliProvider();
}

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
