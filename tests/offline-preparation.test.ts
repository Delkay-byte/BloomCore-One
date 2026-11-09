import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OFFLINE_AUTH_TIMEOUT_MS,
  clearCurrentOfflineContext,
  getCurrentOfflineContext,
  getPreparedContext,
  markOfflineSynced,
  offlineContextExpired,
  offlineContextRemainingMs,
  offlineContextSupports,
  savePreparedContext,
  setOfflineActivation,
  type OfflinePreparedContext,
} from "@/lib/offline/device-store";
import { activateOfflineAccess } from "@/lib/offline/preparation";

function context(
  suffix: string,
  overrides: Partial<OfflinePreparedContext> = {}
): OfflinePreparedContext {
  const now = new Date();
  const authorizedAt = now.toISOString();
  return {
    tenantId: `tenant-${suffix}`,
    userId: `user-${suffix}`,
    userName: "Ama Collector",
    role: "collector",
    modules: ["susu"],
    moduleStates: {
      susu: {
        deviceId: `device-${suffix}`,
        preparedAt: authorizedAt,
        lastSyncedAt: authorizedAt,
      },
    },
    preparedAt: authorizedAt,
    authorizedAt,
    expiresAt: new Date(now.getTime() + OFFLINE_AUTH_TIMEOUT_MS).toISOString(),
    lastSyncedAt: authorizedAt,
    active: false,
    activeModule: null,
    ...overrides,
  };
}

beforeEach(async () => {
  await clearCurrentOfflineContext();
});

describe("offline device preparation state", () => {
  it("persists a prepared context without any credential or token field", async () => {
    const value = context(`persist-${Date.now()}`);
    expect(await savePreparedContext(value)).toBe(true);

    const current = await getCurrentOfflineContext();
    expect(current?.userId).toBe(value.userId);
    expect(current?.modules).toEqual(["susu"]);
    expect(current?.moduleStates.susu?.deviceId).toBe(value.moduleStates.susu?.deviceId);

    const keys = Object.keys(current ?? {});
    expect(keys).not.toContain("password");
    expect(keys).not.toContain("token");
    expect(keys).not.toContain("sessionToken");
    expect(keys).not.toContain("jwt");

    const stored = await getPreparedContext(value.tenantId, value.userId);
    expect(stored).not.toBeNull();
  });

  it("activates offline mode locally without extending authorization", async () => {
    const value = context(`activate-${Date.now()}`);
    await savePreparedContext(value);
    const before = await getCurrentOfflineContext();

    const activated = await setOfflineActivation(true, "susu");
    expect(activated?.active).toBe(true);
    expect(activated?.activeModule).toBe("susu");
    expect(activated?.expiresAt).toBe(before?.expiresAt);
    expect(offlineContextSupports(activated, "susu")).toBe(true);
    expect(offlineContextSupports(activated, "momo")).toBe(false);
  });

  it("treats an expired authorization as unusable while preserving its records", async () => {
    const value = context(`expired-${Date.now()}`, {
      authorizedAt: new Date(Date.now() - OFFLINE_AUTH_TIMEOUT_MS - 1000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await savePreparedContext(value);
    const current = await getCurrentOfflineContext();
    expect(offlineContextExpired(current)).toBe(true);
    expect(offlineContextRemainingMs(current)).toBe(0);

    const activation = await setOfflineActivation(true, "susu");
    // Activation is a local flag; the caller still refuses expired operations.
    expect(activation).not.toBeNull();
    expect(await getPreparedContext(value.tenantId, value.userId)).not.toBeNull();
  });

  it("activates locally without any server request when the shell is cached", async () => {
    const value = context(`local-${Date.now()}`);
    await savePreparedContext(value);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { origin: "https://maacash.test" });
    vi.stubGlobal("navigator", { onLine: false });
    vi.stubGlobal("caches", {
      match: async () => new Response("cached", { status: 200 }),
    });

    const result = await activateOfflineAccess("susu");
    expect(result.ok).toBe(true);
    expect(result.readiness.status).toBe("active");
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("records a successful synchronization time without changing expiry", async () => {
    const value = context(`sync-${Date.now()}`);
    await savePreparedContext(value);
    const at = new Date().toISOString();
    await markOfflineSynced(value.tenantId, value.userId, at);

    const current = await getCurrentOfflineContext();
    expect(current?.lastSyncedAt).toBe(at);
    expect(current?.expiresAt).toBe(value.expiresAt);
  });

  it("sign-out clears local access but not the prepared record", async () => {
    const value = context(`signout-${Date.now()}`);
    await savePreparedContext(value);
    expect(await getCurrentOfflineContext()).not.toBeNull();

    await clearCurrentOfflineContext();
    expect(await getCurrentOfflineContext()).toBeNull();
    expect(await getPreparedContext(value.tenantId, value.userId)).not.toBeNull();
  });

  it("blocks a revoked module without deleting the prepared record", async () => {
    const value = context(`revoked-${Date.now()}`, {
      blockedModules: {
        susu: "Offline authorization for this device was revoked.",
      },
    });
    await savePreparedContext(value);
    const current = await getCurrentOfflineContext();
    expect(offlineContextSupports(current, "susu")).toBe(false);
    expect(await getPreparedContext(value.tenantId, value.userId)).not.toBeNull();
    expect(
      (await getPreparedContext(value.tenantId, value.userId))?.blockedModules?.susu
    ).toContain("revoked");
  });

  it("keeps dual-role modules separate and prepares both contexts", async () => {
    const value = context(`dual-${Date.now()}`, {
      role: "worker",
      modules: ["momo", "susu"],
      moduleStates: {
        momo: {
          deviceId: `device-dual-momo`,
          preparedAt: new Date().toISOString(),
          lastSyncedAt: null,
        },
        susu: {
          deviceId: `device-dual-susu`,
          preparedAt: new Date().toISOString(),
          lastSyncedAt: null,
        },
      },
    });
    await savePreparedContext(value);
    const current = await getCurrentOfflineContext();
    expect(current?.modules).toEqual(["momo", "susu"]);
    expect(offlineContextSupports(current, "momo")).toBe(true);
    expect(offlineContextSupports(current, "susu")).toBe(true);
    expect(current?.moduleStates.momo?.deviceId).not.toBe(
      current?.moduleStates.susu?.deviceId
    );
  });
});
