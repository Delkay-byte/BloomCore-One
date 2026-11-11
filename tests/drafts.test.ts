import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAFT_SCHEMA_VERSION,
  DRAFT_TTL_MS,
  clearSessionDrafts,
  deleteDraft,
  listDrafts,
  loadDraft,
  pruneExpiredDrafts,
  sanitizeDraftData,
  saveDraft,
} from "@/lib/offline/drafts";
import {
  clearOfflineScope,
  closeCurrentOfflineSession,
  deleteDatabase,
  listOfflineDatabaseNames,
  setOfflineScope,
} from "@/lib/offline/scope";
import { openOfflineDatabase } from "@/lib/offline/store";
import { createUnlockRecord } from "@/lib/offline/crypto";
import {
  clearCurrentOfflineContext,
  getCurrentOfflineContext,
  savePreparedContext,
} from "@/lib/offline/device-store";
import { lockOfflineWorkspace, unlockOfflineWorkspace } from "@/lib/offline/unlock";

const PASSPHRASE = "draft protection passphrase";

async function prepareProtectedWorkspace(): Promise<void> {
  const now = new Date().toISOString();
  const { record } = await createUnlockRecord(PASSPHRASE);
  await savePreparedContext({
    tenantId: "tenant-1",
    userId: "user-a",
    userName: "User A",
    role: "collector",
    modules: ["susu"],
    moduleStates: { susu: { deviceId: "device-1", preparedAt: now, lastSyncedAt: now } },
    unlock: record,
    preparedAt: now,
    authorizedAt: now,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    lastSyncedAt: now,
    active: false,
    activeModule: null,
  });
  await unlockOfflineWorkspace((await getCurrentOfflineContext())!, PASSPHRASE);
}

