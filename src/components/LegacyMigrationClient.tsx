"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import {
  getOfflineStatus,
  type OfflineStatus,
} from "@/lib/offline/session";
import { syncPendingTransactions } from "@/lib/offline/sync";
import { Skeleton } from "@/components/ui/Skeletons";

interface Props {
  signedIn: boolean;
  legacyHost: boolean;
  canonicalUrl: string;
}

/**
 * Explicit offline-record migration page.
 *
 * On the old origin this page reads the signed-in user's scoped IndexedDB
 * queue and submits every pending record through the normal synchronization
 * route. The server idempotency key is unchanged, so retrying or reloading can
 * never create a second financial record.
 *
 * On the canonical origin the browser cannot read another origin's IndexedDB.
 * The page says that plainly instead of implying the records were moved.
 */
export default function LegacyMigrationClient({
  signedIn,
  legacyHost,
  canonicalUrl,
}: Props) {
  const [status, setStatus] = useState<OfflineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [attempted, setAttempted] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getOfflineStatus());
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (signedIn && legacyHost) {
      void refresh();
    } else {
      setLoading(false);
    }
  }, [refresh, signedIn, legacyHost]);

  async function synchronize() {
    setBusy(true);
    setNotice("");
    try {
      const results = await syncPendingTransactions();
      setAttempted(true);
      if (results.some((result) => result.authExpired)) {
        setNotice("Your session expired. Sign in again on this old address, then retry.");
      } else if (results.length === 0) {
        setNotice("No pending records were ready to synchronize. Review the counts below.");
      } else {
        setNotice("Synchronization attempt finished. Review the confirmed counts below.");
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!signedIn) {
    return (
      <section className="card space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Sign in on this address first</h2>
        <p className="text-sm text-slate-700">
          Offline records are stored per account and per browser origin. Sign in
          on this old address to let MaaCash read and synchronize this
          account&apos;s records, then return to this page.
        </p>
        <a className="btn btn-primary btn-sm w-fit" href="/login">
          Sign in
        </a>
      </section>
    );
  }

  if (!legacyHost) {
    return (
      <section className="card space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">
          This is the new MaaCash address
        </h2>
        <p className="text-sm text-slate-700">
          Records saved offline on <code>maacash.onrender.com</code> belong to
          that browser origin. This address cannot read or move them. Open the
          old address, sign in, and synchronize there before it is retired.
        </p>
        <p className="text-sm text-slate-700">
          After synchronization is confirmed on the old address, sign in here
          again and prepare this device for offline use on the new address.
        </p>
        <a
          className="btn btn-secondary btn-sm w-fit"
          href="https://maacash.onrender.com/migrate"
        >
          Open the old address
        </a>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="card space-y-3" aria-busy="true">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-24 w-full rounded-control" />
      </section>
    );
  }

  if (!status) {
    return (
      <section className="card space-y-3" role="alert">
        <h2 className="text-lg font-semibold text-slate-900">
          Offline records could not be read
        </h2>
        <p className="text-sm text-slate-700">
          Do not clear this browser&apos;s site data. Close other MaaCash tabs,
          reload this page, and try again.
        </p>
      </section>
    );
  }

  const summary = status.summary;
  const unresolved = summary.unresolved;
  const confirmed =
    status.available && attempted && unresolved === 0;

  return (
    <div className="space-y-4">
      <section className="card space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">
          Synchronize offline records from this old address
        </h2>
        <p className="text-sm text-slate-700">
          These records are stored only in this browser on this old origin.
          Keep this page open while synchronization runs. Do not sign out, clear
          site data, or close the browser until every record is confirmed by the
          server.
        </p>

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-control border border-line p-3">
            <dt className="text-xs text-slate-600">Waiting</dt>
            <dd className="text-xl font-semibold text-slate-900">{summary.pending}</dd>
          </div>
          <div className="rounded-control border border-line p-3">
            <dt className="text-xs text-slate-600">Synchronizing</dt>
            <dd className="text-xl font-semibold text-slate-900">{summary.syncing}</dd>
          </div>
          <div className="rounded-control border border-line p-3">
            <dt className="text-xs text-slate-600">Confirmed</dt>
            <dd className="text-xl font-semibold text-slate-900">{summary.synced}</dd>
          </div>
          <div className="rounded-control border border-line p-3">
            <dt className="text-xs text-slate-600">Failed</dt>
            <dd className="text-xl font-semibold text-slate-900">{summary.failed}</dd>
          </div>
        </dl>

        {!status.available && (
          <p className="rounded-control border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            The offline queue could not be read. This is not treated as empty.
            Close other MaaCash tabs and reload before you switch addresses.
          </p>
        )}

        {summary.failedRecords.length > 0 && (
          <div className="rounded-control border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
            <p className="font-semibold">
              <AlertTriangle size={16} className="mr-1.5 inline -mt-0.5" aria-hidden />
              Failed records need review
            </p>
            <ul className="mt-1 list-disc pl-5">
              {summary.failedRecords.map((record) => (
                <li key={record.id}>
                  {record.type.replaceAll("_", " ")} — {record.failureReason ?? "failed"}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={synchronize}
            className="btn btn-primary btn-sm"
            disabled={busy || !status.online || !status.available}
          >
            <RefreshCw size={14} className={busy ? "animate-spin" : ""} aria-hidden />
            {busy ? "Synchronizing…" : "Synchronize now"}
          </button>
          <a className="btn btn-secondary btn-sm" href={canonicalUrl}>
            Open the new address
          </a>
        </div>

        {!status.online && (
          <p className="text-sm text-amber-800" role="status">
            This device is offline. Reconnect before synchronizing.
          </p>
        )}

        {notice && (
          <p className="text-sm text-slate-700" role="status" aria-live="polite">
            {notice}
          </p>
        )}

        {confirmed && (
          <p className="flex items-start gap-2 rounded-control border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden />
            Every record for this account on this device is confirmed by the
            server. You can now sign in on the new address and prepare offline
            use there.
          </p>
        )}

        {unresolved > 0 && attempted && (
          <p className="rounded-control border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
            {unresolved} record{unresolved === 1 ? " is" : "s are"} still not
            confirmed. Keep this page open and retry. Do not remove offline data
            or clear site storage.
          </p>
        )}
      </section>

      <section className="card space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">Shared device?</h3>
        <p className="text-sm text-slate-700">
          Offline records are stored per account. Every account that used this
          browser on the old address must sign in and synchronize separately
          before the old address is retired.
        </p>
      </section>
    </div>
  );
}
