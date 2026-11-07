import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Building2,
  ClipboardCheck,
  FileSpreadsheet,
  Landmark,
  Layers,
  MapPin,
  ShieldCheck,
  Smartphone,
  TabletSmartphone,
  Users,
  Wallet,
} from "lucide-react";
import {
  CtaBand,
  FeatureCard,
  PageHero,
  Panel,
  Section,
  SectionHeading,
} from "@/components/marketing/Sections";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  path: "/features",
  title: "Features",
  description:
    "MoMo operations, Susu management, team access control and business reporting in one platform. Every capability listed here is in the deployed product.",
});

const CORE = [
  {
    icon: Smartphone,
    title: "MoMo operations",
    description:
      "Daily records for mobile money work: what came in, what went out, what was earned and what was spent.",
    points: [
      "Daily accounts opened per worker and location",
      "Cash in, cash out, MoMo added, MoMo paid, commission, other income, expenses and reconciliation entries",
      "Money history with filters for date range, worker and location",
      "CSV export of the filtered history",
    ],
  },
  {
    icon: Landmark,
    title: "Susu management",
    description:
      "The full Susu cycle from customer registration to collection, allocation and payout.",
    points: [
      "Customer records with accounts, cycles and balances",
      "Contributions recorded against the customer and account",
      "Contribution allocations to the customer's savings",
      "Withdrawals with approval and attribution",
      "Collector assignments and remittance records",
    ],
  },
  {
    icon: Users,
    title: "Staff and role access",
    description:
      "Every person signs in as themselves, for the part of the business they are responsible for.",
    points: [
      "Distinct administrator, worker and collector sign-in paths",
      "Staff records assigned to locations, activated and deactivated by an administrator",
      "First-login password change enforced",
      "Idle, background and absolute session time limits",
    ],
  },
  {
    icon: BarChart3,
    title: "Reporting and history",
    description:
      "Answer the questions that come up after the fact without digging through paper.",
    points: [
      "MoMo and Susu dashboards",
      "Reports for contributions, withdrawals and remittances",
      "Money history across both modules",
      "Activity history of security and administrative events",
    ],
  },
];

const OPERATIONS = [
  {
    icon: MapPin,
    title: "Locations",
    description:
      "Create the branches or points your business operates from, and see records per location.",
  },
  {
    icon: Wallet,
    title: "Daily close",
    description:
      "End the day with the day's entries accounted for and the reconciliation recorded in the same place.",
  },
  {
    icon: ClipboardCheck,
    title: "Corrections with a record",
    description:
      "Adjustments are entered as their own records, so the original entry stays visible.",
  },
  {
    icon: FileSpreadsheet,
    title: "Exports for your own files",
    description:
      "Download the filtered history, contributions or reports as CSV for your accountant or your records.",
  },
];

