import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCurrentOfflineContext,
  getCurrentOfflineContext,
  savePreparedContext,
  setOfflineActivation,
  type OfflinePreparedContext,
} from "@/lib/offline/device-store";
import {
  deactivateOfflineAccess,
  getOfflineReadiness,
  reconcileOfflineConnectivity,
} from "@/lib/offline/preparation";
import { lockOfflineWorkspace, unlockOfflineWorkspace } from "@/lib/offline/unlock";
import { createUnlockRecord } from "@/lib/offline/crypto";

function context(): OfflinePreparedContext {
  const now = new Date().toISOString();
  return {
    tenantId: "tenant-1",
    userId: "user-a",
    userName: "User A",
    role: "collector",
    modules: ["susu"],
    moduleStates: {
      susu: { deviceId: "device-1", preparedAt: now, lastSyncedAt: now },
    },
    preparedAt: now,
    authorizedAt: now,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    lastSyncedAt: now,
    active: false,
    activeModule: null,
  };
}

const PASSPHRASE = "connectivity transition passphrase";

describe("connectivity transitions", () => {
  beforeEach(async () => {
    lockOfflineWorkspace();
    await clearCurrentOfflineContext();
    const { record } = await createUnlockRecord(PASSPHRASE);
    await savePreparedContext({ ...context(), unlock: record });
    await unlockOfflineWorkspace((await getCurrentOfflineContext())!, PASSPHRASE);
    // getOfflineReadiness checks the warmed route cache. Provide a matching
    // cache entry and a browser-like location so the readiness checks run.
    vi.stubGlobal("location", { origin: "https://maacash.test" });
    vi.stubGlobal("caches", {
      match: async () => ({ ok: true }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not report Offline Active after connectivity returns", async () => {
    await setOfflineActivation(true, "susu");
    vi.stubGlobal("navigator", { onLine: true });

    const readiness = await getOfflineReadiness("susu");
    expect(readiness.status).toBe("ready");
    expect(readiness.message).not.toMatch(/working offline/i);
  });

  it("clears the persisted activation flag during reconciliation", async () => {
    await setOfflineActivation(true, "susu");
    vi.stubGlobal("navigator", { onLine: true });

    const readiness = await reconcileOfflineConnectivity("susu");
    expect(readiness.status).toBe("ready");
    expect((await getCurrentOfflineContext())?.active).toBe(false);
  });

  it("shows Offline Active only when the network is actually down", async () => {
    await setOfflineActivation(true, "susu");
    vi.stubGlobal("navigator", { onLine: false });

    const readiness = await getOfflineReadiness("susu");
    expect(readiness.status).toBe("active");
    expect(readiness.message).toMatch(/working offline/i);
  });

  it("refuses local activation while online", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const readiness = await deactivateOfflineAccess("susu");
    expect(readiness.status).toBe("ready");
    expect((await getCurrentOfflineContext())?.active).toBe(false);
  });

  it("keeps a locked workspace locked when focus returns offline", async () => {
    lockOfflineWorkspace();
    vi.stubGlobal("navigator", { onLine: false });

    const readiness = await getOfflineReadiness("susu");
    expect(readiness.status).toBe("unlock_required");
  });

  it("keeps an expired authorization expired when focus returns offline", async () => {
    const current = await getCurrentOfflineContext();
    await savePreparedContext({
      ...current!,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      active: true,
    });
    vi.stubGlobal("navigator", { onLine: false });

    const readiness = await getOfflineReadiness("susu");
    expect(readiness.status).toBe("expired");
  });
});
