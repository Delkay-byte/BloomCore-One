import { DeepSeekZeliProvider } from "./deepseek-provider";
import { MockZeliProvider } from "./mock-provider";
import type { ZeliProvider } from "./types";

export function getZeliProvider(): ZeliProvider {
  const configured = (process.env.ZELI_PROVIDER || "mock").toLowerCase();
  if (configured === "deepseek") return new DeepSeekZeliProvider();
  return new MockZeliProvider();
}

export function zeliProviderStatus(): {
  provider: string;
  model: string;
  available: boolean;
  reason?: string;
} {
  const provider = getZeliProvider();
  const availability = provider.available();
  return {
    provider: provider.name,
    model: provider.model,
    available: availability.ok,
    reason: availability.ok ? undefined : availability.reason,
  };
}
