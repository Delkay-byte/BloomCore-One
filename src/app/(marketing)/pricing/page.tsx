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
  FOUNDING_PROMOTION,
  annualSavingPercent,
  formatGhs,
  groupPlansForDisplay,
  type PublicPlan,
} from "@/lib/pricing/catalogue";

export const dynamic = "force-dynamic";

export const metadata = pageMetadata({
  path: "/pricing",
  title: "Pricing",
  description:
    "MaaCash packages: monthly and annual pricing for mobile money and Susu businesses. Request an account; there is no public sign-up.",
});

async function loadPlans(): Promise<PublicPlan[]> {
  try {
    const rows = await db.zeliPlan.findMany({
      where: { status: "active", isPublic: true },
      orderBy: [{ sortOrder: "asc" }, { price: "asc" }],
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

function PlanCard({ plan, annualPrice }: { plan: PublicPlan; annualPrice?: number }) {
  const saving =
    annualPrice !== undefined ? annualSavingPercent(plan.price, annualPrice) : null;
  const annual = plan.billingInterval.toLowerCase() === "year";
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
          About {saving}% less than twelve monthly payments
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
        title="Packages for MoMo and Susu businesses"
        lead="Choose the package that matches your locations and team. Every business is provisioned by MaaCash; there is no public sign-up."
      />

      <Section tone="white">
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
      </Section>

      {annual.length > 0 && (
        <Section tone="ivory">
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
        </Section>
      )}

      <Section tone="white">
        <div className="rounded-xl border border-gold-200 bg-gold-50/60 p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gold-700">
            Founding customers
          </p>
          <h2 className="mt-1 text-xl font-semibold text-brand-900">
            Early-business discount for the first {FOUNDING_PROMOTION.maxBusinesses}{" "}
            businesses
          </h2>
          <p className="mt-2 text-sm text-slate-700">{FOUNDING_PROMOTION.terms}</p>
          <p className="mt-2 text-sm text-slate-600">
            Founding rates apply to monthly billing only and never combine with annual
            pricing. Eligibility is confirmed when your business is provisioned, and a
            discount is not reset or extended by changing package.
          </p>
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
