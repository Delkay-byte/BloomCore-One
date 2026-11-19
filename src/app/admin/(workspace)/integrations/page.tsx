import { requireTenantAdmin } from "@/lib/tenant";
import { getIntegrationReadiness } from "@/lib/integrations/readiness";
import Notice from "@/components/ui/Notice";

export const dynamic = "force-dynamic";

const STATUS_CLASSES: Record<string, string> = {
  sandbox: "border-amber-200 bg-amber-50 text-amber-900",
  unavailable: "border-slate-200 bg-slate-50 text-slate-700",
};

/**
 * Read-only integration readiness. This page deliberately has no connect,
 * test-send or credential controls: those require an approved provider
 * contract and must not be simulated.
 */
export default async function AdminIntegrationsPage() {
  await requireTenantAdmin();
  const integrations = getIntegrationReadiness();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Integration readiness</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          What MaaCash can and cannot confirm with a third-party provider. Nothing on
          this page connects to a telco, SMS or payment service.
        </p>
      </div>

      <Notice type="info">
        No message is sent and no provider balance or transaction is confirmed. These
        adapters are placeholders until an approved contract, credentials and
        reconciliation process exist.
      </Notice>

      <section className="grid gap-3 lg:grid-cols-3">
        {integrations.map((integration) => (
          <article key={integration.id} className="card flex flex-col p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold text-slate-900">{integration.label}</h2>
                <p className="mt-0.5 text-xs text-slate-500">{integration.capability}</p>
              </div>
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase ${
                  STATUS_CLASSES[integration.status] ?? STATUS_CLASSES.unavailable
                }`}
              >
                {integration.status}
              </span>
            </div>

            <p className="mt-3 text-sm text-slate-700">{integration.detail}</p>

            <p className="mt-3 text-[11px] font-semibold uppercase text-slate-500">
              {integration.delivers ? "Delivers outside MaaCash" : "Does not deliver"}
            </p>

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
          </article>
        ))}
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
            WhatsApp message is transmitted or stored.
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
