import { FileClock, Filter, RotateCcw, ScrollText } from "lucide-react";
import { requirePlatformPage } from "@/lib/platform-auth";
import { getPlatformAuditPage } from "@/lib/actions/platform.actions";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/platform-audit";
import { formatDateTime } from "@/lib/utils";
import { EmptyState, PageHeader, Pagination } from "@/components/ui/DataDisplay";

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
      <PageHeader
        title="Activity History"
        description="Platform operator actions. Business-level activity stays in each business's own audit trail."
      />

      <form method="GET" action="/platform/audit" className="card bg-white">
        <div className="grid sm:grid-cols-3 gap-3 items-end">
          <div>
            <label className="form-label" htmlFor="action">Action</label>
            <select id="action" name="action" defaultValue={sp.action ?? ""}>
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
              className="font-mono"
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary btn-sm">
              <Filter size={14} aria-hidden /> Apply filters
            </button>
            <a href="/platform/audit" className="btn btn-secondary btn-sm">
              <RotateCcw size={14} aria-hidden /> Reset
            </a>
          </div>
        </div>
      </form>

      {result.logs.length === 0 ? (
        <div className="card bg-white">
          <EmptyState
            icon={<FileClock />}
            title="No platform activity matches these filters"
            hint="Privileged actions — sign-ins, enrollments, suspensions, recovery — are recorded here."
          />
        </div>
      ) : (
        <div className="card bg-white !p-0 overflow-hidden">
          <div className="table-container">
            <table>
              <caption className="sr-only">Platform audit history</caption>
              <thead>
                <tr className="border-b border-slate-100">
                  <th scope="col" className="py-3 px-4">When</th>
                  <th scope="col" className="py-3 px-4">Actor</th>
                  <th scope="col" className="py-3 px-4">Action</th>
                  <th scope="col" className="py-3 px-4">Business</th>
                  <th scope="col" className="py-3 px-4">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.logs.map((e) => (
                  <tr key={e.id} className="align-top">
                    <td className="py-3 px-4 text-slate-600 whitespace-nowrap">{formatDateTime(e.createdAt)}</td>
                    <td className="py-3 px-4 text-slate-800">{e.actorEmail || "system"}</td>
                    <td className="py-3 px-4">
                      <span className="inline-flex items-center gap-1.5 font-mono text-xs bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-slate-700 whitespace-nowrap">
                        <ScrollText size={11} aria-hidden />
                        {e.action}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-700 font-mono text-xs">{e.tenantCode || "—"}</td>
                    <td className="py-3 px-4 text-xs text-slate-600 max-w-md break-words">
                      {e.reason && (
                        <p className="text-slate-800 mb-1">
                          <span className="font-medium">Reason:</span> {e.reason}
                        </p>
                      )}
                      {e.details ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 border-t border-slate-100">
            <Pagination page={result.page} pages={result.pages} total={result.total} makeHref={pageLink} />
          </div>
        </div>
      )}
    </div>
  );
}
