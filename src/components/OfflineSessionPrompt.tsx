"use client";

import { useEffect, useState } from "react";
import { CloudOff, LockKeyhole, ShieldCheck } from "lucide-react";
import {
  getCurrentOfflineContext,
  offlineContextExpired,
  offlineModuleBlockReason,
  type OfflineModule,
  type OfflinePreparedContext,
} from "@/lib/offline/device-store";
import {
  activateOfflineAccess,
  getOfflineReadiness,
  moduleDisplayName,
  moduleRoute,
} from "@/lib/offline/preparation";

/**
 * Restore a previously prepared offline session before the login form.
 *
 * This component never accepts credentials and never creates an identity. It
 * only offers modules for which the server previously approved this device.
 * A device that was never prepared is told to sign in online first.
 */
export default function OfflineSessionPrompt() {
  const [online, setOnline] = useState(true);
  const [context, setContext] = useState<OfflinePreparedContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyModule, setBusyModule] = useState<OfflineModule | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const current = await getCurrentOfflineContext();
      if (cancelled) return;
      setContext(current);
      setOnline(navigator.onLine);
      setLoading(false);
    };
    void load();
    const onChange = () => void load();
    window.addEventListener("online", onChange);
    window.addEventListener("offline", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onChange);
      window.removeEventListener("offline", onChange);
    };
  }, []);

  async function openOffline(module: OfflineModule) {
    setBusyModule(module);
    setError("");
    try {
      const readiness = await getOfflineReadiness(module);
      if (readiness.status !== "ready" && readiness.status !== "active") {
        setError(readiness.message);
        return;
      }
      const activation = await activateOfflineAccess(module);
      if (!activation.ok) {
        setError(activation.readiness.message);
        return;
      }
      window.location.assign(moduleRoute(module));
    } catch {
      setError("The offline workspace could not be restored on this device.");
    } finally {
      setBusyModule(null);
    }
  }

  if (loading || online) return null;

  if (!context) {
    return (
      <div className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 p-4" role="status">
        <p className="flex items-center gap-2 text-sm font-semibold text-amber-950">
          <CloudOff size={16} aria-hidden /> Initial online setup required
        </p>
        <p className="mt-1 text-xs leading-relaxed text-amber-900">
          This device has not completed authentication and offline preparation. No
          offline login is possible without that setup. Connect to the internet and
          sign in normally once. Existing saved records are not affected.
        </p>
      </div>
    );
  }

  if (offlineContextExpired(context)) {
    return (
      <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4" role="status">
        <p className="flex items-center gap-2 text-sm font-semibold text-red-900">
          <LockKeyhole size={16} aria-hidden /> Offline access expired
        </p>
        <p className="mt-1 text-xs leading-relaxed text-red-800">
          Reconnect to the internet and sign in again to renew this device. Any
          collections saved on this device are preserved.
        </p>
      </div>
    );
  }

  const modules = context.modules.filter(
    (module) =>
      (module === "susu" || module === "momo") &&
      !offlineModuleBlockReason(context, module)
  );
  if (modules.length === 0) {
    return (
      <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4" role="status">
        <p className="flex items-center gap-2 text-sm font-semibold text-red-900">
          <LockKeyhole size={16} aria-hidden /> Offline access revoked
        </p>
        <p className="mt-1 text-xs leading-relaxed text-red-800">
          This device&apos;s offline authorization is no longer valid. Reconnect and
          ask your administrator to restore it. Collections saved on this device are
          preserved.
        </p>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4" role="status">
      <p className="flex items-center gap-2 text-sm font-semibold text-emerald-950">
        <ShieldCheck size={16} aria-hidden /> Offline access available
      </p>
      <p className="mt-1 text-xs leading-relaxed text-emerald-900">
        This device was prepared for {context.userName}. Open a previously authorized
        dashboard below. No password or server connection is required.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        {modules.map((module) => (
          <button
            key={module}
            type="button"
            onClick={() => openOffline(module)}
            disabled={busyModule !== null}
            className="btn btn-primary btn-sm flex-1"
            aria-busy={busyModule === module}
          >
            {busyModule === module
              ? "Opening…"
              : `Open ${moduleDisplayName(module)}`}
          </button>
        ))}
      </div>
      {error && (
        <p className="mt-2 text-xs font-medium text-red-800" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
