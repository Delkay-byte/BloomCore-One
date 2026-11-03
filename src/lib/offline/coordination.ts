/**
 * Cross-tab coordination for destructive IndexedDB operations.
 *
 * IndexedDB deletion is blocked while any connection holds the database open.
 * A blocked request stays queued in the browser; rejecting a JavaScript promise
 * does not cancel it. This module asks every responsive tab to close the named
 * database and waits for acknowledgements before the caller issues deletion.
 *
 * Limits are explicit: a frozen or suspended tab cannot answer. If such a tab
 * still holds a connection, the browser reports `blocked` and the caller must
 * show the deletion as pending, never as successful.
 */

import { closeOfflineConnections } from "./scope";

const CHANNEL_NAME = "bloomcore-offline-coordination-v1";

type CoordinationMessage =
  | { type: "probe"; requestId: string; tabId: string }
  | { type: "presence"; requestId: string; tabId: string }
  | { type: "close"; requestId: string; tabId: string; databaseName: string }
  | { type: "closed"; requestId: string; tabId: string; databaseName: string; ok: boolean };

type MessageHandler = (message: CoordinationMessage) => void;

let channel: BroadcastChannel | null = null;
let tabId: string | null = null;
const handlers = new Set<MessageHandler>();

function currentTabId(): string {
  if (!tabId) {
    tabId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `tab-${Math.random().toString(36).slice(2)}`;
  }
  return tabId;
}

function ensureChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (channel) return channel;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as CoordinationMessage | undefined;
      if (!message || typeof message.type !== "string") return;
      handlers.forEach((handler) => handler(message));
    };
    return channel;
  } catch {
    channel = null;
    return null;
  }
}

/** Register a listener; used by tests and the deletion coordinator. */
export function onCoordinationMessage(handler: MessageHandler): () => void {
  ensureChannel();
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Close the database across responsive tabs and wait for acknowledgements. */
export async function coordinateDatabaseClosure(
  databaseName: string,
  options: { probeMs?: number; closeMs?: number } = {}
): Promise<{ coordinated: boolean; peers: number; missing: string[] }> {
  const bus = ensureChannel();
  if (!bus) {
    // No cross-tab channel. Only this tab can be closed; deletion may still
    // block and will be reported as pending.
    closeOfflineConnections(databaseName);
    return { coordinated: true, peers: 0, missing: [] };
  }

  const requestId = currentTabId();
  const self = currentTabId();
  const peers = new Set<string>();
  const closed = new Set<string>();

  const listener = (message: CoordinationMessage) => {
    if (message.type === "probe" && message.requestId === requestId) {
      bus.postMessage({
        type: "presence",
        requestId,
        tabId: self,
      } satisfies CoordinationMessage);
      return;
    }
    if (message.type === "presence" && message.requestId === requestId) {
      if (message.tabId !== self) peers.add(message.tabId);
      return;
    }
    if (message.type === "close" && message.requestId === requestId) {
      closeOfflineConnections(message.databaseName);
      bus.postMessage({
        type: "closed",
        requestId,
        tabId: self,
        databaseName: message.databaseName,
        ok: true,
      } satisfies CoordinationMessage);
      return;
    }
    if (message.type === "closed" && message.requestId === requestId) {
      if (message.tabId !== self) closed.add(message.tabId);
    }
  };

  handlers.add(listener);
  try {
    bus.postMessage({ type: "probe", requestId, tabId: self } satisfies CoordinationMessage);
    await delay(options.probeMs ?? 350);
    bus.postMessage({
      type: "close",
      requestId,
      tabId: self,
      databaseName,
    } satisfies CoordinationMessage);

    // Always close this tab's own connections before deletion.
    closeOfflineConnections(databaseName);

    const deadline = Date.now() + (options.closeMs ?? 1_500);
    while (Date.now() < deadline) {
      if (Array.from(peers).every((peer) => closed.has(peer))) break;
      await delay(50);
    }

    const missing = Array.from(peers).filter((peer) => !closed.has(peer));
    return { coordinated: missing.length === 0, peers: peers.size, missing };
  } finally {
    handlers.delete(listener);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
