/*
 * BloomCore One — per-tab session transport.
 *
 * Ordinary cookies are shared by every tab in a browser profile. This worker
 * gives each tab its own authentication handle without putting the handle in
 * the URL, localStorage, or a browser-wide cookie.
 *
 * The page posts its session handle to the worker after a successful login.
 * The worker stores that handle against the page's client id (and the id of
 * the document that the next navigation produces). Every same-origin request
 * from that tab then carries the handle in a custom header. A new tab has no
 * mapping, so it is unauthenticated even if its URL was copied from an
 * authenticated tab. A copied/duplicated tab gets a new client id and
 * therefore inherits nothing.
 *
 * Security notes:
 *  - The worker deletes any client-supplied copy of the header before adding
 *    its own, so page script cannot choose another tab's session.
 *  - The worker never returns the handle to page script; it only reports
 *    whether the current tab has one.
 *  - The handle is a short-lived, server-revocable JWT. It is stored in
 *    IndexedDB so a service-worker restart does not silently sign the tab out.
 *  - An XSS on this origin remains able to read IndexedDB, exactly as it could
 *    read a non-HttpOnly tab credential. CSP, output encoding, short session
 *    lifetime and server-side revocation remain the compensating controls.
 */

const HEADER = "x-bloomcore-tab-session";
const CLIENT_HEADER = "x-bloomcore-tab-client";
const VERSION_HEADER = "x-bloomcore-tab-version";
const VERSION = "1";
const DB_NAME = "bloomcore-tab-sessions";
const DB_VERSION = 1;
const STORE = "sessions";
const MAX_MAPPING_AGE_MS = 8 * 60 * 60 * 1000;

const memory = new Map();

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readPersisted(clientId) {
  if (!clientId) return null;
  try {
    const db = await openDatabase();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(clientId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    return value && typeof value.token === "string" ? value.token : null;
  } catch {
    return null;
  }
}

async function persist(clientId, token) {
  if (!clientId || !token) return;
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ token, savedAt: Date.now() }, clientId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // IndexedDB unavailable: the in-memory map still covers this worker life.
  }
}

async function forget(clientId) {
  if (!clientId) return;
  memory.delete(clientId);
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(clientId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

async function pruneMappings() {
  try {
    const db = await openDatabase();
    const now = Date.now();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const value = cursor.value;
        if (!value || now - Number(value.savedAt || 0) > MAX_MAPPING_AGE_MS) {
          cursor.delete();
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    for (const [key, value] of memory) {
      if (!value || now - Number(value.savedAt || 0) > MAX_MAPPING_AGE_MS) {
        memory.delete(key);
      }
    }
  } catch {
    // best effort
  }
}

async function tokenFor(clientId, resultingClientId) {
  for (const id of [clientId, resultingClientId]) {
    if (!id) continue;
    const entry = memory.get(id);
    if (entry && typeof entry.token === "string") return entry.token;
  }
  for (const id of [clientId, resultingClientId]) {
    if (!id) continue;
    const stored = await readPersisted(id);
    if (stored) {
      memory.set(id, { token: stored, savedAt: Date.now() });
      return stored;
    }
  }
  return null;
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await pruneMappings();
    })()
  );
});

self.addEventListener("message", (event) => {
  const sourceId = event.source && event.source.id;
  if (!sourceId) return;

  const data = event.data || {};
  if (data.type === "register" && typeof data.token === "string" && data.token.length < 8192) {
    const entry = { token: data.token, savedAt: Date.now() };
    memory.set(sourceId, entry);
    const persisted = persist(sourceId, data.token);
    if (typeof event.waitUntil === "function") event.waitUntil(persisted);
    if (event.source && "postMessage" in event.source) {
      event.source.postMessage({ type: "registered" });
    }
    return;
  }

  if (data.type === "clear") {
    forget(sourceId);
    if (event.source && "postMessage" in event.source) {
      event.source.postMessage({ type: "cleared" });
    }
    return;
  }

  if (data.type === "status") {
    const entry = memory.get(sourceId);
    if (event.source && "postMessage" in event.source) {
      event.source.postMessage({
        type: "status",
        authenticated: Boolean(entry && entry.token),
      });
    }
  }
});

self.addEventListener("fetch", (event) => {
  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/tab-session-sw.js") return;

  const clientId = event.clientId || "";
  const resultingClientId = event.resultingClientId || "";

  event.respondWith(
    (async () => {
      const token = await tokenFor(clientId, resultingClientId);
      if (token) {
        // Bind the new document before its subresources start loading.
        const entry = { token, savedAt: Date.now() };
        if (resultingClientId) {
          memory.set(resultingClientId, entry);
          await persist(resultingClientId, token);
        }
        if (clientId) memory.set(clientId, entry);
      }

      const headers = new Headers(event.request.headers);
      // Never let page script choose the identity used by its own request.
      headers.delete(HEADER);
      headers.delete(CLIENT_HEADER);
      headers.delete(VERSION_HEADER);
      if (token) headers.set(HEADER, token);
      if (clientId) headers.set(CLIENT_HEADER, clientId);
      headers.set(VERSION_HEADER, VERSION);

      // Chromium permits cloning a navigation request with modified headers.
      // A stricter engine can reject that constructor; fall back to a
      // URL-based same-origin request rather than failing the navigation.
      let forwarded;
      try {
        forwarded = new Request(event.request, { headers });
      } catch {
        forwarded = new Request(event.request.url, {
          method: "GET",
          headers,
          credentials: "same-origin",
          redirect: "follow",
          cache: "no-store",
        });
      }
      return fetch(forwarded);
    })()
  );
});
