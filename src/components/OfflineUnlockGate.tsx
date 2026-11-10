"use client";

import { useEffect, useState } from "react";
import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import {
  getCurrentOfflineContext,
  getOfflineUnlockRecord,
  offlineContextExpired,
  savePreparedContext,
  type OfflinePreparedContext,
} from "@/lib/offline/device-store";
import {
  MIN_PASSPHRASE_LENGTH,
  OfflineCryptoError,
} from "@/lib/offline/crypto";
import {
  isOfflineUnlocked,
  recoverOfflineWorkspace,
  setupOfflineUnlock,
  unlockOfflineWorkspace,
} from "@/lib/offline/unlock";
import { migrateOfflineRecordsToProtected } from "@/lib/offline/store";

interface Props {
  onUnlocked: () => void;
  /** When true, allow first-time passphrase setup; normally requires online. */
  allowSetup?: boolean;
  /** Server-resolved identity, used before a prepared context exists. */
  fallbackContext?: {
    tenantId: string;
    userId: string;
    userName: string;
  };
}

/**
 * Lock screen for protected offline data.
 *
 * Nothing sensitive is rendered until the user-specific passphrase decrypts the
 * verifier and unlocks the scoped database. Wrong attempts never delete data.
 */
export default function OfflineUnlockGate({
  onUnlocked,
  allowSetup = true,
  fallbackContext,
}: Props) {
  const [context, setContext] = useState<OfflinePreparedContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
  const [coolingDown, setCoolingDown] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [savedRecovery, setSavedRecovery] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getCurrentOfflineContext().then((value) => {
      if (cancelled) return;
      if (value) {
        if (
          fallbackContext &&
          (value.tenantId !== fallbackContext.tenantId ||
            value.userId !== fallbackContext.userId)
        ) {
          const at = new Date().toISOString();
          setContext({
            tenantId: fallbackContext.tenantId,
            userId: fallbackContext.userId,
            userName: fallbackContext.userName,
            role: "collector",
            modules: [],
            moduleStates: {},
            preparedAt: at,
            authorizedAt: at,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            lastSyncedAt: null,
            active: false,
            activeModule: null,
          });
        } else {
          setContext(value);
        }
      } else if (fallbackContext) {
        const at = new Date().toISOString();
        setContext({
          tenantId: fallbackContext.tenantId,
          userId: fallbackContext.userId,
          userName: fallbackContext.userName,
          role: "collector",
          modules: [],
          moduleStates: {},
          preparedAt: at,
          authorizedAt: at,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          lastSyncedAt: null,
          active: false,
          activeModule: null,
        });
      } else {
        setContext(null);
      }
      setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
      setLoading(false);
    });
    const onConnectivity = () => setOnline(navigator.onLine);
    window.addEventListener("online", onConnectivity);
    window.addEventListener("offline", onConnectivity);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onConnectivity);
      window.removeEventListener("offline", onConnectivity);
    };
  }, []);

  useEffect(() => {
    if (!context?.unlockBlockedUntil) {
      setCoolingDown(false);
      return;
    }
    const update = () =>
      setCoolingDown(
        new Date(context.unlockBlockedUntil as string).getTime() > Date.now()
      );
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [context?.unlockBlockedUntil]);

  const fallbackMismatch = (value: OfflinePreparedContext | null) =>
    Boolean(
      value &&
        fallbackContext &&
        (value.tenantId !== fallbackContext.tenantId ||
          value.userId !== fallbackContext.userId)
    );

  async function unlockOrSetup() {
    if (!context) return;
    setBusy(true);
    setError("");
    try {
      let fresh = (await getCurrentOfflineContext()) ?? context;
      if (fallbackMismatch(fresh) && fallbackContext) {
        const at = new Date().toISOString();
        fresh = {
          tenantId: fallbackContext.tenantId,
          userId: fallbackContext.userId,
          userName: fallbackContext.userName,
          role: "collector",
          modules: [],
          moduleStates: {},
          preparedAt: at,
          authorizedAt: at,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          lastSyncedAt: null,
          active: false,
          activeModule: null,
        };
        await savePreparedContext(fresh);
      }
      setContext(fresh);
      if (!fresh.unlock) {
        if (!allowSetup || !navigator.onLine) {
          setError("Reconnect to the internet to set up the offline passphrase.");
          return;
        }
        if (passphrase !== confirm) {
          setError("The passphrase confirmation does not match.");
          return;
        }
        const code = await setupOfflineUnlock(fresh, passphrase);
        if (!(await getCurrentOfflineContext())) {
          const at = new Date().toISOString();
          await savePreparedContext({
            tenantId: fresh.tenantId,
            userId: fresh.userId,
            userName: fresh.userName,
            role: fresh.role,
            modules: [],
            moduleStates: {},
            unlock:
              (await getOfflineUnlockRecord(fresh.tenantId, fresh.userId)) ??
              undefined,
            preparedAt: at,
            authorizedAt: at,
            expiresAt: new Date(
              new Date(at).getTime() + 24 * 60 * 60 * 1000
            ).toISOString(),
            lastSyncedAt: null,
            active: false,
            activeModule: null,
          });
        }
        // Protect any records created before this device had an unlock key.
        await migrateOfflineRecordsToProtected();
        setPassphrase("");
        setConfirm("");
        setRecoveryCode(code);
        return;
      } else {
        if (useRecovery) {
          await recoverOfflineWorkspace(fresh, passphrase);
        } else {
          await unlockOfflineWorkspace(fresh, passphrase);
        }
      }
      setPassphrase("");
      setConfirm("");
      onUnlocked();
    } catch (err) {
      setError(
        err instanceof OfflineCryptoError || err instanceof Error
          ? err.message
          : "The offline workspace could not be unlocked."
      );
      // Refresh the persisted failure counter/cooldown so the UI and the next
      // attempt use the real values, not the snapshot from page load.
      const refreshed = await getCurrentOfflineContext().catch(() => null);
      if (refreshed) setContext(refreshed);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="card space-y-3" aria-busy="true">
        <div className="h-5 w-48 rounded bg-slate-100" />
        <div className="h-11 w-full rounded-control bg-slate-100" />
      </div>
    );
  }

  if (!context) {
    return (
      <div className="card">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <LockKeyhole size={16} aria-hidden /> Offline workspace locked
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          This device has no prepared offline workspace. Reconnect and sign in to
          prepare it. Saved records are not affected.
        </p>
      </div>
    );
  }

  const expired = offlineContextExpired(context);
  const settingUp = !context.unlock;
  const alreadyUnlocked = isOfflineUnlocked(context);

  if (alreadyUnlocked && !recoveryCode) {
    return (
      <div className="card">
        <p className="text-sm text-slate-600">The offline workspace is unlocked.</p>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="card border-red-200">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-red-900">
          <LockKeyhole size={16} aria-hidden /> Offline authorization expired
        </h2>
        <p className="mt-2 text-sm text-red-800">
          Reconnect and sign in again to renew this device. Saved records remain on
          this device and are not deleted.
        </p>
      </div>
    );
  }

  if (recoveryCode) {
    return (
      <section className="card mx-auto max-w-md" aria-labelledby="offline-recovery-title">
        <h2
          id="offline-recovery-title"
          className="flex items-center gap-2 text-base font-semibold text-slate-900"
        >
          <KeyRound size={18} aria-hidden /> Save your recovery code
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          If you forget the offline passphrase, this one-time code is the only way
          to reopen saved offline records. Store it separately from this device.
        </p>
        <p className="mt-3 break-all rounded-control bg-slate-100 px-3 py-3 font-mono text-sm text-slate-900">
          {recoveryCode}
        </p>
        <button
          type="button"
          className="btn btn-secondary btn-sm mt-2"
          onClick={() => void navigator.clipboard?.writeText(recoveryCode)}
        >
          Copy code
        </button>
        <label className="mt-4 flex items-start gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            className="mt-1"
            checked={savedRecovery}
            onChange={(event) => setSavedRecovery(event.target.checked)}
          />
          <span>I have saved this recovery code somewhere safe.</span>
        </label>
        <button
          type="button"
          className="btn btn-primary mt-4 w-full"
          disabled={!savedRecovery}
          onClick={() => {
            setRecoveryCode("");
            setSavedRecovery(false);
            onUnlocked();
          }}
        >
          Continue
        </button>
      </section>
    );
  }

  return (
    <section className="card mx-auto max-w-md" aria-labelledby="offline-unlock-title">
      <h2
        id="offline-unlock-title"
        className="flex items-center gap-2 text-base font-semibold text-slate-900"
      >
        <ShieldCheck size={18} aria-hidden />
        {settingUp ? "Set up offline protection" : "Offline workspace locked"}
      </h2>
      <p className="mt-2 text-sm text-slate-600">
        {settingUp
          ? "Choose an offline passphrase. It protects saved customers and queued collections when this browser restarts or locks. It is never stored."
          : `Enter the offline passphrase for ${context.userName} to open saved customer and queue data.`}
      </p>
      {coolingDown && (
          <p className="mt-2 rounded-control bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Too many wrong attempts. Wait before trying again.
          </p>
        )}

      <label className="mt-4 block text-sm font-medium text-slate-800" htmlFor="offline-passphrase">
        {useRecovery ? "Recovery code" : "Offline passphrase"}
      </label>
      <input
        id="offline-passphrase"
        type={useRecovery ? "text" : "password"}
        autoComplete={settingUp ? "new-password" : useRecovery ? "off" : "current-password"}
        className="mt-1 w-full rounded-control border border-slate-300 px-3 py-2.5 text-sm"
        value={passphrase}
        onChange={(event) => setPassphrase(event.target.value)}
        minLength={settingUp ? MIN_PASSPHRASE_LENGTH : undefined}
        disabled={busy}
      />
      {!settingUp && (
        <button
          type="button"
          className="mt-2 text-xs font-medium text-brand-700 underline"
          onClick={() => {
            setUseRecovery((value) => !value);
            setPassphrase("");
            setError("");
          }}
        >
          {useRecovery ? "Use offline passphrase instead" : "Use recovery code"}
        </button>
      )}
      {settingUp && (
        <>
          <p className="mt-1 text-xs text-slate-500">
            At least {MIN_PASSPHRASE_LENGTH} characters. There is no automatic
            reset. If you forget it, saved records remain on this device but
            cannot be opened or synchronized without it. Contact your
            administrator; do not clear site data.
          </p>
          <label className="mt-3 block text-sm font-medium text-slate-800" htmlFor="offline-passphrase-confirm">
            Confirm passphrase
          </label>
          <input
            id="offline-passphrase-confirm"
            type="password"
            autoComplete="new-password"
            className="mt-1 w-full rounded-control border border-slate-300 px-3 py-2.5 text-sm"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            disabled={busy}
          />
        </>
      )}

      {error && (
        <p className="mt-3 text-sm text-red-800" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => void unlockOrSetup()}
        disabled={
          busy ||
          !passphrase ||
          (settingUp && (!allowSetup || !online || passphrase !== confirm))
        }
        className="btn btn-primary mt-4 w-full"
        aria-busy={busy}
      >
        <KeyRound size={16} aria-hidden />
        {busy
          ? settingUp
            ? "Protecting…"
            : "Unlocking…"
          : settingUp
            ? "Set up offline protection"
            : useRecovery
              ? "Unlock with recovery code"
              : "Unlock offline workspace"}
      </button>
      {settingUp && !online && (
        <p className="mt-2 text-xs text-amber-800" role="status">
          Connect to the internet once to establish the offline passphrase.
        </p>
      )}
    </section>
  );
}