describe("form drafts", () => {
  beforeEach(async () => {
    clearSessionDrafts();
    lockOfflineWorkspace();
    await clearCurrentOfflineContext();
    closeCurrentOfflineSession();
    for (const name of await listOfflineDatabaseNames()) {
      await deleteDatabase(name).catch(() => {});
    }
    clearOfflineScope();
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
  });

  it("saves and restores a draft with tenant/user ownership metadata", async () => {
    const saved = await saveDraft("customer:new", "susu.customer.create", {
      fullName: "Ama Mensah",
      phone: "+233200000000",
    });
    expect(saved.tenantId).toBe("tenant-1");
    expect(saved.userId).toBe("user-a");
    expect(saved.schemaVersion).toBe(DRAFT_SCHEMA_VERSION);

    const restored = await loadDraft<{ fullName: string }>("customer:new");
    expect(restored?.data.fullName).toBe("Ama Mensah");
    expect(restored?.expiresAt).toBeTruthy();
  });

  it("does not expose one user's draft to another user", async () => {
    await saveDraft("customer:new", "susu.customer.create", { fullName: "User A" });

    closeCurrentOfflineSession();
    clearOfflineScope();
    setOfflineScope({ tenantId: "tenant-1", userId: "user-b" });

    expect(await loadDraft("customer:new")).toBeNull();
  });

  it("does not expose a draft across tenants", async () => {
    await saveDraft("customer:new", "susu.customer.create", { fullName: "User A" });

    closeCurrentOfflineSession();
    clearOfflineScope();
    setOfflineScope({ tenantId: "tenant-2", userId: "user-a" });

    expect(await loadDraft("customer:new")).toBeNull();
  });

  it("strips passwords, tokens and MFA secrets before writing", async () => {
    await saveDraft("portal:new", "susu.portal", {
      fullName: "Ama",
      password: "super-secret",
      temporaryPassword: "another-secret",
      mfaSecret: "JBSWY3DPEHPK3PXP",
      recoveryCodes: ["abc", "def"],
      nested: { authToken: "jwt", safe: "kept" },
    });

    const raw = await loadDraft<Record<string, unknown>>("portal:new");
    expect(raw?.data).toMatchObject({ fullName: "Ama", nested: { safe: "kept" } });
    expect(JSON.stringify(raw?.data)).not.toContain("super-secret");
    expect(JSON.stringify(raw?.data)).not.toContain("JBSWY3DPEHPK3PXP");
    expect(JSON.stringify(raw?.data)).not.toContain("jwt");
  });

  it("expires old drafts instead of restoring stale work", async () => {
    // A pre-hardening plaintext record is the only kind that can carry a stale
    // expiry in IndexedDB; session drafts are pruned on read too.
    const db = await openOfflineDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put({
        id: "customer:new",
        draftKey: "customer:new",
        tenantId: "tenant-1",
        userId: "user-a",
        workflow: "susu.customer.create",
        schemaVersion: DRAFT_SCHEMA_VERSION,
        updatedAt: new Date(Date.now() - 10_000).toISOString(),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        data: { fullName: "Old" },
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    expect(await loadDraft("customer:new")).toBeNull();
  });

  it("keeps online drafts out of IndexedDB instead of storing plaintext", async () => {
    const saved = await saveDraft("customer:new", "susu.customer.create", {
      fullName: "Ama Mensah",
      phone: "+233200000000",
    });
    expect(saved.storage).toBe("session");

    const db = await openOfflineDatabase();
    const raw = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction("drafts", "readonly").objectStore("drafts").getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    expect(raw).toHaveLength(0);

    const restored = await loadDraft<{ fullName: string }>("customer:new");
    expect(restored?.data.fullName).toBe("Ama Mensah");
  });

  it("clears a draft after a successful submission", async () => {
    await saveDraft("customer:new", "susu.customer.create", { fullName: "Ama" });
    await deleteDraft("customer:new");
    expect(await loadDraft("customer:new")).toBeNull();
  });

  it("lists and prunes drafts", async () => {
    await saveDraft("a", "workflow", { value: 1 });
    await saveDraft("b", "workflow", { value: 2 });
    expect((await listDrafts()).length).toBe(2);
    expect(await pruneExpiredDrafts()).toBe(0);
  });

  it("encrypts drafts when an unlock exists and fails closed while locked", async () => {
    await prepareProtectedWorkspace();
    const saved = await saveDraft("customer:protected", "susu.customer.create", {
      fullName: "Secret Customer",
      accountId: "acct-secret",
    });
    expect(saved.storage).toBe("protected");
    expect(saved.data).toEqual({});

    const db = await openOfflineDatabase();
    const raw = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction("drafts", "readonly").objectStore("drafts").getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    expect(JSON.stringify(raw)).not.toContain("Secret Customer");
    expect(JSON.stringify(raw)).not.toContain("acct-secret");

    lockOfflineWorkspace();
    await expect(loadDraft("customer:protected")).rejects.toMatchObject({
      name: "OfflineLockedError",
    });

    await unlockOfflineWorkspace(
      (await getCurrentOfflineContext())!,
      PASSPHRASE
    );
    const restored = await loadDraft<{ fullName: string }>("customer:protected");
    expect(restored?.data.fullName).toBe("Secret Customer");
  });

  it("does not persist passwords or tokens in either storage mode", async () => {
    await saveDraft("secret-form", "susu.portal", {
      fullName: "Ama",
      password: "plain-text-password",
      otp: "123456",
      token: "jwt-token",
    });
    const restored = await loadDraft<Record<string, unknown>>("secret-form");
    const encoded = JSON.stringify(restored);
    expect(encoded).not.toContain("plain-text-password");
    expect(encoded).not.toContain("123456");
    expect(encoded).not.toContain("jwt-token");
  });

  it("uses a seven-day default retention window", () => {
    expect(DRAFT_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("removes secret keys recursively", () => {
    expect(
      sanitizeDraftData({
        password: "x",
        nested: { apiToken: "y", keep: "z" },
        list: [{ secret: "a", value: 1 }],
      })
    ).toEqual({ nested: { keep: "z" }, list: [{ value: 1 }] });
  });

  it("preserves zero, false, decimals, arrays and long notes exactly", async () => {
    const note = "Short by GH₵0.50 — customer paid with a torn note. ".repeat(20);
    const payload = {
      openingCash: 0,
      decimal: 12.34,
      confirmed: false,
      note,
      expenses: [
        { description: "Transport", amount: 0 },
        { description: "Data & airtime — “shop”", amount: 5.5 },
      ],
    };

    await saveDraft("daily:roundtrip", "worker.daily_account", payload);
    const restored = await loadDraft<typeof payload>("daily:roundtrip");

    expect(restored?.data).toEqual(payload);
    expect(restored?.data.openingCash).toBe(0);
    expect(restored?.data.confirmed).toBe(false);
    expect(restored?.data.decimal).toBe(12.34);
  });

  it("resolves the session without assuming the Susu module", async () => {
    closeCurrentOfflineSession();
    clearOfflineScope();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return new Response(
        JSON.stringify({ userId: "user-momo", tenant: { id: "tenant-momo" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const record = await saveDraft("worker:draft", "worker.daily_account", {
        openingCash: 0,
      });
      expect(record.userId).toBe("user-momo");
      expect(record.tenantId).toBe("tenant-momo");

      const requested = String(fetchMock.mock.calls[0]?.[0]);
      expect(requested).toBe("/api/auth/me");
      expect(requested).not.toContain("module=susu");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a failed session lookup instead of hanging in a saving state", async () => {
    closeCurrentOfflineSession();
    clearOfflineScope();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 }))
    );

    try {
      await expect(
        saveDraft("worker:auth-failure", "worker.daily_account", { openingCash: 1 })
      ).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("legacy plaintext draft migration", () => {
  beforeEach(async () => {
    clearSessionDrafts();
    lockOfflineWorkspace();
    await clearCurrentOfflineContext();
    closeCurrentOfflineSession();
    for (const name of await listOfflineDatabaseNames()) {
      await deleteDatabase(name).catch(() => {});
    }
    clearOfflineScope();
    setOfflineScope({ tenantId: "tenant-1", userId: "user-a" });
  });

  async function putLegacyDraft(
    draftKey: string,
    data: Record<string, unknown>,
    updatedAt: string,
    scope: { tenantId: string; userId: string } = {
      tenantId: "tenant-1",
      userId: "user-a",
    }
  ): Promise<void> {
    const db = await openOfflineDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put({
        id: draftKey,
        draftKey,
        tenantId: scope.tenantId,
        userId: scope.userId,
        workflow: "susu.customer.create",
        schemaVersion: DRAFT_SCHEMA_VERSION,
        updatedAt,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        data,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function rawDraftRows(): Promise<Array<Record<string, unknown>>> {
    const db = await openOfflineDatabase();
    const rows = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const request = db.transaction("drafts", "readonly").objectStore("drafts").getAll();
      request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows;
  }

  it("moves a legacy-only draft to session storage and verifies deletion", async () => {
    await putLegacyDraft("legacy-only", { fullName: "Legacy" }, new Date().toISOString());

    const restored = await loadDraft<{ fullName: string }>("legacy-only");
    expect(restored?.data.fullName).toBe("Legacy");
    expect(restored?.storage).toBe("session");
    expect(restored?.plaintextCleanupPending).toBeUndefined();
    expect(await rawDraftRows()).toHaveLength(0);
  });

  it("keeps the newer session copy when an older legacy row remains", async () => {
    await saveDraft("both", "susu.customer.create", { fullName: "Session newer" });
    await putLegacyDraft(
      "both",
      { fullName: "Legacy older" },
      new Date(Date.now() - 60_000).toISOString()
    );

    const restored = await loadDraft<{ fullName: string }>("both");
    expect(restored?.data.fullName).toBe("Session newer");
    expect(await rawDraftRows()).toHaveLength(0);
  });

  it("preserves a newer legacy draft by copying it to session storage", async () => {
    await saveDraft("both", "susu.customer.create", { fullName: "Session older" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await putLegacyDraft("both", { fullName: "Legacy newer" }, new Date().toISOString());

    const restored = await loadDraft<{ fullName: string }>("both");
    expect(restored?.data.fullName).toBe("Legacy newer");
    expect(await rawDraftRows()).toHaveLength(0);
    // The winning copy survives a second read from session storage.
    expect((await loadDraft<{ fullName: string }>("both"))?.data.fullName).toBe(
      "Legacy newer"
    );
  });

  it("reports a retryable warning when plaintext cleanup cannot be verified", async () => {
    await putLegacyDraft("blocked-cleanup", { fullName: "Old" }, new Date().toISOString());

    const spy = vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new Error("database blocked");
    });
    try {
      await expect(
        saveDraft("blocked-cleanup", "susu.customer.create", { fullName: "New" })
      ).rejects.toMatchObject({ code: "write_failed" });
    } finally {
      spy.mockRestore();
    }

    // The session copy is preserved, and the plaintext row is still there for a
    // retry rather than being falsely reported as migrated.
    expect(await rawDraftRows()).toHaveLength(1);
    const restored = await loadDraft<{ fullName: string }>("blocked-cleanup");
    expect(restored?.data.fullName).toBe("New");
    expect(await rawDraftRows()).toHaveLength(0);
  });

  it("retries cleanup after an interrupted migration without losing input", async () => {
    // Simulate an interruption: session copy written first, plaintext not yet
    // removed. A reload sees both and reconciles safely.
    await saveDraft("interrupted", "susu.customer.create", { fullName: "Kept" });
    await putLegacyDraft(
      "interrupted",
      { fullName: "Kept" },
      new Date(Date.now() - 1_000).toISOString()
    );

    const first = await loadDraft<{ fullName: string }>("interrupted");
    expect(first?.data.fullName).toBe("Kept");
    expect(await rawDraftRows()).toHaveLength(0);
    const reloaded = await loadDraft<{ fullName: string }>("interrupted");
    expect(reloaded?.data.fullName).toBe("Kept");
  });

  it("never migrates a draft from a different tenant or user scope", async () => {
    await putLegacyDraft("foreign", { fullName: "Other user" }, new Date().toISOString(), {
      tenantId: "tenant-2",
      userId: "user-b",
    });
    expect(await loadDraft("foreign")).toBeNull();
  });

  it("clears only session drafts on sign-out, never protected drafts", async () => {
    await saveDraft("session-only", "susu.customer.create", { fullName: "Session" });
    await prepareProtectedWorkspace();
    await saveDraft("protected", "susu.customer.create", { fullName: "Protected" });
    expect(await rawDraftRows()).toHaveLength(1);

    clearSessionDrafts();

    expect(await loadDraft("session-only")).toBeNull();
    const protectedDraft = await loadDraft<{ fullName: string }>("protected");
    expect(protectedDraft?.data.fullName).toBe("Protected");
    expect(await rawDraftRows()).toHaveLength(1);
  });
});
