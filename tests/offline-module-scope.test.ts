/**
 * Regression tests for module-aware offline identity and storage scope.
 *
 * Covers the production failure where a dual-role account working in the Susu
 * tab had a valid prepared device context ("Offline Ready") but the neutral
 * `/api/auth/me` lookup resolved the MoMo session, returned no tenant, and made
 * the financial queue unreadable.
 */

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/actions/susu-dashboard.actions", () => ({
  getCollectorDashboardStats: vi.fn(async () => ({ toVisit: [] })),
}));

vi.mock("@/lib/security/tab-session-client", () => ({
  ensureTabSessionWorker: vi.fn(async () => ({})),
}));

import {
  addTransaction,
  getOfflineQueueSummary,
  type OfflineTransaction,
} from "@/lib/offline/store";
import {
  OfflineScopeError,
  clearOfflineScope,
  closeCurrentOfflineSession,
  deleteDatabase,
  getOfflineScope,
  listOfflineDatabaseNames,
  offlineDatabaseName,
  setOfflineScope,
} from "@/lib/offline/scope";
import { getOrCreateDeviceId } from "@/lib/offline/device";
import {
  OFFLINE_AUTH_TIMEOUT_MS,
  clearCurrentOfflineContext,
  getCurrentOfflineContext,
  savePreparedContext,
  type OfflinePreparedContext,
} from "@/lib/offline/device-store";
import { prepareOfflineAccess } from "@/lib/offline/preparation";

function preparedContext(
  suffix: string,
  overrides: Partial<OfflinePreparedContext> = {}
): OfflinePreparedContext {
  const now = new Date();
  const at = now.toISOString();
  return {
    tenantId: `tenant-${suffix}`,
    userId: `user-${suffix}`,
    userName: "Ama Collector",
    role: "worker",
    modules: ["susu"],
    moduleStates: {
      susu: { deviceId: `device-${suffix}`, preparedAt: at, lastSyncedAt: at },
    },
    preparedAt: at,
    authorizedAt: at,
    expiresAt: new Date(now.getTime() + OFFLINE_AUTH_TIMEOUT_MS).toISOString(),
    lastSyncedAt: at,
    active: false,
    activeModule: null,
    ...overrides,
  };
}

function transaction(id: string, tenantId: string, userId: string): OfflineTransaction {
  return {
    id,
    deviceId: "device-1",
    tenantId,
    userId,
    type: "contribution",
    idempotencyKey: id,
    payload: "{}",
    status: "pending_sync",
    retryCount: 0,
    maxRetries: 5,
    failureReason: null,
    serverResult: null,
    localTimestamp: new Date().toISOString(),
    syncStartedAt: null,
    syncedAt: null,
    createdAt: new Date().toISOString(),
  };
}

