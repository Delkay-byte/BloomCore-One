import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Building2,
  ClipboardList,
  FileClock,
  Landmark,
  Layers,
  ShieldCheck,
  Smartphone,
  Users,
} from "lucide-react";
import {
  CtaBand,
  Eyebrow,
  FeatureCard,
  Section,
  SectionHeading,
  StepList,
  Container,
} from "@/components/marketing/Sections";
import {
  COMPANY_NAME,
  PRODUCT_DESCRIPTOR,
  PRODUCT_NAME,
  PRODUCT_POSITIONING,
  PRODUCT_TAGLINE,
} from "@/lib/site";
import { pageMetadata } from "@/lib/metadata";
import WorkspacePreview from "./WorkspacePreview";

// The tagline comes from one place. It is split on the sentence break so the
// hero can set the second line as its own line.
const [TAGLINE_FIRST, TAGLINE_SECOND = ""] = PRODUCT_TAGLINE.split(". ");

export const metadata = pageMetadata({
  path: "/",
  title: `${PRODUCT_NAME} — ${PRODUCT_DESCRIPTOR}`,
  description: PRODUCT_POSITIONING,
  absolute: true,
});

const MODULES = [
  {
    icon: Smartphone,
    title: "MoMo Operations",
    description:
      "Record the mobile money work your team does every day, in one place, with the person and the location attached to every entry.",
    points: [
      "Daily accounts with cash in, cash out, commission, other income and expenses",
      "Reconciliation entries and correction records",
      "Per-worker and per-location views of what was recorded",
    ],
  },
  {
    icon: Landmark,
    title: "Susu Management",
    description:
      "Run Susu collection end to end: customer accounts, collection cycles, contributions, withdrawals and collector remittances.",
    points: [
      "Customer records with accounts, cycles and balances",
      "Contributions with allocation to the customer's account",
      "Withdrawals, collector assignments and remittance records",
    ],
  },
  {
    icon: Users,
    title: "Team Management",
    description:
      "Give each person the access their job needs — and only that — so responsibilities are clear and every action has an owner.",
    points: [
      "Separate administrator, worker and collector sign-in",
      "Staff assigned to locations, with module access per business",
      "First-login password change and session time limits",
    ],
  },
  {
    icon: BarChart3,
    title: "Business Insights",
    description:
      "See the operations behind the numbers: activity history, reports and a record of who did what and when.",
    points: [
      "Dashboards for MoMo and Susu activity",
      "Money history and reports with date filters",
      "CSV export for your own records and audit trail entries",
    ],
  },
];

const AUDIENCES = [
  {
    icon: Smartphone,
    title: "Mobile money operators",
    description:
      "Businesses that run agent points or cash-in/cash-out operations and need a daily account they can trust at the end of the day.",
  },
  {
    icon: Landmark,
    title: "Susu operators and agencies",
    description:
      "Susu businesses with collectors in the field who need contributions recorded against the right customer and account.",
  },
  {
    icon: ClipboardList,
    title: "Collection-based businesses",
    description:
      "Businesses that collect money from customers regularly and need a record of every collection and payout.",
  },
  {
    icon: Building2,
    title: "Multi-branch operations",
    description:
      "Businesses with more than one location or team that need one system and clear visibility across all of them.",
  },
];

