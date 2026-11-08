import {
  BarChart3,
  Building2,
  LayoutDashboard,
  MapPin,
  Receipt,
  Users,
} from "lucide-react";

/**
 * Illustrative workspace preview for the hero.
 *
 * This is a drawing of the interface vocabulary, not a screenshot: it shows the
 * module names and the shape of the workspace and contains no figures, no
 * customer records and no invented metrics. Real screens require a signed-in
 * account, which the caption states plainly.
 */
export default function WorkspacePreview() {
  const nav = [
    { icon: LayoutDashboard, label: "Dashboard" },
    { icon: MapPin, label: "Locations" },
    { icon: Users, label: "Staff" },
    { icon: Receipt, label: "Money & History" },
    { icon: Building2, label: "Susu Customers" },
    { icon: BarChart3, label: "Reports" },
  ];

  const panels = [
    { title: "Daily account", body: "Customer deposits, cash out, airtime, commission and expenses recorded per day." },
    { title: "Contributions", body: "Susu contributions with allocation to customer accounts." },
    { title: "Withdrawals", body: "Approved payouts with a full record of who recorded them." },
  ];

  return (
    <figure className="rounded-2xl border border-brand-800 bg-brand-900 p-3 shadow-overlay sm:p-4">
      <div className="overflow-hidden rounded-xl bg-white">
        <div className="flex items-center gap-2 border-b border-line bg-ivory px-4 py-2.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-brand-200" />
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-gold-300" />
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-brand-400" />
          <span className="ml-2 text-xs font-medium text-ink-muted">
            Business workspace
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[9.5rem_1fr]">
          <div className="border-b border-line bg-brand-950 p-3 sm:border-b-0 sm:border-r">
            <p className="px-1 pb-2 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-brand-300">
              Modules
            </p>
            <ul className="flex flex-wrap gap-1 sm:block sm:space-y-0.5">
              {nav.map((item) => (
                <li
                  key={item.label}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] font-medium text-brand-100"
                >
                  <item.icon size={13} className="text-gold-400" aria-hidden />
                  {item.label}
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-3 p-3 sm:p-4">
            {panels.map((panel) => (
              <div key={panel.title} className="rounded-lg border border-line bg-surface-muted p-3">
                <p className="text-xs font-semibold text-ink-deep">{panel.title}</p>
                <p className="mt-1 text-[0.6875rem] leading-relaxed text-ink-muted">
                  {panel.body}
                </p>
                <div aria-hidden className="mt-2 flex gap-1.5">
                  <span className="h-1.5 w-16 rounded-full bg-brand-200" />
                  <span className="h-1.5 w-10 rounded-full bg-ivory-deep" />
                  <span className="h-1.5 w-6 rounded-full bg-gold-200" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <figcaption className="px-1 pt-3 text-[0.6875rem] leading-relaxed text-brand-200">
        Illustrative view of a business workspace. Actual screens are behind the
        business sign-in and contain that business&apos;s own records.
      </figcaption>
    </figure>
  );
}
