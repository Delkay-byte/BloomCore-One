import {
  ProviderDisabledError,
  PROVIDER_DISABLED_MESSAGE,
} from "./provider-policy";
import type { ZeliProvider, ZeliProviderRequest, ZeliProviderResponse } from "./types";

/**
 * DeepSeek adapter — retained for a future approved integration only.
 *
 * Hard-off in this release. `available()` always fails and `generate()` throws
 * before constructing a request, reading a URL or touching `fetch`. There is no
 * fallback path that can reach the network while external processing is
 * disabled, even if ZELI_PROVIDER=deepseek, ZELI_DEEPSEEK_APPROVED=true and a
 * DEEPSEEK_API_KEY are all present.
 *
 * A future implementation must send only gateway-approved aggregate payloads,
 * not raw conversation history or tenant records.
 */
export class DeepSeekZeliProvider implements ZeliProvider {
  name = "deepseek-disabled";
  model = "not-configured";

  available(): { ok: false; reason: string } {
    return { ok: false, reason: PROVIDER_DISABLED_MESSAGE };
  }

  async generate(_request: ZeliProviderRequest): Promise<ZeliProviderResponse> {
    void _request;
    throw new ProviderDisabledError();
  }
}