const STEPS = [
  {
    title: "Request access",
    description: "Tell us about your business and the operations you want to manage.",
  },
  {
    title: "Review",
    description: `${COMPANY_NAME} reviews the request and confirms the modules your business needs.`,
  },
  {
    title: "Enrolment",
    description: "The platform administrator creates your business workspace.",
  },
  {
    title: "Administrator",
    description: "You receive your own administrator sign-in for that workspace.",
  },
  {
    title: "Go live",
    description: "Your team signs in and works in the modules enabled for your business.",
  },
];

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="focus-on-dark bg-brand-900">
        <Container className="grid items-center gap-12 py-14 sm:py-20 lg:grid-cols-2 lg:gap-16">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-brand-700 bg-brand-800 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-gold-300">
              <Layers size={13} aria-hidden />
              {PRODUCT_DESCRIPTOR}
            </p>
            <h1 className="mt-6 text-4xl font-semibold tracking-tight text-white sm:text-5xl lg:text-6xl">
              {TAGLINE_FIRST}.
              <span className="block text-gold-400">{TAGLINE_SECOND}</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-brand-100">
              Manage your business operations, collections, people and financial
              records through one connected business platform.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/contact"
                className="inline-flex items-center justify-center gap-2 rounded-control bg-gold-500 px-5 py-3 text-sm font-semibold text-brand-950 transition-colors hover:bg-gold-400"
              >
                Request a Demonstration
                <ArrowRight size={16} aria-hidden />
              </Link>
              <Link
                href="/workspace"
                className="inline-flex items-center justify-center rounded-control border border-brand-500 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-800"
              >
                Sign In
              </Link>
            </div>
            <p className="mt-5 text-sm text-brand-300">
              Workspaces are created for verified businesses. There is no open
              public sign-up.
            </p>
          </div>

          <WorkspacePreview />
        </Container>
      </section>

      {/* Platform overview */}
      <Section tone="white">
        <div className="grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
          <SectionHeading
            eyebrow="The platform"
            title="Built around the way the work actually happens"
            lead={PRODUCT_POSITIONING}
          />
          <div className="space-y-5 text-base leading-relaxed text-ink">
            <p>
              Operational work rarely fails because someone was careless. It
              fails because the record of it lives in a notebook, in a chat
              message, or in one person&apos;s memory. MaaCash puts the
              record where the work happens: the daily account, the collection,
              the payout, the person who recorded it.
            </p>
            <p>
              Each function has its own screen, but they share one set of
              business records. A contribution is recorded against a real
              customer account. A withdrawal is attributed to whoever authorised
              it. A report reflects what was actually entered, not a summary
              typed up later.
            </p>
            <p>
              Businesses use MaaCash to see how the day went while it is
              still happening, and to answer questions weeks later without
              searching through paper.
            </p>
          </div>
        </div>
      </Section>

      {/* Product modules */}
      <Section tone="ivory">
        <SectionHeading
          eyebrow="Modules"
          title="The parts of the platform your business turns on"
          lead="Modules are enabled per business. A business that only runs Susu collections does not see MoMo screens, and the reverse is also true."
        />
        <div className="mt-10 grid gap-6 sm:grid-cols-2">
          {MODULES.map((module) => (
            <FeatureCard
              key={module.title}
              icon={module.icon}
              title={module.title}
              description={module.description}
              points={module.points}
            />
          ))}
        </div>
        <div className="mt-8">
          <Link
            href="/features"
            className="inline-flex items-center gap-2 text-sm font-semibold text-brand-700 hover:text-brand-800"
          >
            See the full capability list
            <ArrowRight size={15} aria-hidden />
          </Link>
        </div>
      </Section>

      {/* Who we serve */}
      <Section tone="white">
        <SectionHeading
          eyebrow="Who we serve"
          title="Businesses whose money moves through people"
          lead="MaaCash is built for businesses that collect, hold and pay out money on behalf of customers — where each transaction has to be traceable to a person and a location."
        />
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {AUDIENCES.map((audience) => (
            <div
              key={audience.title}
              className="rounded-card border border-line bg-white p-5 shadow-card"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-ivory text-brand-700">
                <audience.icon size={19} aria-hidden />
              </span>
              <h3 className="mt-4 text-base font-semibold text-ink-deep">
                {audience.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-ink">
                {audience.description}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-8">
          <Link
            href="/solutions"
            className="inline-flex items-center gap-2 text-sm font-semibold text-brand-700 hover:text-brand-800"
          >
            How it fits each business type
            <ArrowRight size={15} aria-hidden />
          </Link>
        </div>
      </Section>

      {/* Multi-tenant architecture */}
      <Section tone="ivory">
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
          <div>
            <SectionHeading
              eyebrow="One platform, separate workspaces"
              title="Every business works inside its own workspace"
            />
            <div className="mt-6 space-y-5 text-base leading-relaxed text-ink">
              <p>
                MaaCash is a multi-business platform. Each business that
                joins gets its own workspace with its own users, locations and
                records. Nothing is shared between businesses: a user belongs to
                one business, sees that business&apos;s data, and reaches only the
                modules that business has enabled.
              </p>
              <p>
                Access is decided on the server for every request, from the
                signed-in user&apos;s own session and their business record — not
                from anything the browser can change. Platform-level
                administration is a separate sign-in with its own session, kept
                apart from every business administrator account.
              </p>
            </div>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2">
            {[
              {
                icon: Building2,
                title: "Separate business records",
                body: "Customers, accounts, contributions and daily accounts belong to one business only.",
              },
              {
                icon: Users,
                title: "Roles inside the business",
                body: "Administrators, workers and collectors see different parts of the same workspace.",
              },
              {
                icon: Layers,
                title: "Modules per business",
                body: "A business enables the modules it operates; the rest are not part of its workspace.",
              },
              {
                icon: FileClock,
                title: "Recorded activity",
                body: "Sign-ins, records and administrative actions are written to an activity history.",
              },
            ].map((item) => (
              <li key={item.title} className="rounded-card border border-line bg-white p-5">
                <item.icon size={19} className="text-brand-700" aria-hidden />
                <h3 className="mt-3 text-sm font-semibold text-ink-deep">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink">{item.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* Why MaaCash */}
      <Section tone="white">
        <SectionHeading
          eyebrow="Why MaaCash"
          title="Clearer control, day to day"
        />
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              icon: BarChart3,
              title: "See the day as it happens",
              body: "Dashboards and daily accounts show what has been recorded today, by whom, and where.",
            },
            {
              icon: FileClock,
              title: "Trace what happened later",
              body: "Activity history and audit entries keep the story of a record, not just its current value.",
            },
            {
              icon: ShieldCheck,
              title: "Keep access controlled",
              body: "Each person signs in for their own role, with session limits and a forced first-login password change.",
            },
            {
              icon: BadgeCheck,
              title: "Work from real records",
              body: "Reports and exports are drawn from the entries your team made, so everyone works from the same numbers.",
            },
          ].map((item) => (
            <div key={item.title} className="rounded-card border border-line bg-white p-6 shadow-card">
              <item.icon size={21} className="text-gold-700" aria-hidden />
              <h3 className="mt-4 text-base font-semibold text-ink-deep">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink">{item.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Onboarding */}
      <Section tone="ivory">
        <SectionHeading
          eyebrow="Getting started"
          title="How a business joins MaaCash"
          lead="Enrolment is deliberate: every workspace is created after a review, so businesses and their records stay properly separated from day one."
        />
        <StepList steps={STEPS} />
        <div className="mt-8">
          <Eyebrow>{COMPANY_NAME}</Eyebrow>
          <p className="mt-2 max-w-3xl text-base leading-relaxed text-ink">
            {COMPANY_NAME} reviews each request, enrols the business and hands
            over an administrator sign-in. The business then creates its own
            staff accounts inside its workspace.
          </p>
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
