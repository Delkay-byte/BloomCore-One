"use client";

/**
 * Browser side of the per-tab session transport.
 *
 * The authenticated handle is handed to the service worker, which binds it to
 * this tab's client id. Page JavaScript never persists the session handle in
 * localStorage, sessionStorage, IndexedDB or a URL. The only page-visible
 * credential is the short-lived MFA challenge, which is tab-scoped in
 * sessionStorage.
 */

const WORKER_URL = "/tab-session-sw.js";
const MFA_KEY = "bik-mfa-challenge";

// A new service worker cannot change JavaScript that is already running. When
// an updated worker takes over an already-controlled page, reload once so the
// document uses the new chunks and the Server Action ids that belong to them.
if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

export function tabSessionsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof indexedDB !== "undefined" &&
    typeof crypto !== "undefined" &&
    typeof crypto.subtle !== "undefined"
  );
}

async function waitForController(timeoutMs = 4000): Promise<boolean> {
  if (navigator.serviceWorker.controller) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
      resolve(value);
    };
    const onChange = () => finish(true);
    const timer = setTimeout(
      () => finish(Boolean(navigator.serviceWorker.controller)),
      timeoutMs
    );
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
  });
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

export async function ensureTabSessionWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!tabSessionsSupported()) return null;
  try {
    const registration = await timeout(
      navigator.serviceWorker.register(WORKER_URL, { scope: "/" }),
      5000
    );
    if (!registration) return null;
    const ready = await timeout(navigator.serviceWorker.ready, 5000);
    if (!ready) return null;
    await waitForController(4000);
    return registration;
  } catch {
    return null;
  }
}

/**
 * Exchange the one-time login token for a non-extractable tab credential.
 *
 * Resolves true only when the worker acknowledged a persisted bootstrap. The
 * token is never written to browser storage; the worker discards it after the
 * enrollment exchange. Timeout or failure is a hard failure, never a silent
 * cookie fallback.
 */
export async function registerTabSession(token: string): Promise<boolean> {
  if (!token || !tabSessionsSupported()) return false;
  const registration = await ensureTabSessionWorker();
  if (!registration) return false;
  const controller = navigator.serviceWorker.controller;
  if (!controller) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("message", onMessage);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 8000);
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "bootstrapped") finish(true);
      if (event.data?.type === "bootstrap-failed") finish(false);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    controller.postMessage({ type: "bootstrap", token });
  });
}

const PROOF_HEADER = "x-bloomcore-tab-proof";
const ASSERTION_HEADER = "x-bloomcore-tab-assertion";
const CLIENT_HEADER = "x-bloomcore-tab-client";
const PATH_HEADER = "x-bloomcore-tab-path";
const REQUEST_ID_HEADER = "x-bloomcore-tab-request-id";

type ProofReply = {
  proof?: string;
  assertion?: string;
  client?: string;
  path?: string;
};

/**
 * Ask the controlling service worker for a single-use proof bound to one
 * method and path. The page never sees a private key or a session token.
 */
function requestTabProof(method: string, path: string): Promise<ProofReply | null> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (value: ProofReply | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 1500);
    channel.port1.onmessage = (event: MessageEvent<ProofReply & { type?: string }>) => {
      if (event.data?.type !== "tab-proof-response") return;
      finish(event.data?.proof ? event.data : null);
    };
    controller.postMessage(
      {
        type: "tab-proof-request",
        method,
        path,
        requestId: crypto.randomUUID(),
      },
      [channel.port2]
    );
  });
}

/**
 * Narrow shim for Next.js router RSC refreshes only.
 *
 * A Server Action that calls revalidatePath makes the client router issue a
 * `rsc: 1` GET. That fetch can leave before the service worker attaches the
 * tab proof, so fail-closed middleware redirects a legitimate user. The shim
 * attaches a worker-signed proof for that exact GET. All other fetches, and
 * every request that already carries a proof, are passed through untouched.
 * No identity, role or tenant value comes from page JavaScript.
 */