function identityResponse(options: {
  userId?: string;
  tenantId?: string | null;
  module?: string;
  momoEnabled?: boolean;
  susuEnabled?: boolean;
  role?: string;
  modules?: string[];
} = {}) {
  const tenantId =
    options.tenantId === undefined ? "tenant-shared" : options.tenantId;
  return new Response(
    JSON.stringify({
      userId: options.userId ?? "user-shared",
      fullName: "Shared User",
      role: options.role ?? "worker",
      module: options.module ?? "susu",
      momoEnabled: options.momoEnabled ?? true,
      susuEnabled: options.susuEnabled ?? true,
      tenant: tenantId
        ? {
            id: tenantId,
            name: "Shared Business",
            modules:
              options.modules ??
              (options.momoEnabled ?? true ? ["momo", "susu"] : ["susu"]),
          }
        : null,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function stubPreparationEnvironment(
  pathname = "/collector/dashboard"
): void {
  vi.stubGlobal("window", {
    location: { pathname },
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal("navigator", {
    onLine: true,
    serviceWorker: { controller: { postMessage: vi.fn() } },
  });
  vi.stubGlobal("location", { origin: "https://maacash.test" });
  vi.stubGlobal("caches", {
    match: vi.fn(async () => new Response("cached", { status: 200 })),
  });
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  closeCurrentOfflineSession();
  clearOfflineScope();
  await clearCurrentOfflineContext();
  for (const name of await listOfflineDatabaseNames()) {
    await deleteDatabase(name).catch(() => undefined);
  }
  clearOfflineScope();
});

describe("module-aware offline scope", () => {
  it("asks the server about the workspace module that was requested", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return identityResponse({ module: "susu" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scope = await getOfflineScope("susu");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/auth/me?module=susu"
    );
    expect(scope).toEqual({ tenantId: "tenant-shared", userId: "user-shared" });
  });

  it("infers the module from the open collector workspace path", async () => {
    vi.stubGlobal("window", {
      location: { pathname: "/collector/dashboard" },
      dispatchEvent: vi.fn(),
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return identityResponse({ module: "susu" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await getOfflineScope();

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/auth/me?module=susu"
    );
  });

  it("opens the existing queue under the server-resolved tenant/user scope", async () => {
    const context = preparedContext(`existing-${Date.now()}`, {
      tenantId: "tenant-existing",
      userId: "user-existing",
    });
    setOfflineScope({ tenantId: context.tenantId, userId: context.userId });
    await addTransaction(
      transaction("tx-existing", context.tenantId, context.userId)
    );
    closeCurrentOfflineSession();
    clearOfflineScope();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        identityResponse({
          userId: context.userId,
          tenantId: context.tenantId,
          module: "susu",
        })
      )
    );

    const summary = await getOfflineQueueSummary();
    expect(summary.pending).toBe(1);
    expect(summary.unresolved).toBe(1);
  });

  it("does not select an unrelated user's database after a workspace switch", async () => {
    setOfflineScope({ tenantId: "tenant-shared", userId: "user-a" });
    await addTransaction(transaction("tx-a", "tenant-shared", "user-a"));
    closeCurrentOfflineSession();
    clearOfflineScope();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        identityResponse({ userId: "user-b", tenantId: "tenant-shared" })
      )
    );
    expect((await getOfflineQueueSummary()).pending).toBe(0);

    clearOfflineScope();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        identityResponse({ userId: "user-a", tenantId: "tenant-shared" })
      )
    );
    expect((await getOfflineQueueSummary()).pending).toBe(1);
  });

  it.each([401, 403])(
    "never falls back to cached context after an explicit %i",
    async (status) => {
      const context = preparedContext(`denied-${status}-${Date.now()}`);
      await savePreparedContext(context);
      clearOfflineScope();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}", { status }))
      );

      await expect(getOfflineScope("susu")).rejects.toMatchObject({
        code: "unauthenticated",
      });
      expect((await getCurrentOfflineContext())?.userId).toBe(context.userId);
    }
  );

  it("reports an HTTP 200 with a null tenant as no_tenant instead of guessing", async () => {
    clearOfflineScope();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => identityResponse({ tenantId: null, module: "susu" }))
    );

    await expect(getOfflineScope("susu")).rejects.toMatchObject({
      code: "no_tenant",
    });
  });

  it("uses a valid prepared context only for a genuine network failure", async () => {
    const context = preparedContext(`network-${Date.now()}`);
    await savePreparedContext(context);
    clearOfflineScope();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    const scope = await getOfflineScope("susu");
    expect(scope).toEqual({
      tenantId: context.tenantId,
      userId: context.userId,
    });
  });

  it("refuses an expired prepared context during a network failure", async () => {
    const context = preparedContext(`expired-${Date.now()}`, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await savePreparedContext(context);
    clearOfflineScope();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    await expect(getOfflineScope("susu")).rejects.toMatchObject({
      code: "offline_expired",
    });
  });

  it("does not use a Susu-only prepared context for the MoMo workspace", async () => {
    const context = preparedContext(`mismatch-${Date.now()}`, {
      modules: ["susu"],
      moduleStates: {
        susu: {
          deviceId: "device-susu",
          preparedAt: new Date().toISOString(),
          lastSyncedAt: null,
        },
      },
    });
    await savePreparedContext(context);
    clearOfflineScope();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    await expect(getOfflineScope("momo")).rejects.toMatchObject({
      code: "module_mismatch",
    });
  });

  it("rejects an identity answer for a different workspace", async () => {
    clearOfflineScope();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => identityResponse({ module: "momo" }))
    );

    await expect(getOfflineScope("susu")).rejects.toMatchObject({
      code: "module_mismatch",
    });
  });

  it("rejects an identity answer that omits the workspace module", async () => {
    clearOfflineScope();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              userId: "user-shared",
              tenant: { id: "tenant-shared" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    await expect(getOfflineScope("susu")).rejects.toMatchObject({
      code: "module_mismatch",
    });
  });

  it("does not reuse a Susu-seeded scope for a MoMo resolution", async () => {
    const seeded = { tenantId: "tenant-seeded", userId: "user-seeded" };
    setOfflineScope(seeded, "seeded", "susu");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return identityResponse({
        module: "momo",
        tenantId: "tenant-fresh",
        userId: "user-fresh",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const momo = await getOfflineScope("momo");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(momo).toEqual({ tenantId: "tenant-fresh", userId: "user-fresh" });

    // The Susu seed remains a distinct, validated cache entry.
    expect(await getOfflineScope("susu")).toEqual(seeded);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses a seeded server scope for the first device-database access", async () => {
    vi.stubGlobal("window", {
      location: { pathname: "/collector/dashboard" },
      dispatchEvent: vi.fn(),
    });
    const scope = {
      tenantId: `tenant-seed-${Date.now()}`,
      userId: "user-seed",
    };
    setOfflineScope(scope, "seeded", "susu");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network must not be consulted for a seeded scope");
      })
    );

    await getOrCreateDeviceId();

    expect(await listOfflineDatabaseNames()).toContain(
      offlineDatabaseName(scope)
    );
    expect(await getOfflineScope("susu")).toEqual(scope);
  });

  it("recovers after a transient server failure instead of poisoning the cache", async () => {
    clearOfflineScope();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(identityResponse({ module: "susu" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOfflineScope("susu")).rejects.toBeInstanceOf(
      OfflineScopeError
    );
    const scope = await getOfflineScope("susu");
    expect(scope.userId).toBe("user-shared");
  });
});

