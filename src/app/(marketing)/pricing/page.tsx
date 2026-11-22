import Link from "next/link";
import { ArrowRight, CheckCircle2, MapPin, ShieldCheck, Users } from "lucide-react";
import {
  PageHero,
  Panel,
  Section,
  SectionHeading,
} from "@/components/marketing/Sections";
import PricingEnquiryForm from "@/components/marketing/PricingEnquiryForm";
import { db } from "@/lib/db";
import { pageMetadata } from "@/lib/metadata";
import { ADMIN_LOGIN_PATH } from "@/lib/site";
import {
  annualSavingPercent,
  formatGhs,
  groupPlansForDisplay,
  type PublicPlan,
} from "@/lib/pricing/catalogue";
import { AI_INVESTIGATION_PRICE } from "@/lib/pricing/catalogue";

export const dynamic = "force-dynamic";

export const metadata = pageMetadata({
  path: "/pricing",
  title: "Pricing",
  description:
    "MaaCash pricing for mobile money and Susu businesses: know what is happening in your business, account for every cedi and decide with evidence. Every paid package includes Zeli AI.",
});

async function loadPlans(): Promise<PublicPlan[]> {
  try {
    const rows = await db.zeliPlan.findMany({
      // The add-on is presented separately, never as a business package.
      where: { status: "active", isPublic: true, addonKey: null },
      orderBy: [{ sortOrder: "asc" }, { price: "asc" }],
      // Public pricing deliberately never reads or returns the internal promotional price.
      select: {
        code: true,
        name: true,
        description: true,
        billingInterval: true,
        price: true,
        currency: true,
        features: true,
        usageAllowance: true,
        locationLimit: true,
        staffLimit: true,
        supportLevel: true,
      },
    });
    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      description: row.description,
      billingInterval: row.billingInterval,
      price: Number(row.price),
      currency: row.currency,
      features: row.features ? (JSON.parse(row.features) as string[]) : [],
      usageAllowance: row.usageAllowance,
      locationLimit: row.locationLimit,
      staffLimit: row.staffLimit,
      supportLevel: row.supportLevel,
    }));
  } catch {
    // A catalogue problem must never take the public page down.
    return [];
  }
}

/**
 * Which business each package is actually for.
 *
 * Plans differ by the shape of the business — one counter, several branches, or a
 * network with staff to hold accountable — not by a longer list of ticks. This is the
 * differentiation a buyer uses, so it is stated in words rather than implied by
 * feature counts.
 */
const BEST_FOR: Record<string, string> = {
  starter:
    "One counter, one or two agents. You count the drawer at close and want the day to add up.",
  business:
    "A growing agent business or a Susu operation with several staff, shifts you must reconcile and customers who ask for statements.",
  "multi-branch":
    "Several branches, float moving between them, and an owner who needs to see every location without calling each one.",
};

function planKey(code: string): string {
  return code.replace(/-annual$/, "");
}

