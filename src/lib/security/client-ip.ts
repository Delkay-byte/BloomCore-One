import { isIP } from "net";

/**
 * Safe client-IP extraction.
 *
 * Threat model
 * ------------
 * Render terminates TLS at its edge and forwards platform headers. `X-Forwarded-For`
 * is NOT safe for security decisions on Render: the platform appends to whatever
 * the client sent, so the left-most entry is attacker-controlled.
 *
 * Public traffic reaches this service through Cloudflare only (the Render
 * subdomain is disabled), and Cloudflare overwrites `CF-Connecting-IP` at the
 * edge, so that header is the one identity we can attribute. It is still only
 * consulted when the application has been explicitly told it runs behind a
 * trusted proxy (`TRUSTED_PROXY_HEADERS=true`, auto-enabled when Render sets
 * `RENDER=true`).
 *
 * `True-Client-IP` is NOT trusted by default: Cloudflare does not guarantee
 * overwriting it, so a client can send one and have it forwarded. It is used
 * only when an operator explicitly sets `TRUST_TRUE_CLIENT_IP=true` after
 * verifying the edge is configured to replace it.
 *
 * `X-Real-IP` is never trusted, and there is no X-Forwarded-For fallback.
 */

export type IpSource = "cf-connecting-ip" | "true-client-ip" | "untrusted";

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

  // Cloudflare always overwrites this header at the edge.
  const cfConnectingIp = normalizeIp(headers.get("cf-connecting-ip"));
  if (cfConnectingIp) {
    return { ip: cfConnectingIp, source: "cf-connecting-ip" };
  }

  // Opt-in only: requires an operator-verified edge that replaces the header.
  if (process.env.TRUST_TRUE_CLIENT_IP === "true") {
    const trueClientIp = normalizeIp(headers.get("true-client-ip"));
    if (trueClientIp) return { ip: trueClientIp, source: "true-client-ip" };
  }

  // Deliberately no X-Forwarded-For / X-Real-IP fallback. An attacker who can
  // reach the service without the trusted edge must not choose their bucket.
  return { ip: null, source: "untrusted" };
}

/** Stable rate-limit key for a client IP. Unknown clients share one bucket. */
export function ipBucketKey(result: ClientIpResult): string {
  return result.ip ?? "unknown";
}