export default function FeaturesPage() {
  return (
    <>
      <PageHero
        eyebrow="Platform capabilities"
        title="What MaaCash actually does"
        lead="Four module groups, one set of business records. Everything described on this page exists in the current product — nothing here is planned or aspirational."
      >
        <Link
          href="/contact"
          className="inline-flex items-center gap-2 rounded-control bg-brand-700 px-5 py-3 text-sm font-semibold text-white hover:bg-brand-800"
        >
          Request a Demonstration
          <ArrowRight size={16} aria-hidden />
        </Link>
      </PageHero>

      <Section tone="white">
        <div className="grid gap-6 sm:grid-cols-2">
          {CORE.map((feature) => (
            <FeatureCard
              key={feature.title}
              icon={feature.icon}
              title={feature.title}
              description={feature.description}
              points={feature.points}
              headingLevel={2}
            />
          ))}
        </div>
      </Section>

      <Section tone="ivory">
        <SectionHeading
          eyebrow="Operational detail"
          title="The day-to-day controls"
          lead="The small capabilities that make the larger ones usable in a real business day."
        />
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {OPERATIONS.map((item) => (
            <div key={item.title} className="rounded-card border border-line bg-white p-5">
              <item.icon size={19} className="text-brand-700" aria-hidden />
              <h3 className="mt-3 text-sm font-semibold text-ink-deep">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink">{item.description}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section tone="white">
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="Separation by design"
              title="One platform, a workspace per business"
            />
            <div className="mt-6 space-y-4 text-base leading-relaxed text-ink">
              <p>
                Businesses share the platform, never each other&apos;s records.
                Each business has its own users, locations, customers and
                operational history, and only the modules it has enabled.
              </p>
              <p>
                Access decisions are made on the server from the signed-in
                user&apos;s session and their business record on every request.
              </p>
            </div>
          </div>
          <div className="space-y-4">
            <Panel title="Platform administration">
              <p>
                The platform itself is operated from a separate administration
                sign-in, with its own session. It manages businesses and their
                enrolment — it is not a business administrator account.
              </p>
            </Panel>
            <Panel title="Business administration">
              <p>
                Each business has an administrator who creates staff accounts,
                assigns locations and works inside that business&apos;s
                workspace.
              </p>
            </Panel>
            <Panel title="Field roles">
              <p>
                Workers record MoMo activity and collectors record Susu
                collections. Device enrolment controls which devices a field
                role can capture offline records from.
              </p>
            </Panel>
          </div>
        </div>
      </Section>

      <Section tone="ivory">
        <SectionHeading
          eyebrow="Field realities"
          title="When the network is not cooperating"
          lead="Collection work happens where coverage is uneven. MaaCash supports capturing records on an enrolled device and sending them when the connection returns."
        />
        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          <FeatureCard
            icon={TabletSmartphone}
            title="Enrolled devices"
            description="A device is enrolled to a staff account before it can capture records, so offline entries stay attributed."
          />
          <FeatureCard
            icon={ShieldCheck}
            title="Duplicate protection"
            description="Each captured record carries its own reference, so a repeated sync does not create a second transaction."
          />
          <FeatureCard
            icon={Layers}
            title="Order preserved"
            description="Sync follows the order the records were captured, and the outcome of each is recorded."
          />
        </div>
        <p className="mt-6 max-w-3xl text-sm leading-relaxed text-ink-muted">
          Offline capture is a feature each business enables deliberately.
          Businesses that work online only can leave it off.
        </p>
      </Section>

      <Section tone="white">
        <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr] lg:items-center">
          <SectionHeading
            eyebrow="Records"
            title="Financial records stay readable"
            lead="Amounts are shown in the currency the business works in, with tabular figures so columns line up, and every entry keeps the date, the person and the location attached."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Panel title="Currency">
              <p>Ghana cedi formatting throughout the interface and exports.</p>
            </Panel>
            <Panel title="Attribution">
              <p>Entries carry who recorded them and where the work was done.</p>
            </Panel>
            <Panel title="History">
              <p>Money history spans MoMo and Susu with the same filters.</p>
            </Panel>
            <Panel title="Activity trail">
              <p>Security and administrative events are written to a history.</p>
            </Panel>
          </div>
        </div>
      </Section>

      <Section tone="ivory">
        <SectionHeading
          eyebrow="What MaaCash is not"
          title="Honest boundaries"
        />
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            "It is not a bank and does not hold customer deposits.",
            "It is not a mobile money network or a payment processor.",
            "It does not move money between accounts or networks.",
            "It is a records and operations platform for the business using it.",
            "It does not certify or guarantee the accuracy of the records entered into it.",
            "It does not replace your own accounting, tax or regulatory obligations.",
          ].map((item) => (
            <li
              key={item}
              className="rounded-card border border-line bg-white p-4 text-sm leading-relaxed text-ink"
            >
              {item}
            </li>
          ))}
        </ul>
        <p className="mt-6 flex items-start gap-2 text-sm leading-relaxed text-ink-muted">
          <Building2 size={16} className="mt-0.5 flex-none" aria-hidden />
          <span>
            MaaCash records what a business enters. Decisions about money
            remain with the business and the people accountable for it.
          </span>
        </p>
      </Section>

      <CtaBand />
    </>
  );
}