function PlanCard({ plan, annualPrice }: { plan: PublicPlan; annualPrice?: number }) {
  const saving =
    annualPrice !== undefined ? annualSavingPercent(plan.price, annualPrice) : null;
  const annual = plan.billingInterval.toLowerCase() === "year";
  const key = planKey(plan.code);
  return (
    <Panel>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gold-600">
        {annual ? "Annual" : "Monthly"}
      </p>
      <h3 className="mt-1 text-xl font-semibold text-brand-900">{plan.name}</h3>
      {plan.description && <p className="mt-1 text-sm text-slate-600">{plan.description}</p>}

      <p className="mt-4 text-3xl font-bold text-brand-900">
        {formatGhs(plan.price)}
        <span className="ml-1 text-sm font-medium text-slate-500">
          /{annual ? "year" : "month"}
        </span>
      </p>
      {saving !== null && (
        <p className="mt-1 text-xs font-medium text-emerald-700">
          {saving}% less than twelve monthly payments ·{" "}
          {formatGhs(Math.round(plan.price / 12))}/month equivalent
        </p>
      )}
      {annual && annualPrice === undefined && (
        <p className="mt-1 text-xs text-slate-500">
          Billed once for twelve months. A renewal quotes the price current at that time.
        </p>
      )}

      {BEST_FOR[key] && (
        <p className="mt-3 rounded-lg bg-brand-50/60 px-3 py-2 text-sm text-brand-900">
          <span className="font-semibold">Best for:</span> {BEST_FOR[key]}
        </p>
      )}

      <dl className="mt-4 space-y-1 text-sm text-slate-600">
        {plan.locationLimit !== null && (
          <div className="flex items-center gap-2">
            <MapPin size={14} aria-hidden className="text-brand-700" />
            <dt className="sr-only">Locations</dt>
            <dd>
              Up to {plan.locationLimit} location{plan.locationLimit === 1 ? "" : "s"}
            </dd>
          </div>
        )}
        {plan.staffLimit !== null && (
          <div className="flex items-center gap-2">
            <Users size={14} aria-hidden className="text-brand-700" />
            <dt className="sr-only">Staff</dt>
            <dd>Up to {plan.staffLimit} staff accounts</dd>
          </div>
        )}
        {plan.supportLevel && (
          <div className="flex items-center gap-2">
            <ShieldCheck size={14} aria-hidden className="text-brand-700" />
            <dt className="sr-only">Support</dt>
            <dd>{plan.supportLevel}</dd>
          </div>
        )}
        {plan.usageAllowance != null && (
          <div className="flex items-start gap-2">
            <CheckCircle2 size={14} aria-hidden className="mt-0.5 text-brand-700" />
            <dt className="sr-only">Zeli AI</dt>
            <dd>
              <span className="font-medium text-brand-900">Zeli AI included</span>:{" "}
              {plan.usageAllowance.toLocaleString("en-GH")} assistant requests a month,
              shared by your administrators
              {annual ? " (the same monthly allowance, billed annually)" : ""}
            </dd>
          </div>
        )}
      </dl>

      {plan.features.length > 0 && (
        <ul className="mt-4 space-y-1.5 text-sm text-slate-600">
          {plan.features.map((feature) => (
            <li key={feature} className="flex items-start gap-2">
              <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
              {feature}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5">
        <a
          href="#request-account"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-800 hover:text-brand-900"
        >
          Request an account
          <ArrowRight size={14} aria-hidden />
        </a>
      </div>
    </Panel>
  );
}

/** What every paid package includes, stated once instead of repeated per card. */
const INCLUDED = [
  "Daily MoMo accountability: opening, closing and the difference explained",
  "Cash and float reconciliation with a branch liquidity board",
  "Employee shifts, handovers and corrections that keep their history",
  "Susu customers, contributions, withdrawals and remittances",
  "Customer statements, requests and disputes with evidence",
  "Reports, reconciliation exception queue and anomaly investigation",
  "Offline capture that syncs when the connection returns",
];

export default async function PricingPage() {
  const plans = await loadPlans();
  const { monthly, annual } = groupPlansForDisplay(plans);
  const annualByBase = new Map(
    annual.map((plan) => [plan.code.replace(/-annual$/, ""), plan.price])
  );

  return (
    <>
      <PageHero
        eyebrow="Pricing"
        title="The business platform for mobile money and Susu"
        lead="Know what is happening in your business, account for every cedi, protect your operations and make better decisions. Every paid package includes Zeli, your business assistant."
      />

      <Section tone="white">
        <SectionHeading
          eyebrow="What you are buying"
          title="One record of the day, not five notebooks"
          lead="MaaCash is built for the work an owner actually has to answer for: the counter, the float, the staff, the customers and the month."
        />
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Panel>
            <h3 className="text-base font-semibold text-brand-900">Included in every paid package</h3>
            <ul className="mt-3 space-y-1.5 text-sm text-slate-600">
              {INCLUDED.map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
          </Panel>
          <Panel>
            <h3 className="text-base font-semibold text-brand-900">Zeli, your business assistant</h3>
            <p className="mt-2 text-sm text-slate-600">
              Zeli answers from your own authorised records: what was short yesterday,
              which branch is carrying the most float, what the month looks like so far.
              Local answers are always available; an external assistant is included with
              the monthly request allowance of your package.
            </p>
            <p className="mt-3 text-sm text-slate-600">
              Your allowance is per business per month and shared by your administrators.
              When it is used up, Zeli keeps answering from your records locally until the
              allowance resets on the first day of the next month.
            </p>
            <p className="mt-3 text-sm text-slate-600">
              Zeli never creates, changes or approves a financial record, and it never
              closes an investigation.
            </p>
          </Panel>
        </div>
      </Section>

      <Section tone="ivory">
        <SectionHeading
          eyebrow="Monthly"
          title="Standard monthly packages"
          lead="Billed every month. Change at renewal; a period already paid for is never shortened."
        />
        {monthly.length === 0 ? (
          <Panel>
            <p className="text-sm text-slate-600">
              Packages are being finalised. Send an enquiry and we will confirm the
              current pricing for your business.
            </p>
          </Panel>
        ) : (
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {monthly.map((plan) => (
              <PlanCard key={plan.code} plan={plan} annualPrice={annualByBase.get(plan.code)} />
            ))}
          </div>
        )}
        {monthly.length > 0 && (
          <p className="mt-4 text-xs text-slate-500">
            Prices are in Ghana cedis and exclude any tax that applies to your business.
            There is no public sign-up: MaaCash provisions each workspace personally, and
            the price you are quoted is the price stored on your package.
          </p>
        )}
      </Section>

      {annual.length > 0 && (
        <Section tone="white">
          <SectionHeading
            eyebrow="Annual"
            title="Annual packages"
            lead="Pay for twelve months at once and save against the monthly price."
          />
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {annual.map((plan) => (
              <PlanCard key={plan.code} plan={plan} />
            ))}
          </div>
          <p className="mt-4 text-xs text-slate-500">
            An annual package includes the same monthly Zeli allowance as its monthly
            equivalent. If a price changes while your year is running, your paid year is
            not re-priced; the next renewal quotes the price current at that time.
          </p>
        </Section>
      )}

      <Section tone="ivory">
        <SectionHeading
          eyebrow="Optional add-on"
          title="AI Investigation"
          lead="A premium capability for businesses that need to explain what happened, not just count it."
        />
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Panel>
            <div className="flex flex-wrap items-baseline gap-2">
              <p className="text-3xl font-bold text-brand-900">
                {formatGhs(AI_INVESTIGATION_PRICE.monthly)}
                <span className="ml-1 text-sm font-medium text-slate-500">/month</span>
              </p>
              <span className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                Optional
              </span>
            </div>
            <p className="mt-3 text-sm text-slate-600">
              {AI_INVESTIGATION_PRICE.allowance} evidence-based investigations a month. An
              investigation explains a flagged day from the records MaaCash already holds:
              the measured value, the threshold it crossed, the branch, the role, the gap
              in evidence and the questions to ask next.
            </p>
            <p className="mt-3 text-sm text-slate-600">
              A person reviews every explanation and decides what it means. Accepting one
              never changes a transaction, a balance or a finding, and it never declares
              anyone guilty of fraud.
            </p>
          </Panel>
          <Panel>
            <h3 className="text-base font-semibold text-brand-900">How it is sold and switched on</h3>
            <ul className="mt-3 space-y-1.5 text-sm text-slate-600">
              <li className="flex items-start gap-2">
                <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
                Bought separately; it is not included in the standard packages.
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
                Switched on automatically once the payment provider confirms the payment —
                reference, amount and currency are checked before anything is enabled.
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
                The allowance is available immediately and resets monthly with the paid
                period.
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
                When the paid period ends the feature stops; MaaCash support can also
                switch it off immediately if a business asks.
              </li>
            </ul>
          </Panel>
        </div>
      </Section>

      <Section tone="white">
        <SectionHeading
          eyebrow="Be clear with you"
          title="What depends on someone else"
          lead="We would rather tell you now than let you find out after paying."
        />
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Panel>
            <h3 className="text-base font-semibold text-brand-900">Provider integrations</h3>
            <p className="mt-2 text-sm text-slate-600">
              Direct MTN, Telecel, AT Money, banking, accounting and identity-verification
              integrations depend on arrangements with those providers. They are not live
              today: transactions are recorded by your staff, and a provider statement you
              import is matched against them. Nothing in MaaCash claims a provider
              confirmed a transaction unless a provider integration actually did.
            </p>
            <p className="mt-2 text-sm text-slate-600">
              Message delivery works the same way: a message that cannot be delivered is
              recorded as simulated, never as delivered.
            </p>
          </Panel>
          <Panel>
            <h3 className="text-base font-semibold text-brand-900">What MaaCash is not</h3>
            <p className="mt-2 text-sm text-slate-600">
              MaaCash is not a bank, and it does not hold customer deposits or move money
              for you. You still operate on your network&apos;s own tools. MaaCash keeps the
              business record around that work: what was declared, what was counted, what
              is missing and who is responsible — so the day can be answered for.
            </p>
          </Panel>
        </div>
      </Section>

      <Section tone="ivory">
        <div id="request-account">
          <SectionHeading
            eyebrow="Get started"
            title="Request an account"
            lead="Tell us about your business. MaaCash creates and provisions every workspace personally, so this form is an enquiry, not a sign-up."
          />
          <div className="mt-6">
            <Panel>
              <PricingEnquiryForm />
            </Panel>
          </div>
        </div>
      </Section>

      <Section tone="white">
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold text-brand-900">Already have a MaaCash workspace?</p>
            <p className="text-sm text-slate-600">
              Business owners and administrators sign in with the credentials issued
              during provisioning.
            </p>
          </div>
          <Link href={ADMIN_LOGIN_PATH} className="btn btn-primary">
            Sign In as Business Owner
            <ArrowRight size={15} aria-hidden />
          </Link>
        </div>
      </Section>
    </>
  );
}
