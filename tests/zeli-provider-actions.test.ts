import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { prisma, cleanDatabase } from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name) ? { name, value: mockCookieStore.get(name)! } : undefined,
    set: (name: string, value: string) => mockCookieStore.set(name, value),
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  emergencyDisableZeliProvider,
  getZeliProviderControlState,
  setZeliProviderMode,
} from "@/lib/actions/zeli-provider.actions";
import { setPlatformSession } from "@/lib/platform-auth";
import { getEffectiveProviderPolicy } from "@/lib/zeli/provider-control";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function platformSession() {
  const admin = await prisma.platformSuperAdmin.create({
    data: {
      email: `provider-admin-${Date.now()}@test.local`,
      fullName: "Provider Admin",
      passwordHash: "not-used",
      status: "active",
    },
  });
  await setPlatformSession({
    adminId: admin.id,
    email: admin.email,
    fullName: admin.fullName,
    tokenVersion: 0,
  });
  return admin;
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
  vi.stubEnv("RATE_LIMIT_HMAC_SECRET", "provider-test-rate-limit-secret");
  vi.stubEnv("DEEPSEEK_API_KEY", "sk-test");
  vi.stubEnv("ZELI_PROVIDER", "deepseek");
  vi.stubEnv("ZELI_DEEPSEEK_APPROVED", "true");
});

describe("platform provider controls", () => {
  it("rejects an unauthenticated platform call", async () => {
    await expect(
      setZeliProviderMode({ mode: "synthetic", reason: "Must not be allowed" })
    ).rejects.toThrow("Not authenticated");
  });

  it("refuses the approved production mode even with a key and flags", async () => {
    await platformSession();
    const result = await setZeliProviderMode({
      mode: "approved",
      reason: "Would activate production processing",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("locked");
    const policy = await getEffectiveProviderPolicy();
    expect(policy.state).toBe("disabled");
  });

  it("requires environment permission before synthetic mode", async () => {
    await platformSession();
    const result = await setZeliProviderMode({
      mode: "synthetic",
      reason: "Enable synthetic provider testing",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("ZELI_SYNTHETIC_TESTING_ALLOWED");
  });

  it("enables synthetic mode when explicitly permitted, then the emergency stop wins", async () => {
    vi.stubEnv("ZELI_SYNTHETIC_TESTING_ALLOWED", "true");
    await platformSession();
    const enabled = await setZeliProviderMode({
      mode: "synthetic",
      reason: "Approved synthetic integration testing window",
    });
    expect(enabled.success).toBe(true);
    expect((await getEffectiveProviderPolicy()).state).toBe("synthetic");

    const stopped = await emergencyDisableZeliProvider(
      "Immediate stop requested by the owner"
    );
    expect(stopped.success).toBe(true);
    const policy = await getEffectiveProviderPolicy();
    expect(policy.allowed).toBe(false);
    expect(policy.emergencyDisabled).toBe(true);
    expect((await getZeliProviderControlState()).control.emergencyDisabled).toBe(true);
  });

  it("does not let a key or approval flag enable anything by itself", async () => {
    await getEffectiveProviderPolicy();
    const state = await getZeliProviderControlState().catch(() => null);
    expect(state).toBeNull(); // no platform session
    const policy = await getEffectiveProviderPolicy();
    expect(policy.state).toBe("disabled");
    expect(policy.credentialConfigured).toBe(true);
  });
});
