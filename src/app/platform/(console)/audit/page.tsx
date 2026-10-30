import Link from "next/link";
import { requirePlatformPage } from "@/lib/platform-auth";
import { getPlatformAuditPage } from "@/lib/actions/platform.actions";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/platform-audit";
import { formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

const ACTION_OPTIONS = [
  { value: "", label: "All actions" },
  { value: PLATFORM_AUDIT_ACTIONS.PLATFORM_LOGIN, label: "Platform sign-in" },
  { value: PLATFORM_AUDIT_ACTIONS.PLATFORM_LOGIN_FAILED, label: "Failed platform sign-in" },
  { value: PLATFORM_AUDIT_ACTIONS.PLATFORM_LOGOUT, label: "Platform sign-out" },
  { value: PLATFORM_AUDIT_ACTIONS.PLATFORM_PASSWORD_CHANGED, label: "Platform password changed" },
  { value: PLATFORM_AUDIT_ACTIONS.TENANT_CREATED, label: "Business enrolled" },
  { value: PLATFORM_AUDIT_ACTIONS.TENANT_ACTIVATED, label: "Business activated" },
  { value: PLATFORM_AUDIT_ACTIONS.TENANT_SUSPENDED, label: "Business suspended" },
  { value: PLATFORM_AUDIT_ACTIONS.TENANT_REACTIVATED, label: "Business reactivated" },
  { value: PLATFORM_AUDIT_ACTIONS.TENANT_PROFILE_UPDATED, label: "Profile updated" },
  { value: PLATFORM_AUDIT_ACTIONS.TENANT_MODULES_CHANGED, label: "Modules changed" },
  { value: PLATFORM_AUDIT_ACTIONS.TENANT_ADMIN_PROVISIONED, label: "Admin provisioned" },
  { value: PLATFORM_AUDIT_ACTIONS.TENANT_ADMIN_RECOVERY_INITIATED, label: "Admin access reset" },
];

interface SearchParams {
  page?: string;
  action?: string;
  tenant?: string;
}

export default async function PlatformAuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePlatformPage();
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page || "1", 10) || 1);

  const result = await getPlatformAuditPage({
    page,
    action: sp.action || undefined,
    tenantCode: sp.tenant || undefined,
  });

  function pageLink(p: number) {
    const params = new URLSearchParams();
    if (sp.action) params.set("action", sp.action);
    if (sp.tenant) params.set("tenant", sp.tenant);
    params.set("page", String(p));
    return `/platform/audit?${params.toString()}`;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Activity History</h1>
        <p className="text-sm text-gray-500 mt-1">
          Platform operator actions. Business-level activity stays in each business&apos;s own audit trail.
        </p>
      </div>

      <form method="GET" action="/platform/audit" className="card bg-white grid sm:grid-cols-3 gap-3 items-end">
        <div>
          <label className="form-label" htmlFor="action">Action</label>
          <select id="action" name="action" defaultValue={sp.action ?? ""} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {ACTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="form-label" htmlFor="tenant">Tenant code</label>
          <input
            id="tenant"
            name="tenant"
            defaultValue={sp.tenant ?? ""}
            placeholder="e.g. BT-7K4M2X"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
          />
        </div>
        <button type="submit" className="btn btn-primary text-sm px-4 py-2">Apply filters</button>
      </form>

      {result.logs.length === 0 ? (
        <div className="card bg-white text-center py-12">
          <p className="text-gray-500 text-sm">No platform activity matches these filters.</p>
        </div>
      ) : (
        <div className="card bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-gray-400 border-b border-gray-100">
                <th className="py-3 px-4">When</th>
                <th className="py-3 px-4">Actor</th>
                <th className="py-3 px-4">Action</th>
                <th className="py-3 px-4">Business</th>
                <th className="py-3 px-4">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {result.logs.map((e) => (
                <tr key={e.id} className="align-top hover:bg-gray-50">
                  <td className="py-3 px-4 text-gray-600 whitespace-nowrap">{formatDateTime(e.createdAt)}</td>
                  <td className="py-3 px-4 text-gray-800">{e.actorEmail || "system"}</td>
                  <td className="py-3 px-4">
                    <span className="font-mono text-xs bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-slate-700">
                      {e.action}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-gray-700 font-mono text-xs">{e.tenantCode || "—"}</td>
                  <td className="py-3 px-4 text-xs text-gray-600 max-w-md break-words">
                    {e.reason && <p className="text-gray-800 mb-1">Reason: {e.reason}</p>}
                    {e.details ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result.pages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500">
            Page {result.page} of {result.pages} · {result.total} events
          </p>
          <div className="flex gap-2">
            {result.page > 1 && (
              <Link href={pageLink(result.page - 1)} className="btn text-sm px-3 py-1.5 border border-gray-300 text-gray-600 hover:bg-gray-50">
                ← Previous
              </Link>
            )}
            {result.page < result.pages && (
              <Link href={pageLink(result.page + 1)} className="btn text-sm px-3 py-1.5 border border-gray-300 text-gray-600 hover:bg-gray-50">
                Next →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
