/*
 * MaaCash — per-tab proof-of-possession transport.
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

// Offline application shell cache. It is namespaced by a non-secret local scope
// (tenant:user) so one account's cached page is never served to another.
const APP_CACHE_PREFIX = "maacash-app-v3:";
const STATIC_CACHE = "maacash-static-v3";
const SCOPE_META_URL = new URL("/__maacash/offline-scope", self.location.origin).href;

let activeOfflineScope = null;
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

function safeScope(scope) {
  return String(scope || "").replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 180);
}

function appCacheName(scope) {
  return `${APP_CACHE_PREFIX}${safeScope(scope)}`;
}

async function setActiveOfflineScope(scope) {
  const value = typeof scope === "string" ? scope : "";
  activeOfflineScope = value || null;
  try {
    const cache = await caches.open(STATIC_CACHE);
    await cache.put(
      new Request(SCOPE_META_URL),
      new Response(JSON.stringify({ scope: activeOfflineScope }), {
        headers: { "Content-Type": "application/json" },
      })
    );
  } catch {
    // Memory still works for this worker lifetime.
  }
}

async function getActiveOfflineScope() {
  if (activeOfflineScope) return activeOfflineScope;
  try {
    const cache = await caches.open(STATIC_CACHE);
    const response = await cache.match(new Request(SCOPE_META_URL));
    if (!response) return null;
    const data = await response.json();
    activeOfflineScope = typeof data.scope === "string" ? data.scope : null;
  } catch {
    activeOfflineScope = null;
  }
  return activeOfflineScope;
}

function pageKey(url) {
  return new Request(new URL(url.pathname, url.origin));
}

async function cachePage(scope, url, response) {
  if (!scope || !response || !response.ok || response.redirected) return;
  try {
    const cache = await caches.open(appCacheName(scope));
    await cache.put(pageKey(url), response);
  } catch {
    // best effort
  }
}

async function cachedPage(scope, url) {
  if (!scope) return null;
  try {
    const cache = await caches.open(appCacheName(scope));
    return (await cache.match(pageKey(url))) || null;
  } catch {
    return null;
  }
}

async function cacheAsset(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl, self.location.origin);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  try {
    const cache = await caches.open(STATIC_CACHE);
    if (await cache.match(url.href)) return;
    const response = await fetch(new Request(url.href, { credentials: "same-origin" }));
    if (response.ok) await cache.put(url.href, response);
  } catch {
    // best effort
  }
}

/**
 * Cache every Next.js asset referenced by a warmed page. Without this the page
 * HTML could be available offline while its JavaScript chunks were not.
 */
async function warmAssetsFromHtml(response) {
  try {
    const html = await response.text();
    const urls = new Set();
    const pattern = /(?:src|href)="(\/_next\/static\/[^"?#]+[^"]*)"/g;
    let match;
    while ((match = pattern.exec(html)) !== null) urls.add(match[1]);
    await Promise.all(Array.from(urls).map((url) => cacheAsset(url)));
  } catch {
    // best effort
  }
}

async function clearAppCaches() {
  try {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(APP_CACHE_PREFIX))
        .map((name) => caches.delete(name))
    );
    const staticCache = await caches.open(STATIC_CACHE);
    await staticCache.delete(new Request(SCOPE_META_URL));
  } finally {
    activeOfflineScope = null;
  }
}

function offlineFallbackResponse() {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline setup required</title></head><body style="font-family:system-ui,sans-serif;padding:2rem;line-height:1.5;color:#0f172a"><h1 style="font-size:1.25rem">This device is not ready for offline work</h1><p>MaaCash needs an initial online sign-in and device preparation before it can open without internet.</p><p>Connect to the internet, sign in, and let the device prepare. Saved records already on this device are not deleted.</p></body></html>`,
    {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    }
  );
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await pruneMappings();
      try {
        const names = await caches.keys();
        await Promise.all(
          names
            .filter(
              (name) =>
                (name.startsWith("maacash-app-v2:") ||
                  name === "maacash-static-v2")
            )
            .map((name) => caches.delete(name))
        );
      } catch {
        // Cache cleanup is best effort.
      }
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

  if (data.type === "offline-scope") {
    event.waitUntil(
      setActiveOfflineScope(typeof data.scope === "string" ? data.scope : "")
    );
    return;
  }

  if (data.type === "clear-app-cache") {
    event.waitUntil(
      (async () => {
        await clearAppCaches();
        if (event.source && "postMessage" in event.source) {
          event.source.postMessage({ type: "offline-cache-cleared" });
        }
      })()
    );
    return;
  }

  if (data.type === "status") {
    const mapping = memory.get(sourceId);
    if (event.source && "postMessage" in event.source) {
      event.source.postMessage({
        type: "status",
        authenticated: Boolean(mapping && mapping.privateKey),
        offlineScope: activeOfflineScope,
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

      if (event.request.method !== "GET") return fetch(forwarded);

      // A page fetch issued by prepareOfflineAccess() is not `mode: navigate`.
      // Treat the explicit warm request as a page so its response is cached
      // under the same key a later offline navigation will read.
      const warm = event.request.headers.get("x-maacash-offline-warm") === "1";
      const isNavigation = event.request.mode === "navigate" || warm;
      const isStatic =
        url.pathname.startsWith("/_next/static/") ||
        url.pathname === "/manifest.json" ||
        /\.(?:css|js|mjs|woff2?|ttf|png|jpe?g|svg|webp|ico)$/i.test(url.pathname);

      // App code and branding are shared by every account and contain no user
      // data. Cache-first avoids re-downloading the shell on a weak connection.
      if (isStatic && !isNavigation) {
        try {
          const cached = await caches.match(event.request);
          if (cached) return cached;
          const response = await fetch(forwarded);
          if (response.ok) {
            const cache = await caches.open(STATIC_CACHE);
            await cache.put(event.request, response.clone());
          }
          return response;
        } catch {
          const cached = await caches.match(event.request);
          if (cached) return cached;
          throw new Error("offline_static_asset_unavailable");
        }
      }

      if (isNavigation) {
        const requestedScope =
          event.request.headers.get("x-maacash-offline-scope") ||
          (await getActiveOfflineScope());
        try {
          const response = await fetch(forwarded);
          if (response.ok && !response.redirected && requestedScope) {
            await cachePage(requestedScope, url, response.clone());
            if (warm) await warmAssetsFromHtml(response.clone());
          }
          return response;
        } catch {
          const cached = await cachedPage(requestedScope, url);
          if (cached) return cached;
          const login = await cachedPage(
            requestedScope,
            new URL("/login", self.location.origin)
          );
          if (login) return login;
          return offlineFallbackResponse();
        }
      }

      return fetch(forwarded);
    })()
  );
});
