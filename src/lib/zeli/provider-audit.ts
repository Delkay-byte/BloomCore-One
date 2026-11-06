import { createHmac, randomUUID } from "crypto";
import { db } from "@/lib/db";

/** Privacy-safe audit hash for tenant/user references. */
export function auditReference(value: string): string {
  const secret =
    process.env.RATE_LIMIT_HMAC_SECRET ||
    process.env.JWT_SECRET ||
    "bloomcore-local-audit";
  return createHmac("sha256", secret).update(value).digest("hex").slice(0, 32);
}

export function providerRequestId(): string {
  return `zpr_${randomUUID()}`;
}

export const PROVIDER_LIMITS = {
  perUserPerDay: 20,
  perTenantPerDay: 100,
} as const;

function effectiveLimit(name: string, fallback: number, max: number): number {
  const configured = Number(process.env[name] ?? "");
  if (!Number.isFinite(configured) || configured < 1) return fallback;
  return Math.min(max, Math.floor(configured));
}

function userDailyLimit(): number {
  return effectiveLimit("ZELI_PROVIDER_USER_DAILY_LIMIT", PROVIDER_LIMITS.perUserPerDay, 500);
}

function tenantDailyLimit(): number {
  return effectiveLimit("ZELI_PROVIDER_TENANT_DAILY_LIMIT", PROVIDER_LIMITS.perTenantPerDay, 2000);
}

export async function checkProviderLimits(
  tenantHash: string,
  userHash: string
): Promise<{ allowed: boolean; reason?: string }> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const [userCount, tenantCount] = await Promise.all([
    db.zeliProviderUsage.count({
      where: {
        userHash,
        createdAt: { gte: start },
        decision: { in: ["success", "allowed"] },
      },
    }),
    db.zeliProviderUsage.count({
      where: {
        tenantHash,
        createdAt: { gte: start },
        decision: { in: ["success", "allowed"] },
      },
    }),
  ]);
  if (userCount >= userDailyLimit()) {
    return { allowed: false, reason: "user_daily_limit" };
  }
  if (tenantCount >= tenantDailyLimit()) {
    return { allowed: false, reason: "tenant_daily_limit" };
  }
  return { allowed: true };
}

interface CircuitState {
  failures: number;
  openUntil: number;
}

const circuits = new Map<string, CircuitState>();
const FAILURE_THRESHOLD = 4;
const OPEN_MS = 60_000;

export function circuitState(provider: string): "closed" | "open" {
  const state = circuits.get(provider);
  if (!state) return "closed";
  if (state.openUntil > Date.now()) return "open";
  circuits.delete(provider);
  return "closed";
}

export function recordCircuitSuccess(provider: string): void {
  circuits.delete(provider);
}

export function recordCircuitFailure(provider: string): void {
  const state = circuits.get(provider) ?? { failures: 0, openUntil: 0 };
  state.failures += 1;
  if (state.failures >= FAILURE_THRESHOLD) {
    state.openUntil = Date.now() + OPEN_MS;
    state.failures = 0;
  }
  circuits.set(provider, state);
}

/** Record a decision without prompts, payload values, responses or secrets. */
export async function recordProviderUsage(input: {
  requestId: string;
  tenantId: string | null;
  userId: string | null;
  roleCategory: string;
  provider: string;
  model: string;
  purpose: string;
  schemaVersion: string;
  decision: "allowed" | "denied" | "success" | "rejected" | "error";
  reasonCategory?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}): Promise<void> {
  try {
    await db.zeliProviderUsage.create({
      data: {
        requestId: input.requestId,
        tenantHash: auditReference(input.tenantId ?? "none"),
        userHash: auditReference(input.userId ?? "none"),
        roleCategory: input.roleCategory.slice(0, 40),
        provider: input.provider.slice(0, 40),
        model: input.model.slice(0, 80),
        purpose: input.purpose.slice(0, 60),
        schemaVersion: input.schemaVersion.slice(0, 40),
        decision: input.decision,
        reasonCategory: input.reasonCategory?.slice(0, 80) ?? null,
        latencyMs: input.latencyMs ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
      },
    });
  } catch (error) {
    console.error("[ZELI PROVIDER] usage audit failed", error);
  }
}
