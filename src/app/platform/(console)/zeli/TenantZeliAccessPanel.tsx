"use client";

import { useState } from "react";
import { Loader2, Power, ShieldCheck } from "lucide-react";
import {
  listTenantZeliAccess,
  setTenantZeliAccess,
  type TenantZeliRow,
} from "@/lib/actions/zeli-tenant-access.actions";

/**
 * Per-business Zeli switch for Platform Super Admin.
 *
 * Global availability remains the master control; this panel can pause Zeli for
 * one business without touching its records, conversations or usage history.
 * Every change is confirmed with a written reason and written to the platform
 * audit trail server-side.
 */
export default function TenantZeliAccessPanel({
  initialRows,
  globalEnabled,
  globalReason,
}: {
  initialRows: TenantZeliRow[];
  globalEnabled: boolean;
  globalReason: string | null;
}) {
  const [rows, setRows] = useState(initialRows);
  const [editing, setEditing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    const result = await listTenantZeliAccess();
    if (result.success && result.data) setRows(result.data);
  }

  async function apply(row: TenantZeliRow, enabled: boolean) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await setTenantZeliAccess({
        tenantId: row.tenantId,
        enabled,
        reason,
      });
      if (!result.success) {
        setError(result.error ?? "The change could not be saved.");
        return;
      }
      setNotice(
        enabled
          ? `Zeli enabled for ${row.name}.`
          : `Zeli disabled for ${row.name}. Its records and conversations are unchanged.`
      );
      setEditing(null);
      setReason("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <ShieldCheck size={17} aria-hidden /> Zeli per business
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            A business can be paused individually without changing the global
            switch. Disabling never deletes conversations, usage or records.
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            globalEnabled ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"
          }`}
        >
          Platform: {globalEnabled ? "on" : "off"}
          {!globalEnabled && globalReason ? ` · ${globalReason}` : ""}
        </span>
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          {notice}
        </p>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[46rem] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2 pr-4">Business</th>
              <th className="py-2 pr-4">Package</th>
              <th className="py-2 pr-4">Usage this month</th>
              <th className="py-2 pr-4">Zeli</th>
              <th className="py-2">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.tenantId} className="align-top">
                <td className="py-3 pr-4">
                  <p className="font-medium text-slate-900">{row.name}</p>
                  <p className="text-xs text-slate-500">
                    {row.code} · {row.tenantStatus}
                  </p>
                  {row.reason && (
                    <p className="mt-1 max-w-xs text-xs text-slate-600">Reason: {row.reason}</p>
                  )}
                </td>
                <td className="py-3 pr-4 text-slate-700">
                  {row.planName ?? "No package"}
                  <p className="text-xs text-slate-500">{row.subscriptionStatus ?? "—"}</p>
                </td>
                <td className="py-3 pr-4 text-slate-700">
                  {row.allowance === null ? "—" : `${row.used} / ${row.allowance}`}
                </td>
                <td className="py-3 pr-4">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      row.zeliEnabled ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {row.zeliEnabled ? "On" : "Paused"}
                  </span>
                  {row.overrideSource === "default" && (
                    <p className="mt-1 text-xs text-slate-500">Default</p>
                  )}
                </td>
                <td className="py-3">
                  {editing === row.tenantId ? (
                    <div className="w-64 space-y-2">
                      <label className="block text-xs font-medium text-slate-700">
                        Reason (recorded in the audit trail)
                        <textarea
                          value={reason}
                          onChange={(event) => setReason(event.target.value)}
                          rows={2}
                          maxLength={500}
                          className="input mt-1 w-full text-xs"
                          placeholder="At least 10 characters"
                        />
                      </label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={busy || reason.trim().length < 10}
                          onClick={() => apply(row, !row.zeliEnabled)}
                        >
                          {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
                          {row.zeliEnabled ? "Disable Zeli" : "Enable Zeli"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={busy}
                          onClick={() => {
                            setEditing(null);
                            setReason("");
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        setEditing(row.tenantId);
                        setReason("");
                        setError("");
                        setNotice("");
                      }}
                    >
                      <Power size={13} aria-hidden /> {row.zeliEnabled ? "Pause" : "Enable"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-sm text-slate-600">
                  No businesses enrolled yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
