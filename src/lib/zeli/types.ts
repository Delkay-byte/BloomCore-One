import type { TenantContext } from "@/lib/tenant";

/** The authenticated identity a Zeli turn runs under. Never taken from chat input. */
export interface ZeliIdentity {
  userId: string;
  fullName: string;
  role: "admin" | "worker" | "collector" | "customer";
  tenantId: string | null;
  module: string;
}

export interface ZeliSource {
  label: string;
  href?: string;
  detail?: string;
}

export interface ZeliToolOutcome {
  tool: string;
  ok: boolean;
  summary: string;
  sources: ZeliSource[];
  durationMs: number;
}

export interface ZeliContextBlock {
  title: string;
  data: unknown;
}

export interface ZeliProviderRequest {
  system: string;
  question: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  context: ZeliContextBlock[];
  identity: ZeliIdentity;
}

export interface ZeliProviderResponse {
  text: string;
  provider: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ZeliProvider {
  name: string;
  model: string;
  /** True only when this provider can safely process the request now. */
  available(): { ok: true } | { ok: false; reason: string };
  generate(request: ZeliProviderRequest): Promise<ZeliProviderResponse>;
}

export function identityFromContext(
  ctx: TenantContext,
  module: string
): ZeliIdentity {
  return {
    userId: ctx.userId,
    fullName: "",
    role: ctx.role as ZeliIdentity["role"],
    tenantId: ctx.tenantId,
    module,
  };
}
