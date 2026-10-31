import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePlatformPage } from "@/lib/platform-auth";
import { getTenantDetail } from "@/lib/actions/platform.actions";
import { formatDateTime } from "@/lib/utils";
import TenantManagement from "./TenantManagement";
import { moduleBadge, onboardingLabel, tenantStatusBadge } from "../../../tenant-ui";

export const dynamic = "force-dynamic";

export default async function PlatformTenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePlatformPage();
  const { id } = await params;
  const detail = await getTenantDetail(id);
  if (!detail) notFound();

  const { tenant, primaryAdmin, aggregates, audit } = detail;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/platform/tenants" className="text-xs text-slate-500 hover:text-slate-700">
          ← All businesses
        </Link>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-2">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{tenant.name}</h1>
            <p className="text-sm text-slate-500 mt-1 flex flex-wrap items-center gap-2">
              <span className="font-mono">{tenant.code}</span>
              {moduleBadge(tenant.momoEnabled, tenant.susuEnabled)}
              {tenantStatusBadge(tenant.status)}
              <span className="text-slate-400">·</span>
              <span>Onboarding: {onboardingLabel(tenant.onboardingStatus)}</span>
            </p>
          </div>
        </div>
        {tenant.status === "SUSPENDED" && tenant.suspensionReason && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mt-3">
            Suspended {tenant.suspendedAt ? formatDateTime(tenant.suspendedAt) : ""} — {tenant.suspensionReason}
          </div>
        )}
      </div>

      {/* Business profile */}
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="card bg-white">
          <h2 className="font-semibold text-slate-900 mb-4">Business profile</h2>
          <dl className="space-y-2 text-sm">
            <Row label="Business name" value={tenant.name} />
            <Row label="Legal name" value={tenant.legalName || "—"} />
            <Row label="Contact phone" value={tenant.contactPhone || "—"} />
            <Row label="Contact email" value={tenant.contactEmail || "—"} />
            <Row label="Address" value={tenant.address || "—"} />
            <Row label="Created" value={formatDateTime(tenant.createdAt)} />
            {tenant.activatedAt && <Row label="Activated" value={formatDateTime(tenant.activatedAt)} />}
            <Row label="Enabled modules" value={[tenant.momoEnabled && "MoMo", tenant.susuEnabled && "Susu"].filter(Boolean).join(", ") || "None"} />
          </dl>
        </div>

        {/* Primary administrator */}
        <div className="card bg-white">
          <h2 className="font-semibold text-slate-900 mb-4">Primary administrator</h2>
          {primaryAdmin ? (
            <dl className="space-y-2 text-sm">
              <Row label="Name" value={primaryAdmin.fullName} />
              <Row label="Email" value={primaryAdmin.email} />
              <Row label="Phone" value={primaryAdmin.phone || "—"} />
              <Row label="Account status" value={primaryAdmin.status} />
              {primaryAdmin.forcePasswordReset && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2 text-xs">
                  A password change will be required at next sign-in.
                </div>
              )}
            </dl>
          ) : (
            <p className="text-sm text-amber-600">No administrator provisioned for this business.</p>
          )}
          <p className="text-xs text-slate-400 mt-4">
            Credentials are never displayed. Use the recovery action below to issue a
            secure one-time temporary password if the administrator is locked out.
          </p>
        </div>
      </div>

      {/* Operational overview — aggregate counts only */}
      <div className="card bg-white">
        <h2 className="font-semibold text-slate-900 mb-4">Operational overview</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4 text-center">
          {tenant.momoEnabled && (
            <>
              <Metric label="Active workers" value={aggregates.workers} />
              <Metric label="Locations" value={aggregates.locations} />
              <Metric label="Daily accounts" value={aggregates.dailyAccounts} />
            </>
          )}
          {tenant.susuEnabled && (
            <>
              <Metric label="Active collectors" value={aggregates.collectors} />
              <Metric label="Customers" value={aggregates.customers} />
              <Metric label="Contributions" value={aggregates.contributions} />
              <Metric label="Withdrawals" value={aggregates.withdrawals} />
            </>
          )}
          {!tenant.momoEnabled && !tenant.susuEnabled && (
            <p className="col-span-full text-sm text-slate-500">No modules enabled.</p>
          )}
        </div>
        {tenant.momoEnabled && (
          <p className="text-xs text-slate-500 mt-4">
            Last submitted daily account:{" "}
            {aggregates.lastSubmittedAt ? formatDateTime(aggregates.lastSubmittedAt) : "none yet"}
          </p>
        )}
      </div>

      <TenantManagement
        tenant={{
          id: tenant.id,
          name: tenant.name,
          legalName: tenant.legalName ?? "",
          contactPhone: tenant.contactPhone ?? "",
          contactEmail: tenant.contactEmail ?? "",
          address: tenant.address ?? "",
          momoEnabled: tenant.momoEnabled,
          susuEnabled: tenant.susuEnabled,
          status: tenant.status,
        }}
        primaryAdmin={primaryAdmin ? { id: primaryAdmin.id, email: primaryAdmin.email } : null}
      />

      {/* Business-scoped platform events */}
      <div className="card bg-white">
        <h2 className="font-semibold text-slate-900 mb-4">Platform events for this business</h2>
        {audit.length === 0 ? (
          <p className="text-sm text-slate-500">No platform events recorded for this business yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {audit.map((e) => (
              <li key={e.id} className="py-2.5">
                <p className="text-slate-900">{e.action.replace("tenant.", "").replace(/_/g, " ")}</p>
                <p className="text-xs text-slate-500">
                  {e.actorEmail || "system"} · {formatDateTime(e.createdAt)}
                  {e.reason ? ` · ${e.reason}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-900 text-right break-words">{value}</dd>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-slate-50 rounded-lg px-3 py-4">
      <p className="text-2xl font-bold text-slate-900">{value}</p>
      <p className="text-xs text-slate-500 mt-1">{label}</p>
    </div>
  );
}
