import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DRAFT_SCHEMA_VERSION,
  DRAFT_TTL_MS,
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

describe("form drafts", () => {
  beforeEach(async () => {
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
    await saveDraft("customer:new", "susu.customer.create", { fullName: "Old" });
    const stored = await loadDraft<Record<string, unknown>>("customer:new");
    expect(stored).not.toBeNull();

    // Rewrite the expiry into the past, then read again.
    const db = await openOfflineDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put({
        ...stored,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    expect(await loadDraft("customer:new")).toBeNull();
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
});
