"use client";

import { useState } from "react";
import {
  Activity,
  Building2,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  getZeliPlatformOverview,
  getZeliTenantDetail,
  listZeliTenants,
  updateZeliEntitlement,
  type EntitlementAction,
  type PlatformZeliDetail,
  type ZeliPlatformOverview,
  type PlatformZeliTenantRow,
} from "@/lib/actions/zeli-platform.actions";
import { formatDateTime } from "@/lib/utils";

function statusBadge(row: PlatformZeliTenantRow) {
  if (!row.entitlement) return { label: "No subscription", cls: "badge-gray" };
  if (row.entitlement.allowed) return { label: "Active", cls: "badge-green" };
  if (row.entitlement.effectiveStatus === "expired") return { label: "Expired", cls: "badge-yellow" };
  if (row.entitlement.effectiveStatus === "suspended") return { label: "Suspended", cls: "badge-red" };
  if (row.entitlement.effectiveStatus === "revoked") return { label: "Revoked", cls: "badge-red" };
  return { label: row.entitlement.effectiveStatus, cls: "badge-gray" };
}

export default function ZeliControlCentre({
  initialOverview,
  initialTenants,
}: {
  initialOverview: ZeliPlatformOverview;
  initialTenants: PlatformZeliTenantRow[];
}) {
  const [overview, setOverview] = useState(initialOverview);
  const [tenants, setTenants] = useState(initialTenants);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<PlatformZeliDetail | null>(null);
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState<EntitlementAction | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const [rows, freshOverview] = await Promise.all([
        listZeliTenants(search),
        getZeliPlatformOverview(),
      ]);
      setTenants(rows);
      setOverview(freshOverview);
    } catch {
      setError("Could not load businesses.");
    } finally {
      setLoading(false);
    }
  }

  async function openTenant(tenantId: string) {
    setError("");
    setNotice("");
    setReason("");
    setExpiresAt("");
    setDetail(null);
    try {
      const result = await getZeliTenantDetail(tenantId);
      if (!result) {
        setError("Business not found.");
        return;
      }
      setDetail(result);
    } catch {
      setError("Could not load the entitlement history.");
    }
  }

  async function apply(action: EntitlementAction) {
    if (!detail) return;
    setError("");
    setNotice("");
    if (reason.trim().length < 10) {
      setError("Enter a reason of at least 10 characters.");
      return;
    }
    if (
      (action === "revoke" || action === "suspend") &&
      !window.confirm(
        `${
          action === "revoke" ? "Revoke" : "Suspend"
        } Zeli Business Intelligence for ${detail.tenant.name}? Existing conversations remain available; the analytics workspace is closed immediately.`
      )
    ) {
      return;
    }
    setBusy(action);
    try {
      const result = await updateZeliEntitlement({
        tenantId: detail.tenant.id,
        action,
        reason,
        expiresAt: expiresAt || null,
      });
      if (!result.success) {
        setError(result.error ?? "The entitlement change failed.");
        return;
      }
      setNotice(`Entitlement ${action === "grant" ? "granted" : action} recorded.`);
      const [freshDetail, rows, freshOverview] = await Promise.all([
        getZeliTenantDetail(detail.tenant.id),
        listZeliTenants(search),
        getZeliPlatformOverview(),
      ]);
      setDetail(freshDetail);
      setTenants(rows);
      setOverview(freshOverview);
      setReason("");
    } catch {
      setError("The entitlement change failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6" data-testid="platform-zeli">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Platform control centre
          </p>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold text-slate-900">
            <Sparkles size={20} aria-hidden /> Zeli
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Subscription entitlement, aggregate adoption and provider status. This page never
            exposes tenant customer or financial records.
          </p>
        </div>
        <p className="text-xs text-slate-400">Checked {formatDateTime(overview.checkedAt)}</p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Zeli platform overview">
        <Metric label="Total businesses" value={overview.totals.businesses} icon={<Building2 size={16} aria-hidden />} />
        <Metric label="Active Zeli Analytics" value={overview.totals.activeSubscribers} icon={<CheckCircle2 size={16} aria-hidden />} />
        <Metric label="Suspended / revoked" value={overview.totals.suspended + overview.totals.revoked} icon={<ShieldAlert size={16} aria-hidden />} />
        <Metric label="Never granted" value={overview.totals.neverGranted} icon={<Activity size={16} aria-hidden />} />
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="card bg-white">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="font-semibold text-slate-900">Business entitlements</h2>
            <form onSubmit={runSearch} className="flex gap-2">
              <label className="sr-only" htmlFor="zeli-tenant-search">
                Search businesses
              </label>
              <input
                id="zeli-tenant-search"
                className="w-56"
                placeholder="Business name or code"
                value={search}
                maxLength={80}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button type="submit" className="btn btn-secondary btn-sm" disabled={loading}>
                {loading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Search size={14} aria-hidden />}
                Search
              </button>
            </form>
          </div>

          {error && (
            <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
              {error}
            </p>
          )}

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th scope="col">Business</th>
                  <th scope="col">Tenant</th>
                  <th scope="col">Zeli Analytics</th>
                  <th scope="col">Expiry</th>
                  <th scope="col"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {tenants.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-sm text-slate-500">
                      No business matches that search.
                    </td>
                  </tr>
                )}
                {tenants.map((row) => {
                  const badge = statusBadge(row);
                  return (
                    <tr key={row.tenantId}>
                      <td>
                        <span className="font-medium text-slate-900">{row.name}</span>
                      </td>
                      <td className="font-mono text-xs">{row.code}</td>
                      <td>
                        <span className={`badge ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td className="text-xs text-slate-500">
                        {row.entitlement?.expiresAt
                          ? row.entitlement.expiresAt.slice(0, 10)
                          : "No expiry"}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:text-brand-900"
                          onClick={() => openTenant(row.tenantId)}
                        >
                          Manage <ChevronRight size={13} aria-hidden />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="card bg-white" aria-label="Provider status">
            <h2 className="flex items-center gap-2 font-semibold text-slate-900">
              <ShieldCheck size={16} aria-hidden /> Provider status
            </h2>
            <p className={`mt-2 rounded-lg border px-3 py-2 text-sm ${
              overview.provider.external.state === "disabled"
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-emerald-200 bg-emerald-50 text-emerald-900"
            }`}>
              {overview.provider.message}
            </p>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Local engine" value="Internal deterministic (active)" />
              <Row label="External provider" value={overview.provider.external.state === "disabled" ? "Disabled" : "DeepSeek"} />
              <Row label="DeepSeek" value={overview.provider.external.state === "disabled" ? "Disabled by policy" : overview.provider.external.state} />
              <Row label="Approval recorded" value={overview.provider.external.productionApproved ? "Yes" : "No"} />
              <Row
                label="Credential present"
                value={overview.provider.external.credentialConfigured ? "Yes (still inert)" : "No"}
              />
              <Row label="Policy phase" value={overview.provider.external.state} />
            </dl>
            <p className="mt-2 text-xs text-slate-500">
              Use the External AI control panel below. Production processing stays locked behind
              the code, privacy and approval gates.
            </p>
          </section>

          <section className="card bg-white" aria-label="Usage and health">
            <h2 className="font-semibold text-slate-900">Usage and refresh health</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Conversations" value={String(overview.usage.conversations)} />
              <Row label="Messages" value={String(overview.usage.messages)} />
              <Row label="Requests today" value={String(overview.usage.requestsToday)} />
              <Row label="Requests (30 days)" value={String(overview.usage.requests30Days)} />
              <Row label="Users at daily limit" value={String(overview.usage.usersAtDailyLimit)} />
              <Row label="Successful refresh ranges" value={String(overview.refreshHealth.successfulRanges)} />
              <Row label="Failed refresh ranges" value={String(overview.refreshHealth.failedRanges)} />
              <Row label="Failures (24h)" value={String(overview.refreshHealth.failures24h)} />
              <Row
                label="Average refresh latency"
                value={
                  overview.refreshHealth.averageDurationMs == null
                    ? "Not measured yet"
                    : `${overview.refreshHealth.averageDurationMs} ms`
                }
              />
              <Row
                label="Latest refresh"
                value={
                  overview.refreshHealth.latestRefreshAt
                    ? formatDateTime(overview.refreshHealth.latestRefreshAt)
                    : "No refresh yet"
                }
              />
            </dl>
          </section>
        </aside>
      </div>

      <section className="card bg-white" aria-label="Adoption">
        <h2 className="font-semibold text-slate-900">Adoption trend</h2>
        {overview.adoption.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No entitlement changes have been recorded.</p>
        ) : (
          <div className="mt-3 flex items-end gap-4 overflow-x-auto pb-2">
            {overview.adoption.map((month) => {
              const height = Math.max(4, Math.min(120, month.granted * 12));
              return (
                <div key={month.month} className="flex min-w-16 flex-col items-center gap-1">
                  <span className="text-xs text-slate-500">{month.granted}</span>
                  <div
                    className="w-10 rounded-t bg-brand-700"
                    style={{ height }}
                    aria-label={`${month.month}: ${month.granted} granted, ${month.revoked} revoked`}
                  />
                  <span className="text-[10px] text-slate-400">{month.month}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {detail && (
        <section className="card bg-white" aria-label="Entitlement management" data-testid="zeli-entitlement-panel">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-900">
                {detail.tenant.name} <span className="font-mono text-xs text-slate-500">{detail.tenant.code}</span>
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Tenant status: {detail.tenant.status} · Conversations: {detail.usage.conversations} ·
                Requests (30 days): {detail.usage.requests30Days}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="rounded p-1 text-slate-400 hover:text-slate-700"
              aria-label="Close entitlement panel"
            >
              <X size={16} aria-hidden />
            </button>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Entitlement</h3>
              {detail.entitlement ? (
                <dl className="mt-2 space-y-1.5 text-sm">
                  <Row label="Status" value={detail.entitlement.status} />
                  <Row label="Effective" value={detail.access?.allowed ? "active" : detail.access?.reason ?? "inactive"} />
                  <Row label="Source" value={detail.entitlement.source} />
                  <Row label="Starts" value={formatDateTime(detail.entitlement.startsAt)} />
                  <Row label="Expires" value={detail.entitlement.expiresAt ? formatDateTime(detail.entitlement.expiresAt) : "No expiry"} />
                </dl>
              ) : (
                <p className="mt-2 text-sm text-slate-500">No Zeli Analytics entitlement exists.</p>
              )}

              <div className="mt-4 space-y-2">
                <label className="block text-sm">
                  <span className="font-medium text-slate-700">Reason (required, min 10 characters)</span>
                  <textarea
                    className="mt-1 w-full"
                    rows={2}
                    maxLength={500}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  <span className="font-medium text-slate-700">Expiry date (optional)</span>
                  <input
                    type="date"
                    className="mt-1 block"
                    value={expiresAt}
                    onChange={(event) => setExpiresAt(event.target.value)}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy !== null}
                    onClick={() => apply(detail.entitlement ? "reactivate" : "grant")}
                  >
                    {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
                    {detail.entitlement ? "Reactivate / update" : "Grant entitlement"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy !== null || !detail.entitlement || detail.entitlement.status === "suspended"}
                    onClick={() => apply("suspend")}
                  >
                    Suspend
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy !== null || !detail.entitlement || detail.entitlement.status === "revoked"}
                    onClick={() => apply("revoke")}
                  >
                    Revoke
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy !== null || !detail.entitlement}
                    onClick={() => apply("expire")}
                  >
                    Expire now
                  </button>
                </div>
                <p className="text-xs text-slate-500">
                  Every change requires a reason and is written to the platform audit trail.
                  Revoking closes the analytics workspace immediately; the conversational assistant
                  is unaffected.
                </p>
                {notice && (
                  <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800" role="status">
                    {notice}
                  </p>
                )}
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-slate-800">Entitlement history</h3>
              {detail.history.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">No changes recorded.</p>
              ) : (
                <ol className="mt-2 max-h-80 space-y-2 overflow-y-auto text-sm">
                  {detail.history.map((event) => (
                    <li key={event.id} className="rounded-lg border border-slate-200 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-slate-800">{event.action}</span>
                        <span className="text-xs text-slate-400">{formatDateTime(event.createdAt)}</span>
                      </div>
                      <p className="text-xs text-slate-500">
                        {event.previousStatus ?? "none"} → {event.status} · {event.actorType}
                      </p>
                      <p className="mt-1 text-slate-700">{event.reason}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </section>
      )}

      <section className="card bg-white">
        <h2 className="font-semibold text-slate-900">Recent entitlement activity</h2>
        {overview.recentEntitlementActivity.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No entitlement activity recorded.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {overview.recentEntitlementActivity.map((event) => (
              <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{event.action}</span>
                  {event.tenantCode ? ` · ${event.tenantCode}` : ""}
                </span>
                <span className="text-xs text-slate-400">{formatDateTime(event.createdAt)}</span>
                <span className="w-full text-xs text-slate-500">{event.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <div className="card !p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        <span className="text-brand-400">{icon}</span>
      </div>
      <p className="mt-1 text-2xl font-bold text-slate-900 tnum">{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-800">{value}</dd>
    </div>
  );
}
