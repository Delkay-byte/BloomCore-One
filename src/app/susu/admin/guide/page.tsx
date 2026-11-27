import Link from "next/link";
import { requireTenantAdminSusu } from "@/lib/tenant";
import { getSusuSetupGuide } from "@/lib/actions/susu-guide.actions";

export const metadata = { title: "Operational guide — MaaCash Susu" };
export const dynamic = "force-dynamic";

const ROLE_NOTES: { title: string; body: string }[] = [
  {
    title: "Daily",
    body: "Collectors record collections as they happen. The office records the cash handed in, then runs the daily close so the day's totals are agreed. A difference is not resolved by editing a record: it is reviewed and corrected through the approval queue.",
  },
  {
    title: "Weekly",
    body: "Review outstanding hand-ins, open reconciliation exceptions and withdrawal requests. Export the week's report if your board or accountant needs it; exports are recorded in the activity history.",
  },
  {
    title: "Monthly",
    body: "Reconcile the month, review the customer and collector totals, and check that staff who left no longer have access. Offboarding revokes sessions and branch membership immediately; historical records keep the person's name for attribution.",
  },
];

export default async function SusuGuidePage() {
  await requireTenantAdminSusu();
  const guide = await getSusuSetupGuide();

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-brand-900">Operational guide</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-muted">
          A practical setup checklist for this business, computed from its current records
          ({guide.scopeLabel.toLowerCase()}). Items marked to do are not configured yet; nothing here
          substitutes for training or for your own operating policy.
        </p>
        <p className="mt-2 text-sm font-medium text-brand-800">
          {guide.completed} of {guide.total} steps complete
        </p>
      </header>

      <ol className="space-y-3">
        {guide.items.map((item, index) => (
          <li key={item.key} className="card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex gap-3">
                <span
                  className={
                    item.status === "done"
                      ? "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-semibold text-emerald-800"
                      : "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xs font-semibold text-amber-800"
                  }
                  aria-hidden
                >
                  {item.status === "done" ? "✓" : index + 1}
                </span>
                <div>
                  <h2 className="text-base font-semibold text-brand-900">{item.title}</h2>
                  <p className="mt-0.5 text-sm text-ink">{item.detail}</p>
                  <p className="mt-1 text-xs text-ink-muted">{item.why}</p>
                  <p className="mt-1 text-xs text-ink-muted">
                    {item.owner === "platform"
                      ? "Platform support acts on this."
                      : item.owner === "everyone"
                        ? "Any staff member can act on this."
                        : "An administrator acts on this."}
                  </p>
                </div>
              </div>
              <Link href={item.href} className="btn btn-secondary btn-sm shrink-0">
                {item.status === "done" ? "Review" : "Open"}
              </Link>
            </div>
          </li>
        ))}
      </ol>

      <div className="space-y-3">
        <h2 className="text-base font-semibold text-brand-900">Operating rhythm</h2>
        {ROLE_NOTES.map((note) => (
          <article key={note.title} className="card">
            <h3 className="text-sm font-semibold text-brand-900">{note.title}</h3>
            <p className="mt-1 text-sm text-ink-muted">{note.body}</p>
          </article>
        ))}
      </div>

      <div className="card space-y-2 text-sm text-ink-muted">
        <h2 className="text-base font-semibold text-brand-900">What support can and cannot do</h2>
        <p>
          Support can explain a figure, investigate an unexpected result, help with access and correct
          a workflow that failed. Support cannot take your password, approve a payout on your behalf,
          change a customer&apos;s balance directly, or ask you to move money outside the platform.
        </p>
        <p>
          Anything support changes is recorded in the platform activity history against the request
          reference. Internal notes on a request are never shown to the business.
        </p>
        <p>
          If someone contacts you claiming to be support and asks for a password or a one-time code,
          stop and report it through{" "}
          <Link href="/susu/support" className="font-medium text-brand-700 hover:underline">
            Support
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
