import Link from "next/link";
import { requirePlatformPage } from "@/lib/platform-auth";
import {
  listTenants,
  type TenantModuleFilter,
  type TenantOnboardingFilter,
  type TenantStatusFilter,
} from "@/lib/actions/platform.actions";
import { formatDateTime } from "@/lib/utils";
import { moduleBadge, onboardingLabel, TENANT_ONBOARDING, TENANT_STATUSES, tenantStatusBadge } from "../../tenant-ui";

export const dynamic = "force-dynamic";

interface SearchParams {
  q?: string;
  module?: string;
  status?: string;
  onboarding?: string;
  page?: string;
}

const MODULE_OPTIONS: { value: TenantModuleFilter; label: string }[] = [
  { value: "all", label: "All modules" },
  { value: "momo", label: "MoMo only" },
  { value: "susu", label: "Susu only" },
  { value: "both", label: "MoMo + Susu" },
];

const STATUS_OPTIONS: { value: TenantStatusFilter; label: string }[] = [
  { value: "all", label: "Any status" },
  ...TENANT_STATUSES.map((s) => ({ value: s as TenantStatusFilter, label: s })),
];

const ONBOARDING_OPTIONS: { value: TenantOnboardingFilter; label: string }[] = [
  { value: "all", label: "Any onboarding state" },
  ...TENANT_ONBOARDING.map((s) => ({ value: s as TenantOnboardingFilter, label: onboardingLabel(s) })),
];

export default async function PlatformTenantsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePlatformPage();
  const sp = await searchParams;

  const moduleFilter = MODULE_OPTIONS.some((o) => o.value === sp.module)
    ? (sp.module as TenantModuleFilter)
    : "all";
  const status = STATUS_OPTIONS.some((o) => o.value === sp.status)
    ? (sp.status as TenantStatusFilter)
    : "all";
  const onboarding = ONBOARDING_OPTIONS.some((o) => o.value === sp.onboarding)
    ? (sp.onboarding as TenantOnboardingFilter)
    : "all";
  const page = Math.max(1, parseInt(sp.page || "1", 10) || 1);

  // Server-side filtering and pagination — the browser never loads every tenant.
  const result = await listTenants({ search: sp.q, module: moduleFilter, status, onboarding, page });

  function pageLink(p: number) {
    const params = new URLSearchParams();
    if (sp.q) params.set("q", sp.q);
    if (moduleFilter !== "all") params.set("module", moduleFilter);
    if (status !== "all") params.set("status", status);
    if (onboarding !== "all") params.set("onboarding", onboarding);
    params.set("page", String(p));
    return `/platform/tenants?${params.toString()}`;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Businesses</h1>
          <p className="text-sm text-gray-500 mt-1">
            {result.total} enrolled {result.total === 1 ? "business" : "businesses"}
          </p>
        </div>
        <Link href="/platform/tenants/new" className="btn btn-primary whitespace-nowrap">
          ➕ Enroll Business
        </Link>
      </div>

      {/* Filters — plain GET form, fully server-side */}
      <form method="GET" action="/platform/tenants" className="card bg-white grid sm:grid-cols-4 gap-3 items-end">
        <div>
          <label className="form-label" htmlFor="q">Search</label>
          <input
            type="text"
            id="q"
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Business name or code"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="module">Modules</label>
          <select id="module" name="module" defaultValue={moduleFilter} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {MODULE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="form-label" htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={status} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="form-label" htmlFor="onboarding">Onboarding</label>
          <select id="onboarding" name="onboarding" defaultValue={onboarding} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {ONBOARDING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-4 flex gap-2">
          <button type="submit" className="btn btn-primary text-sm px-4 py-2">Apply filters</button>
          <Link href="/platform/tenants" className="btn text-sm px-4 py-2 border border-gray-300 text-gray-600 hover:bg-gray-50">
            Reset
          </Link>
        </div>
      </form>

      {result.tenants.length === 0 ? (
        <div className="card bg-white text-center py-12">
          <p className="text-gray-500 text-sm">
            No businesses match these filters.
          </p>
          <Link href="/platform/tenants/new" className="text-sm text-slate-700 underline mt-2 inline-block">
            Enroll a new business →
          </Link>
        </div>
      ) : (
        <div className="card bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-gray-400 border-b border-gray-100">
                <th className="py-3 px-4">Business</th>
                <th className="py-3 px-4">Modules</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Onboarding</th>
                <th className="py-3 px-4">Primary admin</th>
                <th className="py-3 px-4">Created</th>
                <th className="py-3 px-4">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {result.tenants.map((t) => (
                <tr key={t.id} className="hover:bg-gray-50">
                  <td className="py-3 px-4">
                    <Link href={`/platform/tenants/${t.id}`} className="font-medium text-gray-900 hover:text-slate-700">
                      {t.name}
                    </Link>
                    <p className="text-xs text-gray-500 font-mono">{t.code}</p>
                  </td>
                  <td className="py-3 px-4">{moduleBadge(t.momoEnabled, t.susuEnabled)}</td>
                  <td className="py-3 px-4">{tenantStatusBadge(t.status)}</td>
                  <td className="py-3 px-4 text-gray-600">{onboardingLabel(t.onboardingStatus)}</td>
                  <td className="py-3 px-4">
                    {t.primaryAdmin ? (
                      <>
                        <p className="text-gray-900">{t.primaryAdmin.fullName}</p>
                        <p className="text-xs text-gray-500">{t.primaryAdmin.email}</p>
                      </>
                    ) : (
                      <span className="text-amber-600 text-xs">Not provisioned</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-gray-600 whitespace-nowrap">{formatDateTime(t.createdAt)}</td>
                  <td className="py-3 px-4">
                    <Link
                      href={`/platform/tenants/${t.id}`}
                      className="text-sm text-slate-700 hover:text-slate-900 font-medium whitespace-nowrap"
                    >
                      Manage →
                    </Link>
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
            Page {result.page} of {result.pages}
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
