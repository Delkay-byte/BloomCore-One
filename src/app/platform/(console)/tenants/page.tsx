import Link from "next/link";
import { Building2, Filter, RotateCcw, Search, UserPlus } from "lucide-react";
import { requirePlatformPage } from "@/lib/platform-auth";
import {
  listTenants,
  type TenantModuleFilter,
  type TenantOnboardingFilter,
  type TenantStatusFilter,
} from "@/lib/actions/platform.actions";
import { formatDateTime } from "@/lib/utils";
import { EmptyState, NoResults, PageHeader, Pagination } from "@/components/ui/DataDisplay";
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

  const hasFilters = Boolean(sp.q) || moduleFilter !== "all" || status !== "all" || onboarding !== "all";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Businesses"
        description={`${result.total} enrolled ${result.total === 1 ? "business" : "businesses"} on the platform.`}
        actions={
          <Link href="/platform/tenants/new" className="btn btn-primary">
            <UserPlus size={16} aria-hidden /> Enroll Business
          </Link>
        }
      />

      {/* Filters — plain GET form, fully server-side */}
      <form method="GET" action="/platform/tenants" className="card bg-white">
        <div className="grid sm:grid-cols-4 gap-3 items-end">
          <div>
            <label className="form-label" htmlFor="q">Search</label>
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
              <input
                type="text"
                id="q"
                name="q"
                defaultValue={sp.q ?? ""}
                placeholder="Business name or code"
                className="!pl-9"
              />
            </div>
          </div>
          <div>
            <label className="form-label" htmlFor="module">Modules</label>
            <select id="module" name="module" defaultValue={moduleFilter}>
              {MODULE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={status}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="onboarding">Onboarding</label>
            <select id="onboarding" name="onboarding" defaultValue={onboarding}>
              {ONBOARDING_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button type="submit" className="btn btn-primary btn-sm">
            <Filter size={14} aria-hidden /> Apply filters
          </button>
          <Link href="/platform/tenants" className="btn btn-secondary btn-sm">
            <RotateCcw size={14} aria-hidden /> Reset
          </Link>
        </div>
      </form>

      {result.tenants.length === 0 ? (
        <div className="card bg-white">
          {hasFilters ? (
            <NoResults hint="No businesses match these filters. Try widening or clearing them." />
          ) : (
            <EmptyState
              icon={<Building2 />}
              title="No businesses enrolled yet"
              hint="Enroll the first MoMo business, Susu agency or combined business."
              action={
                <Link href="/platform/tenants/new" className="btn btn-primary btn-sm">
                  <UserPlus size={14} aria-hidden /> Enroll Business
                </Link>
              }
            />
          )}
        </div>
      ) : (
        <div className="card bg-white !p-0 overflow-hidden">
          <div className="table-container">
            <table>
              <caption className="sr-only">Enrolled businesses</caption>
              <thead>
                <tr className="border-b border-slate-100">
                  <th scope="col" className="py-3 px-4">Business</th>
                  <th scope="col" className="py-3 px-4">Modules</th>
                  <th scope="col" className="py-3 px-4">Status</th>
                  <th scope="col" className="py-3 px-4">Onboarding</th>
                  <th scope="col" className="py-3 px-4">Primary admin</th>
                  <th scope="col" className="py-3 px-4">Created</th>
                  <th scope="col" className="py-3 px-4"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.tenants.map((t) => (
                  <tr key={t.id}>
                    <td className="py-3 px-4">
                      <Link href={`/platform/tenants/${t.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                        {t.name}
                      </Link>
                      <p className="text-xs text-slate-500 font-mono">{t.code}</p>
                    </td>
                    <td className="py-3 px-4">{moduleBadge(t.momoEnabled, t.susuEnabled)}</td>
                    <td className="py-3 px-4">{tenantStatusBadge(t.status)}</td>
                    <td className="py-3 px-4 text-slate-600">{onboardingLabel(t.onboardingStatus)}</td>
                    <td className="py-3 px-4">
                      {t.primaryAdmin ? (
                        <>
                          <p className="text-slate-900">{t.primaryAdmin.fullName}</p>
                          <p className="text-xs text-slate-500">{t.primaryAdmin.email}</p>
                        </>
                      ) : (
                        <span className="badge badge-yellow">Not provisioned</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-600 whitespace-nowrap">{formatDateTime(t.createdAt)}</td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <Link
                        href={`/platform/tenants/${t.id}`}
                        className="text-sm font-medium text-brand-700 hover:text-brand-800"
                        aria-label={`Manage ${t.name}`}
                      >
                        Manage &rarr;
                      </Link>
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
