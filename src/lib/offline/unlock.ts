/**
 * Offline workspace lock state.
 *
 * The AES key exists only in this module's memory. Page load starts locked;
 * unlocking requires the user-specific passphrase. Locking clears the key.
 * No passphrase, key or verifier is written to browser storage.
 */

import {
  OfflineCryptoError,
  createUnlockRecord,
  unlockWithRecoveryCode,
  unlockWithRecord,
} from "./crypto";
import {
  clearOfflineUnlockFailures,
  getOfflineUnlockRecord,
  recordOfflineUnlockFailure,
  setOfflineUnlockRecord,
  type OfflinePreparedContext,
} from "./device-store";

export const OFFLINE_IDLE_LOCK_MS = 15 * 60 * 1000;
export const OFFLINE_BACKGROUND_LOCK_MS = 5 * 60 * 1000;

export type OfflineUnlockState = "unconfigured" | "locked" | "unlocked";

let activeKey: CryptoKey | null = null;
let activeScopeId: string | null = null;
let lastActivityAt = 0;
let backgroundedAt: number | null = null;

export class OfflineLockedError extends Error {
  constructor(message = "Offline records are locked. Enter the offline passphrase.") {
    super(message);
    this.name = "OfflineLockedError";
  }
}

export function offlineScopeId(context: Pick<OfflinePreparedContext, "tenantId" | "userId">): string {
  return `${context.tenantId}:${context.userId}`;
}

export function getOfflineUnlockState(
  context: OfflinePreparedContext | null | undefined
): OfflineUnlockState {
  if (!context?.unlock) return "unconfigured";
  if (activeKey && activeScopeId === offlineScopeId(context)) return "unlocked";
  return "locked";
}

export function isOfflineUnlocked(
  context?: Pick<OfflinePreparedContext, "tenantId" | "userId"> | null
): boolean {
  if (!activeKey) return false;
  if (!context) return true;
  return activeScopeId === offlineScopeId(context);
}

export function requireOfflineKey(
  context?: Pick<OfflinePreparedContext, "tenantId" | "userId"> | null
): CryptoKey {
  if (!activeKey) throw new OfflineLockedError();
  if (context && activeScopeId !== offlineScopeId(context)) {
    throw new OfflineLockedError(
      "This offline workspace belongs to a different account. Unlock it with its own passphrase."
    );
  }
  return activeKey;
}

export function lockOfflineWorkspace(): void {
  activeKey = null;
  activeScopeId = null;
  lastActivityAt = 0;
  backgroundedAt = null;
}

export function markOfflineActivity(now = Date.now()): void {
  if (activeKey) lastActivityAt = now;
}

export function markOfflineBackground(now = Date.now()): void {
  if (activeKey) backgroundedAt = now;
}

export function markOfflineForeground(now = Date.now()): boolean {
  if (!activeKey) return false;
  if (backgroundedAt != null && now - backgroundedAt >= OFFLINE_BACKGROUND_LOCK_MS) {
    lockOfflineWorkspace();
    return true;
  }
  backgroundedAt = null;
  if (lastActivityAt && now - lastActivityAt >= OFFLINE_IDLE_LOCK_MS) {
    lockOfflineWorkspace();
    return true;
  }
  return false;
}

export function checkOfflineIdleLock(now = Date.now()): boolean {
  if (!activeKey) return false;
  if (lastActivityAt && now - lastActivityAt >= OFFLINE_IDLE_LOCK_MS) {
    lockOfflineWorkspace();
    return true;
  }
  return false;
}

function cooldownForFailures(failures: number): string | null {
  if (failures >= 7) return new Date(Date.now() + 30 * 60 * 1000).toISOString();
  if (failures >= 5) return new Date(Date.now() + 5 * 60 * 1000).toISOString();
  if (failures >= 3) return new Date(Date.now() + 30 * 1000).toISOString();
  return null;
}

function assertNotCoolingDown(context: OfflinePreparedContext): void {
  const until = context.unlockBlockedUntil
    ? new Date(context.unlockBlockedUntil).getTime()
    : 0;
  if (until > Date.now()) {
    const seconds = Math.ceil((until - Date.now()) / 1000);
    throw new OfflineCryptoError(
      "invalid_passphrase",
      `Too many attempts. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`
    );
  }
}

export async function setupOfflineUnlock(
  context: Pick<OfflinePreparedContext, "tenantId" | "userId">,
  passphrase: string
): Promise<string> {
  const existing = await getOfflineUnlockRecord(context.tenantId, context.userId);
  if (existing) {
    throw new OfflineCryptoError(
      "unsupported",
      "This device already has an offline passphrase. Unlock it instead of replacing it."
    );
  }
  const created = await createUnlockRecord(passphrase);
  const saved = await setOfflineUnlockRecord(
    context.tenantId,
    context.userId,
    created.record
  );
  if (!saved) {
    throw new OfflineCryptoError(
      "unsupported",
      "This device could not store its offline unlock record."
    );
  }
  // Verify the persisted record before the caller marks the device ready.
  const key = await unlockWithRecord(passphrase, created.record);
  activeKey = key;
  activeScopeId = offlineScopeId(context);
  lastActivityAt = Date.now();
  backgroundedAt = null;
  return created.recoveryCode;
}

export async function unlockOfflineWorkspace(
  context: OfflinePreparedContext,
  passphrase: string
): Promise<void> {
  if (!context.unlock) {
    throw new OfflineCryptoError(
      "unsupported",
      "This device has no offline unlock credential. Reconnect and set one up."
    );
  }
  assertNotCoolingDown(context);
  try {
    const key = await unlockWithRecord(passphrase, context.unlock);
    activeKey = key;
    activeScopeId = offlineScopeId(context);
    lastActivityAt = Date.now();
    backgroundedAt = null;
    await clearOfflineUnlockFailures(context.tenantId, context.userId);
  } catch (error) {
    if (error instanceof OfflineCryptoError && error.code === "invalid_passphrase") {
      const failures = (context.unlockFailures ?? 0) + 1;
      await recordOfflineUnlockFailure(
        context.tenantId,
        context.userId,
        cooldownForFailures(failures)
      );
    }
    throw error;
  }
}

/** Unlock with the one-time recovery code issued at setup. */
export async function recoverOfflineWorkspace(
  context: OfflinePreparedContext,
  recoveryCode: string
): Promise<void> {
  if (!context.unlock) {
    throw new OfflineCryptoError(
      "unsupported",
      "This device has no offline unlock credential."
    );
  }
  assertNotCoolingDown(context);
  try {
    const key = await unlockWithRecoveryCode(recoveryCode, context.unlock);
    activeKey = key;
    activeScopeId = offlineScopeId(context);
    lastActivityAt = Date.now();
    backgroundedAt = null;
    await clearOfflineUnlockFailures(context.tenantId, context.userId);
  } catch (error) {
    if (error instanceof OfflineCryptoError && error.code === "invalid_passphrase") {
      const failures = (context.unlockFailures ?? 0) + 1;
      await recordOfflineUnlockFailure(
        context.tenantId,
        context.userId,
        cooldownForFailures(failures)
      );
    }
    throw error;
  }
}
