import { PageHeader } from "@/components/ui/DataDisplay";
import { getPlatformBillingOverview } from "@/lib/actions/platform-billing.actions";
import { getProvisioningOptions, getTenantMapping } from "@/lib/actions/provisioning.actions";
import { formatDateTime } from "@/lib/utils";
import AssignPackageForm from "./AssignPackageForm";

export const dynamic = "force-dynamic";

function money(value: number) {
  return `GH₵${value.toLocaleString("en-GH", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function day(value: string | null) {
  return value ? new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
}

export default async function PlatformBillingPage() {
  const [overview, options, mapping] = await Promise.all([
    getPlatformBillingOverview(),
    getProvisioningOptions(),
    getTenantMapping(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Subscription billing"
        description="Commercial subscriptions only. Tenant mobile money volume and business balances are intentionally excluded."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs uppercase tracking-wide text-slate-500">Monthly recurring revenue</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{money(overview.mrr)}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs uppercase tracking-wide text-slate-500">Annual contracted</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{money(overview.annualContracted)}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs uppercase tracking-wide text-slate-500">Collected subscription cash</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{money(overview.collectedCash)}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs uppercase tracking-wide text-slate-500">Founding slots</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">
            {overview.founding.used} / {overview.founding.capacity}
          </p>
          <p className="mt-1 text-xs text-slate-500">{overview.founding.remaining} remaining</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        {Object.entries(overview.counts).map(([label, value]) => (
          <span key={label} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-700">
            {label}: <strong>{value}</strong>
          </span>
        ))}
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-700">
          Zeli requests {overview.zeli.period}: <strong>{overview.zeli.requests}</strong> across {overview.zeli.tenants} business
          {overview.zeli.tenants === 1 ? "" : "es"}
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold text-slate-900">Upcoming renewals (30 days)</h2>
          {overview.upcoming.length === 0 ? (
            <p className="mt-3 text-sm text-slate-600">No renewals in the next 30 days.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100 text-sm">
              {overview.upcoming.map((row) => (
                <li key={`${row.code}-${row.periodEnd}`} className="flex items-center justify-between gap-3 py-2">
                  <span>
                    <span className="font-medium text-slate-900">{row.tenant}</span>
                    <span className="ml-2 text-xs text-slate-500">{row.plan}</span>
                  </span>
                  <span className="text-slate-700">
                    {money(row.amount)} · {day(row.periodEnd)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold text-slate-900">Grace and suspension</h2>
          {overview.grace.length === 0 && overview.suspended.length === 0 ? (
            <p className="mt-3 text-sm text-slate-600">No business is in grace or suspended.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100 text-sm">
              {overview.grace.map((row) => (
                <li key={`g-${row.code}`} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-slate-900">{row.tenant}</span>
                  <span className="text-amber-700">Grace ends {day(row.graceEndsAt)}</span>
                </li>
              ))}
              {overview.suspended.map((row) => (
                <li key={`s-${row.code}`} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-slate-900">{row.tenant}</span>
                  <span className="text-red-700">Suspended {day(row.suspendedSince)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold text-slate-900">Founding customers</h2>
        {overview.founding.rows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No founding slots have been assigned.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4">Slot</th>
                  <th className="py-2 pr-4">Business</th>
                  <th className="py-2 pr-4">Plan</th>
                  <th className="py-2 pr-4">Periods</th>
                  <th className="py-2 pr-4">Price</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {overview.founding.rows.map((row) => (
                  <tr key={row.slot}>
                    <td className="py-2 pr-4 text-slate-700">{row.slot}</td>
                    <td className="py-2 pr-4 text-slate-900">
                      {row.tenant} <span className="text-xs text-slate-500">{row.code}</span>
                    </td>
                    <td className="py-2 pr-4 text-slate-700">{row.plan}</td>
                    <td className="py-2 pr-4 text-slate-700">
                      {row.periodsUsed} / {row.periodsGranted}
                    </td>
                    <td className="py-2 pr-4 text-slate-700">
                      {money(row.monthlyPrice)} → {money(row.standardPrice)}
                    </td>
                    <td className="py-2 text-slate-700">{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AssignPackageForm
        tenants={mapping.map((row) => ({ tenantId: row.tenantId, code: row.code, name: row.name }))}
        plans={options.plans}
      />

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold text-slate-900">Existing business mapping (read-only)</h2>
        <p className="mt-1 text-sm text-slate-600">
          Package fit is derived from current locations and staff. Nothing is charged or suspended by this view.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-4">Business</th>
                <th className="py-2 pr-4">Locations</th>
                <th className="py-2 pr-4">Staff</th>
                <th className="py-2 pr-4">Modules</th>
                <th className="py-2 pr-4">Recommended</th>
                <th className="py-2 pr-4">Subscription</th>
                <th className="py-2">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {mapping.map((row) => (
                <tr key={row.tenantId}>
                  <td className="py-2 pr-4 text-slate-900">
                    {row.name} <span className="text-xs text-slate-500">{row.code}</span>
                  </td>
                  <td className="py-2 pr-4 text-slate-700">{row.locations}</td>
                  <td className="py-2 pr-4 text-slate-700">{row.staff}</td>
                  <td className="py-2 pr-4 text-slate-700">{row.modules.join(" + ") || "—"}</td>
                  <td className="py-2 pr-4 text-slate-700">{row.recommendedPlan}</td>
                  <td className="py-2 pr-4 text-slate-700">{row.subscriptionStatus}</td>
                  <td className="py-2 text-xs text-slate-600">{row.differences.join("; ") || "No entitlement gap"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold text-slate-900">Recent subscription payments</h2>
        {overview.payments.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No subscription payments yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {overview.payments.map((row) => (
              <li key={row.reference} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium text-slate-900">{row.tenant}</span>
                  <span className="ml-2 text-xs text-slate-500">
                    {row.plan} · {row.status}
                  </span>
                </span>
                <span className="text-slate-700">
                  {money(row.amount)} · {formatDateTime(row.paidAt ?? "")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
