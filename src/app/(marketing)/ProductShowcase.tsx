import {
  ArrowLeftRight,
  BadgeCheck,
  Banknote,
  CheckCircle2,
  ClipboardList,
  FileClock,
  Footprints,
  Landmark,
  ReceiptText,
  Send,
  ShieldCheck,
  Smartphone,
  UserRound,
  Users,
  Wallet,
} from "lucide-react";

/**
 * Accurate representations of the product surface.
 *
 * These are drawings of real screens, not screenshots: they show the labels
 * and structure the application actually uses and contain no customer names,
 * balances or invented figures. Real records sit behind the business sign-in.
 */

export function Pillars() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <a
        href="#momo"
        className="group rounded-card border border-line bg-white p-5 shadow-card transition-colors hover:border-brand-300"
      >
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
          <Smartphone size={21} aria-hidden />
        </span>
        <h3 className="mt-4 flex items-center gap-2 text-lg font-semibold text-ink-deep">
          MoMo operations
          <span className="text-sm font-medium text-brand-600 opacity-0 transition-opacity group-hover:opacity-100">
            →
          </span>
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-ink">
          Daily account closing, cash and float accountability, airtime,
          commission, expenses and the reconciliation difference.
        </p>
      </a>
      <a
        href="#susu"
        className="group rounded-card border border-line bg-white p-5 shadow-card transition-colors hover:border-brand-300"
      >
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-gold-50 text-gold-700">
          <Footprints size={21} aria-hidden />
        </span>
        <h3 className="mt-4 flex items-center gap-2 text-lg font-semibold text-ink-deep">
          Susu management
          <span className="text-sm font-medium text-brand-600 opacity-0 transition-opacity group-hover:opacity-100">
            →
          </span>
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-ink">
          Customer records, contributions, collector activity, remittances,
          withdrawals and customer account information.
        </p>
      </a>
    </div>
  );
}

export function MomoShowcase() {
  const capabilities = [
    { icon: Landmark, text: "Daily MoMo account closing" },
    { icon: Banknote, text: "Physical cash and MoMo float accountability" },
    { icon: ReceiptText, text: "Airtime sales, commission and expenses" },
    { icon: ArrowLeftRight, text: "Reconciliation differences with an explanation" },
  ];

  return (
    <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-300">
          MoMo operations
        </p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          Close the day from the figures the agent actually counted.
        </h2>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-brand-100">
          The daily account follows the real work: opening cash and float,
          additional funding, customer deposits, cash out, airtime, commission
          and itemised expenses. The agent sees the reconciliation result before
          submitting, and the administrator reviews the same record.
        </p>
        <ul className="mt-7 grid gap-3 sm:grid-cols-2">
          {capabilities.map((item) => (
            <li key={item.text} className="flex items-start gap-3 text-sm text-brand-50">
              <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-brand-800 text-gold-300">
                <item.icon size={16} aria-hidden />
              </span>
              <span className="pt-1.5">{item.text}</span>
            </li>
          ))}
        </ul>
      </div>

      <figure className="rounded-2xl border border-brand-700 bg-brand-950 p-3 shadow-overlay sm:p-4">
        <div className="overflow-hidden rounded-xl bg-white">
          <div className="flex items-center justify-between gap-3 border-b border-line bg-brand-900 px-4 py-3">
            <div>
              <p className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-gold-300">
                MoMo daily closing
              </p>
              <p className="mt-0.5 text-sm font-semibold text-white">Today&apos;s account</p>
            </div>
            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[0.625rem] font-semibold text-amber-900">
              Draft saved
            </span>
          </div>
          <div className="space-y-3 p-4">
            <MockSection title="Opening balances" rows={["Opening physical cash", "Opening MoMo float"]} />
            <MockSection title="Today's activity" rows={["Customer deposit (Cash in)", "Cash out", "Airtime sold"]} />
            <MockSection title="Commission and expenses" rows={["Commission earned", "Itemised expenses"]} />
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-xs font-semibold text-emerald-900">
                  <CheckCircle2 size={15} aria-hidden />
                  Reconciliation
                </span>
                <span className="rounded-full bg-white px-2 py-0.5 text-[0.625rem] font-medium text-emerald-800">
                  Balanced
                </span>
              </div>
              <div aria-hidden className="mt-2 h-1.5 w-2/3 rounded-full bg-emerald-200" />
            </div>
          </div>
        </div>
        <figcaption className="px-1 pt-3 text-[0.6875rem] leading-relaxed text-brand-200">
          Illustrative view of the MoMo daily account. It contains no customer
          records or figures.
        </figcaption>
      </figure>
    </div>
  );
}

