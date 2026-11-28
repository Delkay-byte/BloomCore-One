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
    meaning: "Configured and working now.",
  },
  sandbox: {
    label: "Sandbox",
    className: "border-amber-200 bg-amber-50 text-amber-900",
    meaning: "Works against a test provider or allowlisted recipients only; not live for every customer.",
  },
  not_configured: {
    label: "Not configured",
    className: "border-slate-200 bg-slate-50 text-slate-700",
    meaning: "The capability exists in MaaCash, but this deployment has no provider configuration.",
  },
  unavailable: {
    label: "Unavailable",
    className: "border-slate-200 bg-slate-50 text-slate-700",
    meaning: "No approved provider contract or adapter exists; MaaCash does not contact the provider.",
  },
  coming_soon: {
    label: "Coming soon",
    className: "border-sky-200 bg-sky-50 text-sky-900",
    meaning: "Planned; not available for use yet.",
  },
  manual_process: {
    label: "Manual process",
    className: "border-brand-200 bg-brand-50 text-brand-900",
    meaning: "Staff complete this outside MaaCash via an export or document; no system-to-system sync.",
  },
  requires_owner_setup: {
    label: "Requires owner setup",
    className: "border-violet-200 bg-violet-50 text-violet-900",
    meaning: "The owner supplies credentials or approves the provider before it can be enabled.",
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
  const deliverless = integrations.filter((row) => !row.delivers);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Integrations &amp; Provider Capabilities
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600">
          What MaaCash can and cannot currently confirm through external providers.
          This page is a capability map, not a connection screen: nothing here
          contacts a telco, SMS or payment provider.
        </p>
      </div>

      {/* Static capability-map notice: it is already on the page, so it must
          not also interrupt as a floating toast that covers the legend. */}
      <Notice type="info" popup={false}>
        No message is sent and no provider balance or transaction is confirmed by
        these adapters. Where the work happens today, the status on each card says so.
      </Notice>

      <section aria-labelledby="capability-status-heading" className="card p-5">
        <h2 id="capability-status-heading" className="text-base font-bold text-slate-900">
          How to read the statuses
        </h2>
        <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {Object.entries(STATUS_META).map(([key, meta]) => (
            <div key={key} className="flex items-start gap-3">
              <dt
                className={`mt-0.5 flex-none rounded-full border px-2.5 py-1 text-[11px] font-semibold ${meta.className}`}
              >
                {meta.label}
              </dt>
              <dd className="text-xs leading-snug text-slate-600">{meta.meaning}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="capability-cards-heading">
        <h2 id="capability-cards-heading" className="sr-only">
          Provider capabilities
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
          {integrations.map((integration) => {
            const meta = STATUS_META[integration.status];
            return (
              <article key={integration.id} className="card flex flex-col p-5">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-bold text-slate-900">{integration.label}</h3>
                  <span
                    className={`flex-none rounded-full border px-2.5 py-1 text-[11px] font-semibold ${meta.className}`}
                  >
                    {meta.label}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">{integration.capability}</p>
                <p className="mt-3 text-sm leading-relaxed text-slate-700">
                  {integration.detail}
                </p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="card p-5 text-sm text-slate-600">
        <h2 className="text-base font-bold text-slate-900">What stays operator-recorded</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5">
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
        {deliverless.length > 0 && (
          <p className="mt-3 text-xs text-slate-500">
            None of the {deliverless.length} capabilities shown above delivers anything
            outside MaaCash: no message is sent, no account is contacted and no
            provider confirms a transaction.
          </p>
        )}
      </section>

      {integrations.some((row) => row.requiredApprovals.length > 0) && (
        <details className="card p-5 text-sm text-slate-600">
          <summary className="cursor-pointer text-base font-bold text-slate-900">
            What each capability needs before it can be enabled
          </summary>
          <div className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            {integrations
              .filter((row) => row.requiredApprovals.length > 0)
              .map((row) => (
                <div key={row.id}>
                  <p className="text-xs font-semibold text-slate-900">{row.label}</p>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
                    {row.requiredApprovals.map((approval) => (
                      <li key={approval}>{approval}</li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        </details>
      )}
    </div>
  );
}
