import Link from "next/link";
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  ClipboardList,
  Landmark,
  MapPin,
  Receipt,
  Smartphone,
  Users,
} from "lucide-react";
import {
  CtaBand,
  PageHero,
  Panel,
  Section,
  SectionHeading,
  StepList,
} from "@/components/marketing/Sections";
import { COMPANY_NAME } from "@/lib/site";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  path: "/solutions",
  title: "Who We Serve",
  description:
    "MaaCash is built for mobile money operators, Susu operators and collection-based businesses that need controlled staff operations and trustworthy records.",
});

const SOLUTIONS = [
  {
    icon: Smartphone,
    id: "momo-operators",
    title: "Mobile money operators",
    lead: "For businesses running agent points, cash-in and cash-out services.",
    today: [
      "Daily takings reconstructed from notebooks or memory at the end of the day",
      "Commission and expenses tracked separately from the day's cash",
      "Little visibility of which agent point recorded what",
    ],
    with: [
      "A daily account per worker and location, entered as the work happens",
      "Commission, other income, expenses and reconciliation in the same record",
      "Money history filterable by date, worker and location, exportable to CSV",
    ],
  },
  {
    icon: Landmark,
    id: "susu-operators",
    title: "Susu operators and agencies",
    lead: "For Susu businesses with collectors working in the field.",
    today: [
      "Collector totals that cannot be reconciled to individual customers",
      "Late discovery of a missed or duplicated contribution",
      "Remittances agreed verbally, with no shared record",
    ],
    with: [
      "Customers, accounts and cycles with contributions allocated to the right account",
      "Each contribution attributed to the collector who recorded it",
      "Collector assignments and remittance records in the same system",
    ],
  },
  {
    icon: ClipboardList,
    id: "collection-businesses",
    title: "Collection-based financial service businesses",
    lead: "For businesses that collect from customers regularly and pay out on request.",
    today: [
      "Payout requests approved without a record of who authorised them",
      "Customer balances held in more than one place",
      "No single view of collections and payouts for a period",
    ],
    with: [
      "Withdrawals recorded with the authorising account attached",
      "Customer accounts with balances derived from recorded contributions and withdrawals",
      "Contribution, withdrawal and remittance reports for any period",
    ],
  },
  {
    icon: Building2,
    id: "multi-branch",
    title: "Multi-branch and multi-team operations",
    lead: "For businesses operating more than one location or team.",
    today: [
      "Every branch reporting in a different format",
      "Head office waiting for end-of-day summaries by phone",
      "New staff given access they should not have, or too little to work",
    ],
    with: [
      "Locations defined once, with records and staff assigned to them",
      "Dashboards that show the day across locations as it is recorded",
      "Roles with the access each job needs, changed by an administrator",
    ],
  },
];

const STEPS = [
  {
    title: "Request access",
    description: "Describe your business, its locations and the operations you want to manage.",
  },
  {
    title: "Review",
    description: `${COMPANY_NAME} reviews the request and confirms the modules that fit your business.`,
  },
  {
    title: "Enrolment",
    description: "The platform administrator creates your workspace and enables those modules.",
  },
  {
    title: "Administrator",
    description: "You receive an administrator sign-in for your own workspace.",
  },
  {
    title: "Your team",
    description: "You create staff accounts and your team starts recording work.",
  },
];

export default function SolutionsPage() {
  return (
    <>
      <PageHero
        eyebrow="Who we serve"
        title="Built for businesses whose money moves through people"
        lead="MaaCash fits businesses where someone collects, holds, records or pays out money on behalf of customers — and where that person needs to be accountable for what they recorded."
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href="/contact"
            className="inline-flex items-center justify-center gap-2 rounded-control bg-brand-700 px-5 py-3 text-sm font-semibold text-white hover:bg-brand-800"
          >
            Request a Demonstration
            <ArrowRight size={16} aria-hidden />
          </Link>
          <Link
            href="/features"
            className="inline-flex items-center justify-center rounded-control border border-line-strong px-5 py-3 text-sm font-semibold text-ink hover:border-brand-300 hover:text-brand-700"
          >
            See the capabilities
          </Link>
        </div>
      </PageHero>

      <Section tone="white">
        <div className="space-y-12">
          {SOLUTIONS.map((solution) => (
            <article
              key={solution.id}
              id={solution.id}
              className="grid gap-8 rounded-card border border-line bg-white p-6 shadow-card lg:grid-cols-[1fr_1.3fr] lg:p-8"
            >
              <div>
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                  <solution.icon size={21} aria-hidden />
                </span>
                <h2 className="mt-4 text-xl font-semibold text-ink-deep">
                  {solution.title}
                </h2>
                <p className="mt-3 text-base leading-relaxed text-ink">{solution.lead}</p>
              </div>

              <div className="grid gap-6 sm:grid-cols-2">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
                    Common today
                  </h3>
                  <ul className="mt-3 space-y-3 text-sm leading-relaxed text-ink">
                    {solution.today.map((item) => (
                      <li key={item} className="flex gap-2">
                        <span aria-hidden className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-ink-faint" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-700">
                    With MaaCash
                  </h3>
                  <ul className="mt-3 space-y-3 text-sm leading-relaxed text-ink">
                    {solution.with.map((item) => (
                      <li key={item} className="flex gap-2">
                        <CheckCircle2 size={15} className="mt-0.5 flex-none text-brand-600" aria-hidden />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </article>
          ))}
        </div>
      </Section>

      <Section tone="ivory">
        <SectionHeading
          eyebrow="Fit"
          title="What we do not claim to cover"
          lead="A platform that tries to serve everyone serves no one properly. These are outside what MaaCash does today."
        />
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <Panel title="Banking">
            <p>
              MaaCash is not a bank and does not hold deposits, offer
              credit or provide savings products of its own.
            </p>
          </Panel>
          <Panel title="Payment processing">
            <p>
              The platform does not transfer money between customers, agents or
              networks. It records the operations your business performs.
            </p>
          </Panel>
          <Panel title="Unsupported industries">
            <p>
              Retail point-of-sale, e-commerce, payroll and inventory management
              are not part of the product, so we do not advertise them.
            </p>
          </Panel>
        </div>
      </Section>

      <Section tone="white">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
          <SectionHeading
            eyebrow="Practical fit"
            title="What a business needs before it starts"
            lead="MaaCash is not a product you can sign up for alone. It is enrolled by BloomCore Technologies, so two things are needed."
          />
          <ul className="space-y-4">
            {[
              {
                icon: MapPin,
                title: "The locations you operate from",
                body: "Each branch or point is created once, and staff and records are attached to it.",
              },
              {
                icon: Users,
                title: "The people and their roles",
                body: "An administrator signs in first, then creates the workers and collectors who will record operations.",
              },
              {
                icon: Receipt,
                title: "The operations you want to record",
                body: "MoMo daily accounts, Susu collections, or both — the modules are enabled per business.",
              },
            ].map((item) => (
              <li key={item.title} className="flex gap-4 rounded-card border border-line bg-white p-5">
                <item.icon size={20} className="mt-0.5 flex-none text-brand-700" aria-hidden />
                <div>
                  <h3 className="text-sm font-semibold text-ink-deep">{item.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink">{item.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section tone="ivory">
        <SectionHeading
          eyebrow="Onboarding"
          title="From request to first working day"
        />
        <StepList steps={STEPS} />
      </Section>

      <CtaBand
        title="Tell us how your business operates"
        body="A short conversation is usually enough to say whether MaaCash fits, and which modules your business would enable."
      />
    </>
  );
}