describe("module-aware offline preparation", () => {
  function preparationFetch(meResponse: Response) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/auth/me")) return meResponse;
      if (url === "/api/offline/enroll") {
        return new Response(
          JSON.stringify({ success: true, authorizedAt: new Date().toISOString() }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("ok", { status: 200 });
    });
  }

  it("validates the Susu identity when preparing from the collector workspace", async () => {
    stubPreparationEnvironment();
    const fetchMock = preparationFetch(identityResponse({ module: "susu" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await prepareOfflineAccess("susu", "test passphrase 123");
    expect(result.ok).toBe(true);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input) === "/api/auth/me?module=susu"
      )
    ).toBe(true);

    const context = await getCurrentOfflineContext();
    expect(context?.userId).toBe("user-shared");
    expect(context?.tenantId).toBe("tenant-shared");
    expect(context?.modules).toContain("susu");
  });

  it("does not cache the MoMo financial dashboard for offline use", async () => {
    stubPreparationEnvironment("/worker/dashboard");
    const fetchMock = preparationFetch(
      identityResponse({
        module: "momo",
        modules: ["momo"],
        susuEnabled: false,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await prepareOfflineAccess("momo", "test passphrase 123");
    expect(result.ok).toBe(false);
    expect(result.preparedModules).toEqual([]);
    expect(result.failedModules).toContain("momo");
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input) === "/api/auth/me?module=momo"
      )
    ).toBe(true);
  });

  it("prepares the protected Susu module and does not cache MoMo financial HTML", async () => {
    stubPreparationEnvironment();
    vi.stubGlobal(
      "fetch",
      preparationFetch(
        identityResponse({ module: "susu", modules: ["momo", "susu"] })
      )
    );

    const result = await prepareOfflineAccess("susu", "test passphrase 123");
    expect(result.ok).toBe(true);
    expect(result.preparedModules).toEqual(["susu"]);
    expect(result.failedModules).toContain("momo");
    const context = await getCurrentOfflineContext();
    expect(context?.modules).toEqual(["susu"]);
  });

  it("reports a missing tenant truthfully and preserves the older prepared context", async () => {
    stubPreparationEnvironment();
    const older = preparedContext(`older-${Date.now()}`);
    await savePreparedContext(older);

    vi.stubGlobal(
      "fetch",
      preparationFetch(identityResponse({ tenantId: null, module: "susu" }))
    );

    const result = await prepareOfflineAccess("susu");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("The signed-in business could not be confirmed.");

    const current = await getCurrentOfflineContext();
    expect(current?.tenantId).toBe(older.tenantId);
    expect(current?.expiresAt).toBe(older.expiresAt);
  });

  it("does not create new authorization from an unauthenticated response", async () => {
    stubPreparationEnvironment();
    const older = preparedContext(`unauth-${Date.now()}`);
    await savePreparedContext(older);
    vi.stubGlobal(
      "fetch",
      preparationFetch(new Response("{}", { status: 401 }))
    );

    const result = await prepareOfflineAccess("susu");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Sign in to this workspace online");

    const current = await getCurrentOfflineContext();
    expect(current?.userId).toBe(older.userId);
    expect(current?.authorizedAt).toBe(older.authorizedAt);
  });

  it("does not delete or overwrite queued records when preparation fails", async () => {
    stubPreparationEnvironment();
    const context = preparedContext(`queue-${Date.now()}`);
    await savePreparedContext(context);
    setOfflineScope({ tenantId: context.tenantId, userId: context.userId });
    await addTransaction(
      transaction("tx-preserved", context.tenantId, context.userId)
    );
    closeCurrentOfflineSession();
    clearOfflineScope();
    setOfflineScope({ tenantId: context.tenantId, userId: context.userId });

    vi.stubGlobal(
      "fetch",
      preparationFetch(new Response("{}", { status: 500 }))
    );

    const result = await prepareOfflineAccess("susu");
    expect(result.ok).toBe(false);

    const summary = await getOfflineQueueSummary();
    expect(summary.pending).toBe(1);
    expect(summary.unresolved).toBe(1);
  });
});
