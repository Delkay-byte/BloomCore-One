import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, Info } from "lucide-react";
import { BUSINESS_LOGIN_PATH } from "@/lib/site";

/** Shared, reusable building blocks for the public pages. */

export function Container({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 ${className ?? ""}`}>
      {children}
    </div>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">
      {children}
    </p>
  );
}

export function PageHero({
  eyebrow,
  title,
  lead,
  children,
}: {
  eyebrow?: string;
  title: string;
  lead?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="border-b border-line bg-ivory">
      <Container className="py-14 sm:py-20">
        <div className="max-w-3xl">
          {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-deep sm:text-4xl lg:text-5xl">
            {title}
          </h1>
          {lead ? <p className="mt-5 text-lg leading-relaxed text-ink">{lead}</p> : null}
          {children ? <div className="mt-7">{children}</div> : null}
        </div>
      </Container>
    </section>
  );
}

export function Section({
  children,
  tone = "white",
  id,
  className,
}: {
  children: React.ReactNode;
  tone?: "white" | "ivory" | "forest";
  id?: string;
  className?: string;
}) {
  const tones = {
    white: "bg-white",
    ivory: "bg-ivory",
    forest: "bg-brand-900 text-white",
  } as const;

  return (
    <section id={id} className={`${tones[tone]} ${className ?? ""}`}>
      <Container className="py-14 sm:py-20">{children}</Container>
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  lead,
  tone = "light",
}: {
  eyebrow?: string;
  title: string;
  lead?: string;
  tone?: "light" | "dark";
}) {
  const dark = tone === "dark";
  return (
    <div className="max-w-3xl">
      {eyebrow ? (
        <p
          className={`text-xs font-semibold uppercase tracking-[0.16em] ${
            dark ? "text-gold-400" : "text-brand-600"
          }`}
        >
          {eyebrow}
        </p>
      ) : null}
      <h2
        className={`mt-3 text-2xl font-semibold tracking-tight sm:text-3xl ${
          dark ? "text-white" : "text-ink-deep"
        }`}
      >
        {title}
      </h2>
      {lead ? (
        <p className={`mt-4 text-base leading-relaxed ${dark ? "text-brand-100" : "text-ink"}`}>
          {lead}
        </p>
      ) : null}
    </div>
  );
}

export function FeatureCard({
  icon: Icon,
  title,
  description,
  points,
  headingLevel = 3,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  points?: string[];
  /** Heading level for the card title. Use 2 when the card is a direct child of
      the page's first section, so the outline never jumps from h1 to h3. */
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <article className="flex h-full flex-col rounded-card border border-line bg-white p-6 shadow-card transition-shadow hover:shadow-raised">
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
        <Icon size={21} aria-hidden />
      </span>
      <Heading className="mt-4 text-lg font-semibold text-ink-deep">{title}</Heading>
      <p className="mt-2 text-sm leading-relaxed text-ink">{description}</p>
      {points?.length ? (
        <ul className="mt-4 space-y-2 text-sm text-ink">
          {points.map((point) => (
            <li key={point} className="flex gap-2">
              <span aria-hidden className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-gold-500" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export function Panel({
  title,
  children,
  tone = "light",
  headingLevel = 3,
}: {
  title?: string;
  children: React.ReactNode;
  tone?: "light" | "warning";
  /** Heading level for the panel title. Use 2 when the panel is a direct child
      of the page's first section, so the outline never jumps from h1 to h3. */
  headingLevel?: 2 | 3;
}) {
  const warning = tone === "warning";
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div
      className={`rounded-card border p-6 ${
        warning ? "border-gold-300 bg-gold-50" : "border-line bg-white shadow-card"
      }`}
    >
      {title ? (
        <Heading className="flex items-center gap-2 text-base font-semibold text-ink-deep">
          {warning ? <Info size={18} className="text-gold-700" aria-hidden /> : null}
          {title}
        </Heading>
      ) : null}
      <div className={`text-sm leading-relaxed text-ink ${title ? "mt-2" : ""}`}>
        {children}
      </div>
    </div>
  );
}

export function StepList({
  steps,
}: {
  steps: { title: string; description: string }[];
}) {
  return (
    <ol className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-5 lg:gap-4">
      {steps.map((step, index) => (
        <li key={step.title} className="relative rounded-card border border-line bg-white p-5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand-700 text-sm font-semibold text-white">
            {index + 1}
          </span>
          <h3 className="mt-3 text-sm font-semibold text-ink-deep">{step.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-ink">{step.description}</p>
        </li>
      ))}
    </ol>
  );
}

export function CtaBand({
  title = "Ready to run your business on BloomCore One?",
  body = "Tell us about your business and the operations you want to bring into one workspace. BloomCore Technologies reviews every request before a workspace is created.",
}: {
  title?: string;
  body?: string;
}) {
  return (
    <section className="bg-brand-800">
      <Container className="py-14 sm:py-16">
        <div className="flex flex-col items-start justify-between gap-6 lg:flex-row lg:items-center">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              {title}
            </h2>
            <p className="mt-3 text-base leading-relaxed text-brand-100">{body}</p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              href="/contact"
              className="inline-flex items-center justify-center gap-2 rounded-control bg-gold-500 px-5 py-3 text-sm font-semibold text-brand-950 transition-colors hover:bg-gold-400"
            >
              Request a Demonstration
              <ArrowRight size={16} aria-hidden />
            </Link>
            <Link
              href={BUSINESS_LOGIN_PATH}
              className="inline-flex items-center justify-center rounded-control border border-brand-400 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
            >
              Sign In
            </Link>
          </div>
        </div>
      </Container>
    </section>
  );
}

/** Legal pages are drafts until the owner and their legal adviser review them. */
export function DraftNotice({ children }: { children?: React.ReactNode }) {
  return (
    <div className="rounded-card border border-gold-300 bg-gold-50 p-4 text-sm text-ink">
      <p className="font-semibold text-ink-deep">Draft — pending owner and legal review</p>
      <p className="mt-1 leading-relaxed">
        {children ??
          "This page describes how the deployed application actually handles data. It is not a legal agreement and has not been reviewed by a lawyer. It must be reviewed before commercial launch."}
      </p>
    </div>
  );
}
