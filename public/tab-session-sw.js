/*
 * BloomCore One — per-tab proof-of-possession transport.
 *
 * Ordinary cookies are shared by every tab. This worker gives each tab its own
 * authentication credential without ever persisting a bearer session token.
 *
 * After login the page posts the one-time login token to this worker. The
 * worker generates a non-extractable ECDSA P-256 key pair, exchanges the public
 * JWK for a server-side TabCredential bound to the login's SessionRecord, and
 * discards the login token. Every later same-origin request carries a short
 * proof signed by the private key plus a 120-second route-gating assertion.
 *
 * IndexedDB stores only:
 *   - the non-extractable CryptoKey,
 *   - credentialId / sessionId / module,
 *   - the non-secret assertion and its expiry.
 * It never stores a JWT, bearer token, signing secret or raw key bytes.
 *
 * An XSS on this origin can still use the key through the WebCrypto API while
 * the key handle exists. It cannot export the private key to another origin.
 * CSP, server-side revocation and short proof lifetimes remain essential.
 */

const PROOF_HEADER = "x-bloomcore-tab-proof";
const ASSERTION_HEADER = "x-bloomcore-tab-assertion";
const CLIENT_HEADER = "x-bloomcore-tab-client";
const PATH_HEADER = "x-bloomcore-tab-path";
const REQUEST_ID_HEADER = "x-bloomcore-tab-request-id";
const VERSION = "2";
const DB_NAME = "bloomcore-tab-sessions";
const DB_VERSION = 2;
const STORE = "credentials";
const MAX_MAPPING_AGE_MS = 8 * 60 * 60 * 1000;
const ASSERTION_REFRESH_MARGIN_SECONDS = 25;

const memory = new Map();

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Remove the pre-hardening bearer-token store entirely.
      if (db.objectStoreNames.contains("sessions")) db.deleteObjectStore("sessions");
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readPersisted(clientId) {
  if (!clientId) return null;
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(clientId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

async function persist(clientId, mapping) {
  if (!clientId || !mapping) return;
  const db = await openDatabase();
  // Assertions are 120-second route-gating values, not data credentials.
  // Keep them in memory only; IndexedDB stores just the non-extractable key
  // and the non-secret credential/session identifiers.
  const persisted = {
    privateKey: mapping.privateKey,
    credentialId: mapping.credentialId,
    sessionId: mapping.sessionId,
    module: mapping.module,
    savedAt: mapping.savedAt,
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(persisted, clientId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
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

async function mappingFor(clientId, resultingClientId) {
  for (const id of [clientId, resultingClientId]) {
    if (!id) continue;
    if (memory.has(id)) return memory.get(id);
  }
  for (const id of [clientId, resultingClientId]) {
    if (!id) continue;
    const stored = await readPersisted(id);
    if (stored) {
      memory.set(id, stored);
      return stored;
    }
  }
  return null;
}

async function signedProof(mapping, method, path) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const canonical = [
    "v1",
    mapping.credentialId,
    mapping.sessionId,
    String(ts),
    nonce,
    method.toUpperCase(),
    path,
  ].join("\n");
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    mapping.privateKey,
    new TextEncoder().encode(canonical)
  );
  const proof = {
    v: 1,
    credentialId: mapping.credentialId,
    sessionId: mapping.sessionId,
    ts,
    nonce,
    method: method.toUpperCase(),
    path,
  };
  return `${toBase64Url(new TextEncoder().encode(JSON.stringify(proof)))}.${toBase64Url(
    new Uint8Array(signature)
  )}`;
}

async function refreshAssertion(mapping) {
  try {
    const proof = await signedProof(mapping, "POST", "/api/auth/tab/assertion");
    const response = await fetch("/api/auth/tab/assertion", {
      method: "POST",
      headers: {
        [PROOF_HEADER]: proof,
        [CLIENT_HEADER]: mapping.credentialId,
        [REQUEST_ID_HEADER]: crypto.randomUUID(),
      },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (typeof data.assertion !== "string") return null;
    mapping.assertion = data.assertion;
    mapping.assertionExp = Math.floor(Date.now() / 1000) + 90;
    return data.assertion;
  } catch {
    return null;
  }
}

async function ensureAssertion(mapping) {
  const now = Math.floor(Date.now() / 1000);
  if (
    mapping.assertion &&
    Number(mapping.assertionExp || 0) > now + ASSERTION_REFRESH_MARGIN_SECONDS
  ) {
    return mapping.assertion;
  }
  return refreshAssertion(mapping);
}

async function bootstrap(sourceId, token) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const response = await fetch("/api/auth/tab/enroll", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ publicKeyJwk: JSON.stringify(publicJwk) }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("enrollment_failed");
  const data = await response.json();
  if (
    typeof data.credentialId !== "string" ||
    typeof data.sessionId !== "string" ||
    typeof data.module !== "string" ||
    typeof data.assertion !== "string"
  ) {
    throw new Error("enrollment_invalid");
  }
  const mapping = {
    privateKey: pair.privateKey,
    credentialId: data.credentialId,
    sessionId: data.sessionId,
    module: data.module,
    assertion: data.assertion,
    assertionExp: Math.floor(Date.now() / 1000) + 90,
    savedAt: Date.now(),
  };
  // A storage failure is a bootstrap failure: never fall back to memory-only
  // authentication that silently loses isolation on refresh.
  await persist(sourceId, mapping);
  memory.set(sourceId, mapping);
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
  if (data.type === "bootstrap" && typeof data.token === "string") {
    event.waitUntil(
      (async () => {
        try {
          await bootstrap(sourceId, data.token);
          event.source.postMessage({ type: "bootstrapped" });
        } catch {
          if (event.source && "postMessage" in event.source) {
            event.source.postMessage({
              type: "bootstrap-failed",
              reason: "session_isolation_unavailable",
            });
          }
        }
      })()
    );
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
    const mapping = memory.get(sourceId);
    if (event.source && "postMessage" in event.source) {
      event.source.postMessage({
        type: "status",
        authenticated: Boolean(mapping && mapping.privateKey),
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
      const mapping = await mappingFor(clientId, resultingClientId);
      const headers = new Headers(event.request.headers);
      headers.delete(PROOF_HEADER);
      headers.delete(ASSERTION_HEADER);
      headers.delete(CLIENT_HEADER);
      headers.delete(PATH_HEADER);
      headers.delete(REQUEST_ID_HEADER);

      if (mapping) {
        if (resultingClientId) {
          memory.set(resultingClientId, mapping);
          // Persist before the new document starts loading so a worker restart
          // or immediate refresh can recover this tab's key.
          await persist(resultingClientId, mapping);
        }
        if (clientId) memory.set(clientId, mapping);
        try {
          const path = `${url.pathname}${url.search}`;
          headers.set(PROOF_HEADER, await signedProof(mapping, event.request.method, path));
          headers.set(PATH_HEADER, path);
          headers.set(REQUEST_ID_HEADER, crypto.randomUUID());
          const assertion = await ensureAssertion(mapping);
          if (assertion) headers.set(ASSERTION_HEADER, assertion);
        } catch {
          // Fail closed: forward without proof/assertion. Server rejects.
        }
        headers.set(CLIENT_HEADER, clientId || mapping.credentialId);
      }
      headers.set("x-bloomcore-tab-version", VERSION);

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
