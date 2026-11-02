import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinateDatabaseClosure } from "@/lib/offline/coordination";
import { deleteDatabase, isDeletionPending } from "@/lib/offline/scope";

const CHANNEL = "bloomcore-offline-coordination-v1";

describe("cross-tab offline database deletion coordination", () => {
  const peers: BroadcastChannel[] = [];

  afterEach(() => {
    for (const peer of peers.splice(0)) peer.close();
    vi.restoreAllMocks();
  });

  it("waits for another tab to acknowledge closure", async () => {
    const peer = new BroadcastChannel(CHANNEL);
    peers.push(peer);
    peer.onmessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === "probe") {
        peer.postMessage({
          type: "presence",
          requestId: message.requestId,
          tabId: "peer-tab",
        });
      }
      if (message.type === "close") {
        peer.postMessage({
          type: "closed",
          requestId: message.requestId,
          tabId: "peer-tab",
          databaseName: message.databaseName,
          ok: true,
        });
      }
    };

    const result = await coordinateDatabaseClosure("db-coordinated", {
      probeMs: 50,
      closeMs: 500,
    });
    expect(result.coordinated).toBe(true);
    expect(result.peers).toBe(1);
    expect(result.missing).toEqual([]);
  });

  it("fails coordination when a known tab does not acknowledge", async () => {
    const peer = new BroadcastChannel(CHANNEL);
    peers.push(peer);
    peer.onmessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === "probe") {
        peer.postMessage({
          type: "presence",
          requestId: message.requestId,
          tabId: "silent-tab",
        });
      }
      // Deliberately never answer the close request.
    };

    const result = await coordinateDatabaseClosure("db-uncoordinated", {
      probeMs: 50,
      closeMs: 150,
    });
    expect(result.coordinated).toBe(false);
    expect(result.missing).toEqual(["silent-tab"]);
  });

  it("treats a blocked delete as pending until the browser confirms", async () => {
    const fakeRequest = {
      onsuccess: null as null | (() => void),
      onerror: null as null | (() => void),
      onblocked: null as null | (() => void),
      error: new Error("blocked"),
    };
    vi.spyOn(indexedDB, "deleteDatabase").mockImplementation(() => {
      queueMicrotask(() => fakeRequest.onblocked?.());
      return fakeRequest as unknown as IDBOpenDBRequest;
    });

    let blocked = false;
    let settled = false;
    const first = deleteDatabase("blocked-retry-db", {
      onBlocked: () => {
        blocked = true;
      },
    });
    const tracked = first.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(blocked).toBe(true);
    expect(settled).toBe(false);
    expect(isDeletionPending("blocked-retry-db")).toBe(true);

    // A second call while the request is pending returns the same request.
    const second = deleteDatabase("blocked-retry-db");
    expect(second).toBe(first);

    fakeRequest.onsuccess?.();
    await tracked;
    await second;
    expect(settled).toBe(true);
    expect(isDeletionPending("blocked-retry-db")).toBe(false);
  });
});
