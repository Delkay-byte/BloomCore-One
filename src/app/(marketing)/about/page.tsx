import Link from "next/link";
import {
  ArrowRight,
  Building2,
  Compass,
  Layers,
  MapPin,
  ShieldCheck,
  Users,
} from "lucide-react";
import {
  CtaBand,
  PageHero,
  Panel,
  Section,
  SectionHeading,
} from "@/components/marketing/Sections";
import {
  COMPANY_LOCATION,
  COMPANY_NAME,
  PRODUCT_DESCRIPTOR,
  PRODUCT_NAME,
  PRODUCT_POSITIONING,
} from "@/lib/site";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  path: "/about",
  title: "About",
  description: `${PRODUCT_NAME} is a ${PRODUCT_DESCRIPTOR.toLowerCase()} built by ${COMPANY_NAME}, a business based in ${COMPANY_LOCATION}.`,
});

export default function AboutPage() {
  return (
    <>
      <PageHero
        eyebrow="About"
        title={`${COMPANY_NAME} builds the software behind the counter`}
        lead={PRODUCT_POSITIONING}
      >
        <Link
          href="/contact"
          className="inline-flex items-center gap-2 rounded-control bg-brand-700 px-5 py-3 text-sm font-semibold text-white hover:bg-brand-800"
        >
          Talk to us
          <ArrowRight size={16} aria-hidden />
        </Link>
      </PageHero>

      <Section tone="white">
        <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:gap-16">
          <div className="space-y-5 text-base leading-relaxed text-ink">
            <p>
              {COMPANY_NAME} is a business based in {COMPANY_LOCATION}. We build
              and operate {PRODUCT_NAME}, a{" "}
              {PRODUCT_DESCRIPTOR.toLowerCase()} for businesses that handle money
              on behalf of customers.
            </p>
            <p>
              The product started from a specific problem: businesses that run
              mobile money points and Susu collections depend on people to record
              what happened, and the record has to survive the end of the day,
              the end of the month and the end of the year. Paper gives out long
              before that.
            </p>
            <p>
              {PRODUCT_NAME} exists so that the record is part of the work. The
              person who collected the contribution records it. The person who
              approved the withdrawal is named on it. The business can see the
              day while it is still happening and answer questions about it
              months later.
            </p>
          </div>

          <div className="space-y-4">
            <Panel title="Built for operations, not for show" headingLevel={2}>
              <p>
                Every screen in {PRODUCT_NAME} exists because a business needed
                to record something, find something or check something. There are
                no vanity dashboards.
              </p>
            </Panel>
            <Panel title="Multi-business from the ground up" headingLevel={2}>
              <p>
                The platform was built as separate workspaces, not as one shared
                system with filters on top. Each business&apos;s records,
                users and history live in its own workspace.
              </p>
            </Panel>
            <Panel title="Enrolled, not self-served" headingLevel={2}>
              <p>
                Businesses are enrolled by us after a request is reviewed. That
                keeps workspaces deliberate and keeps support honest.
              </p>
            </Panel>
          </div>
        </div>
      </Section>

      <Section tone="ivory">
        <SectionHeading
          eyebrow="How the product is structured"
          title="One platform, many businesses, one workspace each"
        />
        <div className="mt-10 grid gap-6 lg:grid-cols-3">
          <div className="rounded-card border border-line bg-white p-6">
            <Building2 size={21} className="text-brand-700" aria-hidden />
            <h3 className="mt-4 text-base font-semibold text-ink-deep">
              {COMPANY_NAME}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink">
              The business that builds, operates and supports the platform.
            </p>
          </div>
          <div className="rounded-card border-2 border-brand-700 bg-white p-6">
            <Layers size={21} className="text-gold-700" aria-hidden />
            <h3 className="mt-4 text-base font-semibold text-ink-deep">
              {PRODUCT_NAME}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink">
              The software product: a {PRODUCT_DESCRIPTOR.toLowerCase()} operated
              as a service, with a workspace for each business.
            </p>
          </div>
          <div className="rounded-card border border-line bg-white p-6">
            <Users size={21} className="text-brand-700" aria-hidden />
            <h3 className="mt-4 text-base font-semibold text-ink-deep">
              Each business, one workspace
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink">
              A business signs up for its own workspace, with its own name, its
              own administrator and its own records. It is a customer of the
              platform. It is never the name of the software.
            </p>
          </div>
        </div>
        <p className="mt-6 max-w-3xl text-sm leading-relaxed text-ink-muted">
          When another business joins, it appears as its own workspace with its
          own administrator. Nothing about your business is shared with, or
          visible to, another.
        </p>
      </Section>

      <Section tone="white">
        <SectionHeading
          eyebrow="How we work"
          title="What we hold ourselves to"
        />
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              icon: Compass,
              title: "Describe what exists",
              body: "We only put a capability on this website when it is in the product and working for a business.",
            },
            {
              icon: MapPin,
              title: "Say where we operate from",
              body: `${COMPANY_NAME} operates from ${COMPANY_LOCATION} and supports businesses directly.`,
            },
            {
              icon: ShieldCheck,
              title: "Respect the boundary",
              body: "Business records belong to the business. We do not treat one customer's data as another's.",
            },
          ].map((item) => (
            <div key={item.title} className="rounded-card border border-line bg-white p-6">
              <item.icon size={20} className="text-brand-700" aria-hidden />
              <h3 className="mt-4 text-base font-semibold text-ink-deep">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink">{item.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section tone="ivory">
        <div className="grid gap-8 lg:grid-cols-2 lg:items-center">
          <SectionHeading
            eyebrow="Questions"
            title="Want to know how it would work for your business?"
            lead="We are happy to walk through the modules, the access model and how a workspace would be set up for your team."
          />
          <div className="flex flex-col gap-3 sm:flex-row lg:justify-end">
            <Link
              href="/contact"
              className="inline-flex items-center justify-center gap-2 rounded-control bg-brand-700 px-5 py-3 text-sm font-semibold text-white hover:bg-brand-800"
            >
              Request a Demonstration
              <ArrowRight size={16} aria-hidden />
            </Link>
            <Link
              href="/features"
              className="inline-flex items-center justify-center rounded-control border border-line-strong bg-white px-5 py-3 text-sm font-semibold text-ink hover:border-brand-300 hover:text-brand-700"
            >
              Browse features
            </Link>
          </div>
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
