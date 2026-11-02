/**
 * Device enrollment — generates a stable device identifier
 * and manages local device state.
 *
 * The device ID is stored in IndexedDB and persists across
 * page reloads. It is NOT stored in localStorage (per the
 * approved offline architecture).
 */

import {
  getOfflineScope,
  offlineDatabaseName,
  purgeLegacyOfflineDatabase,
  registerOfflineConnection,
} from "./scope";

const DEVICE_ID_KEY = "bik-device-id";

/**
 * Generate a UUID v4. Uses crypto.randomUUID when available, otherwise
 * falls back to a Math.random based generator (covers older WebViews /
 * entry-level Android devices that lack crypto.randomUUID).
 */
function generateUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      /* fall through to manual generator */
    }
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Get or create the device identifier.
 * This is a UUID v4 stored in IndexedDB, stable across
 * page reloads but not shared between tabs.
 *
 * Resilient by design: if IndexedDB is unavailable (e.g. private browsing
 * mode) it degrades to sessionStorage for the session, and finally to an
 * in-memory id, so enrollment never hard-fails on a device.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  try {
    const db = await openIDB();
    return await new Promise<string>((resolve, reject) => {
      const tx = db.transaction("meta", "readonly");
      const store = tx.objectStore("meta");
      const request = store.get(DEVICE_ID_KEY);
      request.onsuccess = () => {
        if (request.result) {
          resolve(request.result.value);
        } else {
          const newId = generateUuid();
          const writeTx = db.transaction("meta", "readwrite");
          writeTx.objectStore("meta").put({ key: DEVICE_ID_KEY, value: newId });
          writeTx.oncomplete = () => resolve(newId);
          writeTx.onerror = () => reject(writeTx.error);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    // IndexedDB unavailable — fall back to sessionStorage so offline
    // enrollment can still proceed for this session.
    try {
      const existing = sessionStorage.getItem(DEVICE_ID_KEY);
      if (existing) return existing;
      const newId = generateUuid();
      sessionStorage.setItem(DEVICE_ID_KEY, newId);
      return newId;
    } catch {
      // Last-resort in-memory id (resets on reload, still usable now).
      return generateUuid();
    }
  }
}

/**
 * Get the current device ID without creating one.
 * Returns null if no device has been enrolled.
 */
export async function getDeviceId(): Promise<string | null> {
  try {
    const db = await openIDB();
    return await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction("meta", "readonly");
      const store = tx.objectStore("meta");
      const request = store.get(DEVICE_ID_KEY);
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    try {
      return sessionStorage.getItem(DEVICE_ID_KEY);
    } catch {
      return null;
    }
  }
}

async function openIDB(): Promise<IDBDatabase> {
  await purgeLegacyOfflineDatabase();
  const scope = await getOfflineScope();
  const request = indexedDB.open(offlineDatabaseName(scope), 1);
  return new Promise((resolve, reject) => {
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      registerOfflineConnection(request.result);
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}
