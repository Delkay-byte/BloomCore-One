import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Mail,
  MessageCircle,
  Phone,
  ShieldCheck,
} from "lucide-react";
import {
  PageHero,
  Panel,
  Section,
  SectionHeading,
} from "@/components/marketing/Sections";
import {
  ADMIN_LOGIN_PATH,
  ALL_ACCESS_PATH,
  COMPANY_NAME,
  CONTACT_EMAIL,
  CONTACT_PHONE,
  PRODUCT_NAME,
} from "@/lib/site";
import { pageMetadata } from "@/lib/metadata";
import PricingEnquiryForm from "@/components/marketing/PricingEnquiryForm";

export const metadata = pageMetadata({
  path: "/contact",
  title: "Request a demonstration",
  description: `Tell ${COMPANY_NAME} about your business and request a ${PRODUCT_NAME} demonstration.`,
});

const NEXT_STEPS = [
  {
    title: "Submit your business details",
    body: "Tell us how you run mobile money and Susu today, and how many locations you operate.",
  },
  {
    title: "Our team reviews your request",
    body: `${COMPANY_NAME} reads every request and confirms which parts of ${PRODUCT_NAME} fit your operations.`,
  },
  {
    title: "We contact you to arrange a demonstration",
    body: "We use the phone number or email address you supplied — whichever you prefer.",
  },
  {
    title: "If you decide to proceed, we create your workspace",
    body: "Your business workspace and administrator account are created through our controlled onboarding. No payment is taken from this form.",
  },
];

function whatsappHref(phone: string) {
  return `https://wa.me/${phone.replace(/[^0-9]/g, "").replace(/^0/, "233")}`;
}

/**
 * Public demonstration request.
 *
 * This page is the public enquiry channel. It submits to the same server action
 * and `AccountEnquiry` table as the pricing page, so Platform Super Admin
 * reviews demonstration requests and account enquiries in one place. Contact
 * details published here are optional extras: the form works whether or not the
 * owner has configured a public phone number or email address.
 */
export default function ContactPage() {
  return (
    <>
      <PageHero
        eyebrow="Request a demonstration"
        title="Request a MaaCash demonstration"
        lead="Tell us about your business and how you manage mobile money, Susu collections and your locations. We'll review your request and arrange a demonstration to show you how MaaCash can help."
      />

      <Section tone="white">
        <div className="grid gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:gap-14">
          <div>
            <div className="rounded-card border border-line bg-white p-6 shadow-card sm:p-8">
              <h2 className="text-lg font-semibold text-ink-deep">
                Request a demonstration
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-ink-muted">
                These details let us reach you and prepare a demonstration that
                fits how your business actually runs.
              </p>

              <div className="mt-5">
                <PricingEnquiryForm variant="demo" />
              </div>

              <p className="mt-5 border-t border-line pt-4 text-xs leading-relaxed text-ink-muted">
                The details you submit are used to respond to this request and to
                prepare your demonstration. We do not sell them, and we never ask
                for customer records, mobile money balances or account passwords.
                See the{" "}
                <Link href="/privacy" className="font-medium text-brand-700 underline">
                  Privacy Notice
                </Link>{" "}
                for what is stored and how to ask for correction or deletion.
              </p>
            </div>

            <div className="mt-6 rounded-card border border-line bg-surface-muted p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-deep">
                <ShieldCheck size={17} className="text-brand-700" aria-hidden />
                Already have a workspace?
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-ink">
                Business owners sign in to their administration workspace. Staff
                and customers use the standard sign-in.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Link
                  href={ADMIN_LOGIN_PATH}
                  className="inline-flex items-center gap-2 rounded-control bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800"
                >
                  Business Owner Sign In
                  <ArrowRight size={15} aria-hidden />
                </Link>
                <Link
                  href={ALL_ACCESS_PATH}
                  className="inline-flex items-center rounded-control border border-line-strong bg-white px-4 py-2.5 text-sm font-semibold text-ink hover:border-brand-300 hover:text-brand-700"
                >
                  Other Sign-in Options
                </Link>
              </div>
            </div>

            {(CONTACT_EMAIL || CONTACT_PHONE) && (
              <div className="mt-6 rounded-card border border-line bg-white p-5">
                <h2 className="text-sm font-semibold text-ink-deep">
                  Prefer to speak to us directly?
                </h2>
                <div className="mt-3 flex flex-wrap gap-3">
                  {CONTACT_EMAIL ? (
                    <a
                      href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("MaaCash demonstration request")}`}
                      className="inline-flex items-center gap-2 rounded-control border border-line-strong px-4 py-2.5 text-sm font-semibold text-ink hover:border-brand-300 hover:text-brand-700"
                    >
                      <Mail size={15} aria-hidden />
                      Email us
                    </a>
                  ) : null}
                  {CONTACT_PHONE ? (
                    <>
                      <a
                        href={`tel:${CONTACT_PHONE.replace(/\s+/g, "")}`}
                        className="inline-flex items-center gap-2 rounded-control border border-line-strong px-4 py-2.5 text-sm font-semibold text-ink hover:border-brand-300 hover:text-brand-700"
                      >
                        <Phone size={15} aria-hidden />
                        Call {CONTACT_PHONE}
                      </a>
                      <a
                        href={whatsappHref(CONTACT_PHONE)}
                        className="inline-flex items-center gap-2 rounded-control border border-line-strong px-4 py-2.5 text-sm font-semibold text-ink hover:border-brand-300 hover:text-brand-700"
                      >
                        <MessageCircle size={15} aria-hidden />
                        WhatsApp
                      </a>
                    </>
                  ) : null}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-6">
            <SectionHeading
              eyebrow="What happens next"
              title="From request to demonstration"
              lead="Four steps, no account required to start."
            />
            <ol className="space-y-3">
              {NEXT_STEPS.map((step, index) => (
                <li
                  key={step.title}
                  className="flex gap-3 rounded-control border border-line bg-white p-4"
                >
                  <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-brand-700 text-xs font-semibold text-white">
                    {index + 1}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-ink-deep">{step.title}</p>
                    <p className="mt-1 text-sm leading-relaxed text-ink-muted">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <Panel title="What the form does not do">
              <ul className="space-y-2">
                <li className="flex gap-2">
                  <CheckCircle2 size={15} className="mt-0.5 flex-none text-brand-600" aria-hidden />
                  <span>It does not create a business workspace or a login.</span>
                </li>
                <li className="flex gap-2">
                  <CheckCircle2 size={15} className="mt-0.5 flex-none text-brand-600" aria-hidden />
                  <span>It does not start a subscription or take any payment.</span>
                </li>
                <li className="flex gap-2">
                  <CheckCircle2 size={15} className="mt-0.5 flex-none text-brand-600" aria-hidden />
                  <span>It does not book an appointment automatically.</span>
                </li>
              </ul>
            </Panel>

            <p className="text-sm leading-relaxed text-ink-muted">
              {COMPANY_NAME} reviews every request personally, so a demonstration is
              arranged with you rather than issued automatically.
            </p>
          </div>
        </div>
      </Section>
    </>
  );
}