export function installRscProofShim(): () => void {
  if (typeof window === "undefined" || !navigator.serviceWorker?.controller) {
    return () => undefined;
  }
  const original = window.fetch;
  const shimmed = original as typeof window.fetch & { __maacashProofShim?: boolean };
  if (shimmed.__maacashProofShim) return () => undefined;

  const shim = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let request: Request;
    try {
      request = input instanceof Request ? input : new Request(input, init);
    } catch {
      return original(input as RequestInfo, init);
    }
    let url: URL;
    try {
      url = new URL(request.url, window.location.href);
    } catch {
      return original(input as RequestInfo, init);
    }
    const isRsc =
      request.headers.get("rsc") === "1" || url.searchParams.has("_rsc");
    if (
      url.origin !== window.location.origin ||
      !isRsc ||
      request.headers.has(PROOF_HEADER)
    ) {
      return original(input as RequestInfo, init);
    }

    const reply = await requestTabProof(
      request.method,
      `${url.pathname}${url.search}`
    );
    if (!reply?.proof) return original(input as RequestInfo, init);
    const headers = new Headers(request.headers);
    headers.set(PROOF_HEADER, reply.proof);
    if (reply.assertion) headers.set(ASSERTION_HEADER, reply.assertion);
    if (reply.client) headers.set(CLIENT_HEADER, reply.client);
    if (reply.path) headers.set(PATH_HEADER, reply.path);
    headers.set(REQUEST_ID_HEADER, crypto.randomUUID());
    return original(new Request(request, { headers }));
  }) as typeof window.fetch & { __maacashProofShim?: boolean };
  shim.__maacashProofShim = true;

  window.fetch = shim;
  return () => {
    if (window.fetch === shim) window.fetch = original;
  };
}

/** Remove only this tab's session handle. Other tabs keep theirs. */
export async function clearTabSession(): Promise<void> {
  clearMfaChallenge();
  if (!tabSessionsSupported()) return;
  const worker = navigator.serviceWorker.controller;
  if (!worker) return;
  worker.postMessage({ type: "clear" });
}

/**
 * Remove cached application pages at sign-out. Unsynchronized financial records
 * live in their own scoped IndexedDB database and are deliberately untouched.
 */
export async function clearOfflineAppCache(): Promise<void> {
  if (!tabSessionsSupported()) return;
  const worker = navigator.serviceWorker.controller;
  if (!worker) return;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1200);
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "offline-cache-cleared") return;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("message", onMessage);
      resolve();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    worker.postMessage({ type: "clear-app-cache" });
  });
}

export async function refreshTabSessionStatus(): Promise<boolean> {
  if (!tabSessionsSupported()) return false;
  const worker = navigator.serviceWorker.controller;
  if (!worker) return false;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
      resolve(false);
    }, 1000);
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "status") return;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("message", onMessage);
      resolve(Boolean(event.data.authenticated));
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    worker.postMessage({ type: "status" });
  });
}

/**
 * Register the new session and perform a full navigation.
 *
 * A full navigation (rather than a client transition) guarantees the worker's
 * header is present on the very first server render of the destination.
 * Returns false when this browser cannot establish an isolated tab session;
 * the caller must show a recovery message rather than claim success.
 */
export async function completeTabLogin(token: string, path: string): Promise<boolean> {
  const ready = await registerTabSession(token);
  if (!ready) return false;
  window.location.assign(path);
  return true;
}

// ---------------------------------------------------------------------------
// MFA challenge — tab-scoped, single-use, never a session
// ---------------------------------------------------------------------------

export function setMfaChallenge(token: string): void {
  try {
    sessionStorage.setItem(MFA_KEY, token);
  } catch {
    // The MFA page will fail closed if storage is unavailable.
  }
}

export function getMfaChallenge(): string {
  try {
    return sessionStorage.getItem(MFA_KEY) ?? "";
  } catch {
    return "";
  }
}

export function clearMfaChallenge(): void {
  try {
    sessionStorage.removeItem(MFA_KEY);
  } catch {
    // ignore
  }
}
