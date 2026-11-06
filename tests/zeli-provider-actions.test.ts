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
  clearZeliProviderEmergencyStop,
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

  it("keeps the emergency stop latched when the mode is switched to synthetic afterwards (the stop must never clear on update)", async () => {
    vi.stubEnv("ZELI_SYNTHETIC_TESTING_ALLOWED", "true");
    await platformSession();
    await setZeliProviderMode({
      mode: "synthetic",
      reason: "Approved synthetic integration testing window",
    });
    const stopped = await emergencyDisableZeliProvider(
      "Immediate stop requested by the owner"
    );
    expect(stopped.success).toBe(true);

    const switched = await setZeliProviderMode({
      mode: "synthetic",
      reason: "Attempt to resume synthetic testing after a stop",
    });
    expect(switched.success).toBe(true);

    const row = await prisma.zeliProviderControl.findUnique({ where: { id: "global" } });
    expect(row?.emergencyDisabled).toBe(true);
    expect(row?.mode).toBe("synthetic");
    const policy = await getEffectiveProviderPolicy();
    expect(policy.emergencyDisabled).toBe(true);
    expect(policy.allowed).toBe(false);
    expect(policy.state).toBe("disabled");
  });

  it("keeps the emergency stop latched when the mode is set to disabled afterwards", async () => {
    await platformSession();
    await emergencyDisableZeliProvider("Immediate stop requested by the owner");
    const result = await setZeliProviderMode({
      mode: "disabled",
      reason: "Confirm external AI stays switched off",
    });
    expect(result.success).toBe(true);
    const row = await prisma.zeliProviderControl.findUnique({ where: { id: "global" } });
    expect(row?.emergencyDisabled).toBe(true);
    expect((await getEffectiveProviderPolicy()).allowed).toBe(false);
  });

  it("re-reads the latch from the database after a simulated restart", async () => {
    await platformSession();
    await emergencyDisableZeliProvider("Immediate stop requested by the owner");
    // A restart drops in-process state. The latch must come from the row, not memory.
    const row = await prisma.zeliProviderControl.findUnique({ where: { id: "global" } });
    expect(row?.emergencyDisabled).toBe(true);
    const fresh = await getEffectiveProviderPolicy();
    expect(fresh.emergencyDisabled).toBe(true);
    expect(fresh.allowed).toBe(false);
  });

  it("creates the row with the emergency stop active when disabled is chosen on a fresh install", async () => {
    await platformSession();
    const result = await setZeliProviderMode({
      mode: "disabled",
      reason: "External AI is not approved for this install yet",
    });
    expect(result.success).toBe(true);
    const row = await prisma.zeliProviderControl.findUnique({ where: { id: "global" } });
    expect(row?.emergencyDisabled).toBe(true);
  });

  it("requires an authenticated platform admin to clear the emergency stop", async () => {
    await expect(
      clearZeliProviderEmergencyStop("Owner approved resumption of testing")
    ).rejects.toThrow("Not authenticated");
  });

  it("requires a reason of at least 10 characters to clear the emergency stop", async () => {
    await platformSession();
    await emergencyDisableZeliProvider("Immediate stop requested by the owner");
    const result = await clearZeliProviderEmergencyStop("too short");
    expect(result.success).toBe(false);
    expect(result.error).toContain("at least 10 characters");
    const row = await prisma.zeliProviderControl.findUnique({ where: { id: "global" } });
    expect(row?.emergencyDisabled).toBe(true);
  });

  it("refuses to clear the emergency stop when it is not active", async () => {
    vi.stubEnv("ZELI_SYNTHETIC_TESTING_ALLOWED", "true");
    await platformSession();
    await setZeliProviderMode({
      mode: "synthetic",
      reason: "Approved synthetic integration testing window",
    });
    const result = await clearZeliProviderEmergencyStop(
      "No stop is active but a reason is supplied"
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not active");
    const row = await prisma.zeliProviderControl.findUnique({ where: { id: "global" } });
    expect(row?.emergencyDisabled).toBe(false);
    expect(row?.mode).toBe("synthetic");
  });

  it("clears only the latch and leaves the provider disabled and unenabled", async () => {
    await platformSession();
    await emergencyDisableZeliProvider("Immediate stop requested by the owner");
    const cleared = await clearZeliProviderEmergencyStop(
      "Owner reviewed the incident and approved clearing the stop"
    );
    expect(cleared.success).toBe(true);

    const row = await prisma.zeliProviderControl.findUnique({ where: { id: "global" } });
    expect(row?.emergencyDisabled).toBe(false);
    expect(row?.mode).toBe("disabled");
    expect(row?.enabled).toBe(false);
    const policy = await getEffectiveProviderPolicy();
    expect(policy.state).toBe("disabled");
    expect(policy.allowed).toBe(false);
    expect(policy.emergencyDisabled).toBe(false);
  });

  it("clearing the stop never resumes a previously blocked synthetic mode", async () => {
    await platformSession();
    await emergencyDisableZeliProvider("Immediate stop requested by the owner");
    // A blocked attempt to switch to synthetic records enabled=true but the
    // latched stop keeps policy.allowed false.
    const attempt = await setZeliProviderMode({
      mode: "synthetic",
      reason: "Attempt during the emergency stop window",
    });
    expect(attempt.success).toBe(true);
    expect(await getEffectiveProviderPolicy()).toMatchObject({ allowed: false });

    const cleared = await clearZeliProviderEmergencyStop(
      "Owner reviewed the incident and approved clearing the stop"
    );
    expect(cleared.success).toBe(true);
    const row = await prisma.zeliProviderControl.findUnique({ where: { id: "global" } });
    expect(row?.mode).toBe("disabled");
    expect(row?.enabled).toBe(false);
    const policy = await getEffectiveProviderPolicy();
    expect(policy.allowed).toBe(false);
    expect(policy.state).toBe("disabled");
  });

  it("writes an audit entry for the cleared emergency stop", async () => {
    const actor = await platformSession();
    await emergencyDisableZeliProvider("Immediate stop requested by the owner");
    const result = await clearZeliProviderEmergencyStop(
      "Owner reviewed the incident and approved clearing the stop"
    );
    expect(result.success).toBe(true);

    const entry = await prisma.platformAuditLog.findFirst({
      where: { action: "zeli.provider_emergency_cleared" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry).not.toBeNull();
    expect(entry?.actorId).toBe(actor.id);
    expect(entry?.reason).toContain("approved clearing the stop");
    const details = JSON.parse(entry?.details ?? "{}");
    expect(details.previousState.emergencyDisabled).toBe(true);
    expect(details.newState.emergencyDisabled).toBe(false);
    expect(details.previousState.mode).toBe("disabled");
    expect(details.newState.mode).toBe("disabled");
    expect(typeof details.clearedAt).toBe("string");
    expect(Number.isNaN(Date.parse(details.clearedAt))).toBe(false);
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
