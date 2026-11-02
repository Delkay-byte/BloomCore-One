import { isIP } from "net";

/**
 * Safe client-IP extraction.
 *
 * Threat model
 * ------------
 * Render terminates TLS at its edge and forwards platform headers. `X-Forwarded-For`
 * is NOT safe for security decisions on Render: the platform appends to whatever
 * the client sent, so the left-most entry is attacker-controlled. Our production
 * host therefore trusts only the platform-set client-IP headers:
 *
 *   True-Client-IP   (Cloudflare/Render edge)
 *   CF-Connecting-IP (Cloudflare edge)
 *
 * Both are only consulted when the application has been explicitly told it runs
 * behind a trusted proxy (`TRUSTED_PROXY_HEADERS=true`, auto-enabled when Render
 * sets `RENDER=true`). In every other environment the function returns
 * `{ ip: null }`, which callers must treat as an unidentifiable client rather
 * than falling back to a spoofable value.
 *
 * `X-Real-IP` is never trusted because Render does not guarantee overwriting it.
 */

export type IpSource = "true-client-ip" | "cf-connecting-ip" | "untrusted";

export interface ClientIpResult {
  /** Validated IP address, or null when it cannot be determined safely. */
  ip: string | null;
  source: IpSource;
}

function normalizeIp(value: string | null): string | null {
  if (!value) return null;
  const candidate = value.split(",")[0]?.trim();
  if (!candidate) return null;
  // Strip IPv6 brackets and an IPv4-mapped prefix for stable bucket keys.
  const cleaned = candidate.replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "");
  if (isIP(cleaned) === 0) return null;
  return cleaned.toLowerCase();
}

function trustedProxyEnabled(): boolean {
  if (process.env.TRUSTED_PROXY_HEADERS === "true") return true;
  if (process.env.TRUSTED_PROXY_HEADERS === "false") return false;
  return process.env.RENDER === "true" || Boolean(process.env.RENDER_SERVICE_ID);
}

export function getClientIp(headers: Headers): ClientIpResult {
  if (!trustedProxyEnabled()) {
    return { ip: null, source: "untrusted" };
  }

  const trueClientIp = normalizeIp(headers.get("true-client-ip"));
  if (trueClientIp) return { ip: trueClientIp, source: "true-client-ip" };

  const cfConnectingIp = normalizeIp(headers.get("cf-connecting-ip"));
  if (cfConnectingIp) {
    return { ip: cfConnectingIp, source: "cf-connecting-ip" };
  }

  // Deliberately no X-Forwarded-For / X-Real-IP fallback. An attacker who can
  // reach the service without the trusted edge must not choose their bucket.
  return { ip: null, source: "untrusted" };
}

/** Stable rate-limit key for a client IP. Unknown clients share one bucket. */
export function ipBucketKey(result: ClientIpResult): string {
  return result.ip ?? "unknown";
}
