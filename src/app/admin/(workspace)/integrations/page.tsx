import { requireTenantAdmin } from "@/lib/tenant";
import {
  getIntegrationReadiness,
  type IntegrationReadinessStatus,
} from "@/lib/integrations/readiness";
import Notice from "@/components/ui/Notice";

export const dynamic = "force-dynamic";

const STATUS_META: Record<
  IntegrationReadinessStatus,
  { label: string; className: string; meaning: string }
> = {
  available: {
    label: "Available",
    className: "border-emerald-200 bg-emerald-50 text-emerald-900",
    meaning: "MaaCash can perform this capability now.",
  },
  sandbox: {
    label: "Sandbox",
    className: "border-amber-200 bg-amber-50 text-amber-900",
    meaning: "It works only against a test provider or allowlisted recipients; it is not live for every customer.",
  },
  not_configured: {
    label: "Not configured",
    className: "border-slate-200 bg-slate-50 text-slate-700",
    meaning: "The capability exists in the product, but this deployment has no usable provider configuration.",
  },
  unavailable: {
    label: "Unavailable",
    className: "border-slate-200 bg-slate-50 text-slate-700",
    meaning: "No approved provider contract or adapter exists. MaaCash does not contact the provider.",
  },
  coming_soon: {
    label: "Coming soon",
    className: "border-sky-200 bg-sky-50 text-sky-900",
    meaning: "Planned, but not available for use yet.",
  },
  manual_process: {
    label: "Manual process",
    className: "border-brand-200 bg-brand-50 text-brand-900",
    meaning: "Staff complete this outside MaaCash using an export or a physical document; no system-to-system sync occurs.",
  },
  requires_owner_setup: {
    label: "Requires owner setup",
    className: "border-violet-200 bg-violet-50 text-violet-900",
    meaning: "The owner must supply credentials or approve the provider before it can be enabled.",
  },
};

/**
 * Read-only capability map. This page deliberately has no connect, test-send or
 * credential controls: those require an approved provider contract and must
 * not be simulated. Every capability has exactly one status.
 */
export default async function AdminIntegrationsPage() {
  await requireTenantAdmin();
  const integrations = getIntegrationReadiness();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Integrations &amp; Provider Capabilities
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          What MaaCash can and cannot confirm with a third-party provider. This page
          is a capability map, not a connection screen: nothing here contacts a telco,
          SMS or payment provider.
        </p>
      </div>

      {/* Static capability-map notice: it is already on the page, so it must
          not also interrupt as a floating toast that covers the legend. */}
      <Notice type="info" popup={false}>
        No message is sent and no provider balance or transaction is confirmed by
        these adapters. Provider-confirmed MoMo transactions, bank feeds, accounting
        sync and external identity checks are not available. Where the work happens
        today, the status says so.
      </Notice>

      <section aria-labelledby="capability-status-heading" className="card p-4">
        <h2 id="capability-status-heading" className="text-sm font-bold text-slate-900">
          How to read the statuses
        </h2>
        <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(STATUS_META).map(([key, meta]) => (
            <div key={key} className="flex items-start gap-2">
              <dt
                className={`mt-0.5 flex-none rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.className}`}
              >
                {meta.label}
              </dt>
              <dd className="text-xs leading-snug text-slate-600">{meta.meaning}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        {integrations.map((integration) => {
          const meta = STATUS_META[integration.status];
          return (
            <article key={integration.id} className="card flex flex-col p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-bold text-slate-900">{integration.label}</h2>
                  <p className="mt-0.5 text-xs text-slate-500">{integration.capability}</p>
                </div>
                <span
                  className={`flex-none rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.className}`}
                >
                  {meta.label}
                </span>
              </div>

              <p className="mt-3 text-sm text-slate-700">{integration.detail}</p>

              <p className="mt-3 text-[11px] font-semibold uppercase text-slate-500">
                {integration.delivers
                  ? "Delivers outside MaaCash"
                  : "Does not deliver outside MaaCash"}
              </p>

              {integration.requiredApprovals.length > 0 && (
                <details className="mt-3 text-xs text-slate-600">
                  <summary className="cursor-pointer font-semibold">
                    Approvals required before enabling
                  </summary>
                  <ul className="mt-2 list-disc space-y-1 pl-4">
                    {integration.requiredApprovals.map((approval) => (
                      <li key={approval}>{approval}</li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          );
        })}
      </section>

      <section className="card p-4 text-xs text-slate-600">
        <h2 className="text-sm font-bold text-slate-900">What stays operator-recorded</h2>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>
            MoMo transactions remain operator-recorded. Provider-confirmed and
            statement-imported states cannot be produced by these adapters.
          </li>
          <li>
            Receipt and statement messages can be previewed and copied, but no SMS or
            WhatsApp message is transmitted by MaaCash.
          </li>
          <li>
            Customer contributions and withdrawals are recorded by staff; no external
            payment status is treated as proof of money movement.
          </li>
        </ul>
      </section>
    </div>
  );
}
