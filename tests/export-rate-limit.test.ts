/**
 * Regression tests for scoped export rate limits on the three audit/export
 * routes. Counters are database-backed and keyed HMAC; no raw token, email or
 * IP address is stored. Tests use only the disposable unit database.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./setup";
import {
  enforceExportRateLimit,
  exportRateLimitResponse,
  type ExportKind,
} from "@/lib/security/export-rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";

const BASE = 1_800_000_000_000;

async function exhaust(kind: ExportKind, actor: string, tenant: string) {
  const policy = kind === "zeliAnalytics"
    ? RATE_LIMITS.zeliExportBurst
    : kind === "association"
      ? RATE_LIMITS.associationExportBurst
      : RATE_LIMITS.auditExportBurst;
  for (let i = 0; i < policy.limit; i++) {
    const outcome = await enforceExportRateLimit(kind, actor, tenant, BASE + i * 10);
    expect(outcome).toBeNull();
  }
}

beforeEach(async () => {
  await prisma.rateLimitCounter.deleteMany();
});

describe("scoped export rate limits", () => {
  it("allows legitimate use, then returns 429 with Retry-After", async () => {
    await exhaust("zeliAnalytics", "actor-a", "tenant-a");
    const blocked = await enforceExportRateLimit("zeliAnalytics", "actor-a", "tenant-a", BASE + 100);
    expect(blocked).not.toBeNull();
    const response = exportRateLimitResponse(blocked!);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps separate buckets for separate tenants and actors", async () => {
    await exhaust("association", "actor-a", "tenant-a");
    expect(
      await enforceExportRateLimit("association", "actor-a", "tenant-a", BASE + 100)
    ).not.toBeNull();
    expect(
      await enforceExportRateLimit("association", "actor-a", "tenant-b", BASE + 100)
    ).toBeNull();
    expect(
      await enforceExportRateLimit("association", "actor-b", "tenant-a", BASE + 100)
    ).toBeNull();
  });

  it("resets the short burst bucket in a later window", async () => {
    await exhaust("audit", "actor-a", "tenant-a");
    expect(
      await enforceExportRateLimit("audit", "actor-a", "tenant-a", BASE + 100)
    ).not.toBeNull();
    const afterWindow = await enforceExportRateLimit(
      "audit",
      "actor-a",
      "tenant-a",
      BASE + RATE_LIMITS.auditExportBurst.windowMs + 1
    );
    expect(afterWindow).toBeNull();
  });

  it("enforces the sustained ceiling even when burst windows roll over", async () => {
    const policy = RATE_LIMITS.zeliExportSustained;
    for (let i = 0; i < policy.limit; i++) {
      const outcome = await enforceExportRateLimit(
        "zeliAnalytics",
        "actor-sustained",
        "tenant-sustained",
        BASE + i * 11_000
      );
      expect(outcome).toBeNull();
    }
    const blocked = await enforceExportRateLimit(
      "zeliAnalytics",
      "actor-sustained",
      "tenant-sustained",
      BASE + policy.limit * 11_000
    );
    expect(blocked).not.toBeNull();
  });

  it("never stores a raw actor or tenant identifier in a counter key", async () => {
    await enforceExportRateLimit("zeliAnalytics", "sensitive-actor@example.test", "tenant-secret-id", BASE);
    const rows = await prisma.rateLimitCounter.findMany();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.key).not.toContain("sensitive-actor");
      expect(row.key).not.toContain("tenant-secret-id");
    }
  });

  it("caps concurrent expensive requests with a short shared burst bucket", async () => {
    const results = await Promise.all(
      Array.from({ length: RATE_LIMITS.zeliExportBurst.limit + 3 }, (_, i) =>
        enforceExportRateLimit("zeliAnalytics", "actor-concurrent", "tenant-a", BASE + i)
      )
    );
    const allowed = results.filter((r) => r === null).length;
    expect(allowed).toBe(RATE_LIMITS.zeliExportBurst.limit);
  });
});
