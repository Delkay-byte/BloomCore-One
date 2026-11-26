import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "net";

/**
 * Safe client-IP extraction for abuse controls.
 *
 * Threat model
 * ------------
 * A direct request to a Render `onrender.com` origin can set any forwarding
 * header. A header name alone is therefore NOT proof of a trusted edge. This
 * module trusts `CF-Connecting-IP` only when the request also carries an
 * HMAC-SHA256 proof over that exact IP, produced by the Cloudflare edge with a
 * secret that is never sent to the browser. Without that configured proof the
 * result fails closed to a shared "unknown" bucket; account-keyed throttles
 * and Turnstile remain the primary abuse controls.
 *
 * `X-Forwarded-For`, `X-Real-IP` and `True-Client-IP` are never sufficient.
 * `True-Client-IP` additionally requires explicit opt-in AND a valid proof.
 */

export type IpSource = "cf-connecting-ip" | "true-client-ip" | "untrusted";
export const EDGE_PROOF_HEADER = "x-bloomcore-edge-auth";

export interface ClientIpResult {
  /** Validated IP address, or null when it cannot be determined safely. */
  ip: string | null;
  source: IpSource;
}

function normalizeIp(value: string | null): string | null {
  if (!value) return null;
  // The trusted edge supplies exactly one address. A comma list is ambiguous
  // and must never be split into a client-chosen bucket.
  if (value.includes(",")) return null;
  const candidate = value.trim();
  if (!candidate) return null;
  const cleaned = candidate.replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "");
  if (isIP(cleaned) === 0) return null;
  return cleaned.toLowerCase();
}

function trustedProxyEnabled(): boolean {
  if (process.env.TRUSTED_PROXY_HEADERS === "true") return true;
  if (process.env.TRUSTED_PROXY_HEADERS === "false") return false;
  return process.env.RENDER === "true" || Boolean(process.env.RENDER_SERVICE_ID);
}

/**
 * Constant-time comparison of an edge-supplied proof. Returns false when the
 * shared secret is absent, too short, or the proof is missing or malformed.
 */
function edgeProofValid(headers: Headers, ip: string): boolean {
  const secret = process.env.EDGE_PROXY_SECRET;
  if (!secret || secret.length < 32) return false;
  const supplied = headers.get(EDGE_PROOF_HEADER);
  if (!supplied || !/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = createHmac("sha256", secret).update(ip).digest("hex");
  const a = Buffer.from(supplied.toLowerCase(), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function getClientIp(headers: Headers): ClientIpResult {
  if (!trustedProxyEnabled()) {
    return { ip: null, source: "untrusted" };
  }

  const cfConnectingIp = normalizeIp(headers.get("cf-connecting-ip"));
  if (cfConnectingIp && edgeProofValid(headers, cfConnectingIp)) {
    return { ip: cfConnectingIp, source: "cf-connecting-ip" };
  }

  // Opt-in only, and still cryptographically bound to the edge secret.
  if (process.env.TRUST_TRUE_CLIENT_IP === "true") {
    const trueClientIp = normalizeIp(headers.get("true-client-ip"));
    if (trueClientIp && edgeProofValid(headers, trueClientIp)) {
      return { ip: trueClientIp, source: "true-client-ip" };
    }
  }

  // No X-Forwarded-For / X-Real-IP fallback. Direct-origin callers cannot
  // select or rotate their rate-limit bucket with client-controlled headers.
  return { ip: null, source: "untrusted" };
}

/** Stable rate-limit key for a client IP. Unknown clients share one bucket. */
export function ipBucketKey(result: ClientIpResult): string {
  return result.ip ?? "unknown";
}
