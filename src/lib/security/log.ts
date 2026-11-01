import { keyedHash, sha256 } from "./crypto";

/**
 * Structured security event logging.
 *
 * Every event is a single JSON line on stdout/stderr so Render's log stream can
 * index it. Callers pass only allow-listed fields; this module never accepts a
 * raw request body, password, token or cookie value.
 */

export type SecurityOutcome = "success" | "failure" | "blocked" | "error";

export interface SecurityEvent {
  event: string;
  outcome: SecurityOutcome;
  actorType?: "user" | "customer" | "platform_admin" | "anonymous";
  actorId?: string | null;
  tenantId?: string | null;
  ip?: string | null;
  route?: string;
  reason?: string;
  requestId?: string | null;
}

/** Fields that must never appear in a security log line. */
const FORBIDDEN_KEYS = new Set([
  "password",
  "passwordhash",
  "token",
  "tokenhash",
  "jwt",
  "cookie",
  "authorization",
  "secret",
  "mfasecret",
  "recoverycode",
  "idempotencykey",
]);

function safeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  // Store a keyed fingerprint, not the raw address: enough to correlate
  // repeated abuse, insufficient to reconstruct a visitor's IP from logs.
  return keyedHash(`ip:${ip}`).slice(0, 16);
}

function safeRequestId(value: string | null | undefined): string | null {
  if (!value) return null;
  return sha256(value).slice(0, 16);
}

export function logSecurityEvent(event: SecurityEvent): void {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    kind: "security_event",
    event: event.event,
    outcome: event.outcome,
    actorType: event.actorType ?? "anonymous",
    actorId: event.actorId ?? null,
    tenantId: event.tenantId ?? null,
    ip: safeIp(event.ip),
    route: event.route ?? null,
    reason: event.reason ?? null,
    requestId: safeRequestId(event.requestId),
  };

  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) delete record[key];
  }

  const line = JSON.stringify(record);
  if (event.outcome === "failure" || event.outcome === "blocked" || event.outcome === "error") {
    console.warn(line);
  } else {
    console.info(line);
  }
}
