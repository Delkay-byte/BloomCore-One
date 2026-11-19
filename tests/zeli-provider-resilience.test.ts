import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanDatabase, prisma } from "./setup";
import {
  checkProviderLimits,
  circuitState,
  recordCircuitFailure,
  recordCircuitSuccess,
} from "@/lib/zeli/provider-audit";

beforeEach(async () => {
  await cleanDatabase();
  vi.stubEnv("ZELI_PROVIDER_USER_DAILY_LIMIT", "20");
  vi.stubEnv("ZELI_PROVIDER_TENANT_DAILY_LIMIT", "100");
});

describe("external provider resilience controls", () => {
  it("blocks further calls once the per-user daily limit is reached", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      requestId: `audit-limit-${index}`,
      tenantHash: "tenant-hash",
      userHash: "user-hash",
      roleCategory: "admin",
      provider: "deepseek",
      model: "deepseek-flash",
      purpose: "team_testing:conversation",
      schemaVersion: "zeli-team-testing-v1",
      decision: "success",
    }));
    await prisma.zeliProviderUsage.createMany({ data: rows });

    await expect(checkProviderLimits("tenant-hash", "user-hash")).resolves.toEqual({
      allowed: false,
      reason: "user_daily_limit",
    });
    await expect(checkProviderLimits("tenant-hash", "another-user")).resolves.toEqual({
      allowed: true,
    });
  });

  it("opens the circuit after repeated failures and resets on success", () => {
    const provider = `audit-circuit-${Date.now()}`;
    expect(circuitState(provider)).toBe("closed");
    for (let index = 0; index < 4; index += 1) recordCircuitFailure(provider);
    expect(circuitState(provider)).toBe("open");
    recordCircuitSuccess(provider);
    expect(circuitState(provider)).toBe("closed");
  });
});
