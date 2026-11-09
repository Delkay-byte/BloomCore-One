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