export function SusuShowcase() {
  const capabilities = [
    { icon: UserRound, text: "Customer records with accounts and cycles" },
    { icon: Wallet, text: "Contributions allocated to the customer account" },
    { icon: Footprints, text: "Collector assignments and daily collection records" },
    { icon: Send, text: "Remittances and withdrawal management" },
    { icon: FileClock, text: "Customer account activity and statements" },
    { icon: ShieldCheck, text: "Role-scoped access for administrators and collectors" },
  ];

  return (
    <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
      <figure className="order-2 rounded-2xl border border-line bg-white p-3 shadow-raised sm:p-4 lg:order-1">
        <div className="overflow-hidden rounded-xl border border-line">
          <div className="flex items-center justify-between gap-3 border-b border-line bg-ivory px-4 py-3">
            <div>
              <p className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-brand-600">
                Susu collections
              </p>
              <p className="mt-0.5 text-sm font-semibold text-ink-deep">Assigned customer</p>
            </div>
            <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[0.625rem] font-semibold text-brand-700">
              Collector view
            </span>
          </div>
          <div className="space-y-3 p-4">
            <div className="rounded-xl border border-line bg-surface-muted p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-xs font-semibold text-ink-deep">
                  <ClipboardList size={15} className="text-brand-700" aria-hidden />
                  Daily collection
                </span>
                <span className="rounded-full bg-white px-2 py-0.5 text-[0.625rem] font-medium text-emerald-700">
                  Recorded
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[0.6875rem] text-ink-muted">
                <span className="rounded-lg border border-line bg-white px-2.5 py-2">Customer account</span>
                <span className="rounded-lg border border-line bg-white px-2.5 py-2">Contribution</span>
              </div>
            </div>
            <div className="rounded-xl border border-line bg-surface-muted p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-xs font-semibold text-ink-deep">
                  <Users size={15} className="text-brand-700" aria-hidden />
                  Collector activity
                </span>
                <span className="rounded-full bg-white px-2 py-0.5 text-[0.625rem] font-medium text-ink-muted">
                  Today
                </span>
              </div>
              <div aria-hidden className="mt-2 space-y-1.5">
                <div className="h-1.5 w-4/5 rounded-full bg-brand-100" />
                <div className="h-1.5 w-3/5 rounded-full bg-ivory-deep" />
                <div className="h-1.5 w-2/5 rounded-full bg-gold-100" />
              </div>
            </div>
            <div className="rounded-xl border border-line bg-white p-3">
              <p className="flex items-center gap-2 text-xs font-semibold text-ink-deep">
                <BadgeCheck size={15} className="text-gold-700" aria-hidden />
                Customer portal
              </p>
              <p className="mt-1 text-[0.6875rem] leading-relaxed text-ink-muted">
                Savings, contributions and current cycle, shown only to that customer.
              </p>
            </div>
          </div>
        </div>
        <figcaption className="px-1 pt-3 text-[0.6875rem] leading-relaxed text-ink-muted">
          Illustrative view of the Susu collection and customer surfaces. It
          contains no customer records or figures.
        </figcaption>
      </figure>

      <div className="order-1 lg:order-2">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">
          Susu management
        </p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink-deep sm:text-3xl">
          Every collection against the right customer and account.
        </h2>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-ink">
          Run Susu collection end to end. Customer records hold the account and
          cycle; collectors record contributions against an assigned customer;
          administrators see remittances, withdrawals and the account activity
          behind each balance.
        </p>
        <ul className="mt-7 grid gap-3 sm:grid-cols-2">
          {capabilities.map((item) => (
            <li key={item.text} className="flex items-start gap-3 text-sm text-ink">
              <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-ivory text-brand-700">
                <item.icon size={16} aria-hidden />
              </span>
              <span className="pt-1.5">{item.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function MockSection({ title, rows }: { title: string; rows: string[] }) {
  return (
    <div className="rounded-xl border border-line bg-surface-muted p-3">
      <p className="text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-ink-muted">
        {title}
      </p>
      <div className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <div key={row} className="flex items-center justify-between gap-3 text-[0.6875rem]">
            <span className="text-ink">{row}</span>
            <span aria-hidden className="h-2 w-12 rounded-full bg-ivory-deep" />
          </div>
        ))}
      </div>
    </div>
  );
}
