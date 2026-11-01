import Link from "next/link";
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  Info,
  Mail,
  MessageCircle,
  MessageSquare,
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
  BUSINESS_LOGIN_PATH,
  COMPANY_LOCATION,
  COMPANY_NAME,
  CONTACT_CONFIGURED,
  CONTACT_EMAIL,
  CONTACT_PHONE,
  PRODUCT_NAME,
} from "@/lib/site";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  path: "/contact",
  title: "Contact",
  description: `Request a demonstration of ${PRODUCT_NAME} or ask a question about bringing your business onto the platform.`,
});

const ENQUIRY_CHECKLIST = [
  "Your business name and where you operate from",
  "Which operations you want to manage — mobile money, Susu collections, or both",
  "How many locations and how many staff would use the platform",
  "Who would be the business administrator for the workspace",
];

const mailtoHref = CONTACT_EMAIL
  ? `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
      `BloomCore One demonstration request`
    )}&body=${encodeURIComponent(
      [
        "Business name:",
        "Location(s):",
        "Operations to manage:",
        "Number of staff:",
        "Administrator name and email:",
        "",
      ].join("\n")
    )}`
  : null;

/**
 * WhatsApp deep link for the public enquiry number. Ghanaian numbers are
 * stored locally ("0240064668"); wa.me needs international form without a
 * plus sign, so a leading zero becomes the 233 country code.
 */
const whatsappHref = CONTACT_PHONE
  ? `https://wa.me/${CONTACT_PHONE.replace(/[^0-9]/g, "").replace(/^0/, "233")}`
  : null;

export default function ContactPage() {
  return (
    <>
      <PageHero
        eyebrow="Contact"
        title="Request a demonstration"
        lead="Tell us how your business operates and what you want to bring into one workspace. Requests are reviewed by BloomCore Technologies before a workspace is created."
      />

      <Section tone="white">
        <div className="grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
          <div>
            {CONTACT_CONFIGURED ? (
              <div className="rounded-card border border-line bg-white p-6 shadow-card">
                <h2 className="flex items-center gap-2 text-lg font-semibold text-ink-deep">
                  <MessageSquare size={19} className="text-brand-700" aria-hidden />
                  Send an enquiry
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-ink">
                  Enquiries are handled directly by {COMPANY_NAME}. Use the
                  channel below and include the details on the right so we can
                  answer properly the first time.
                </p>
                <div className="mt-5 space-y-3">
                  {mailtoHref ? (
                    <a
                      href={mailtoHref}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-control bg-brand-700 px-5 py-3 text-sm font-semibold text-white hover:bg-brand-800"
                    >
                      <Mail size={16} aria-hidden />
                      Email {CONTACT_EMAIL}
                    </a>
                  ) : null}
                  {CONTACT_PHONE ? (
                    <a
                      href={whatsappHref ?? `tel:${CONTACT_PHONE.replace(/\s+/g, "")}`}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-control border border-line-strong bg-[#25D366]/10 px-5 py-3 text-sm font-semibold text-ink hover:border-brand-300 hover:text-brand-700"
                    >
                      <MessageCircle size={16} aria-hidden />
                      WhatsApp {CONTACT_PHONE}
                    </a>
                  ) : null}
                  {CONTACT_PHONE ? (
                    <a
                      href={`tel:${CONTACT_PHONE.replace(/\s+/g, "")}`}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-control border border-line-strong px-5 py-3 text-sm font-semibold text-ink hover:border-brand-300 hover:text-brand-700"
                    >
                      <Phone size={16} aria-hidden />
                      Call {CONTACT_PHONE}
                    </a>
                  ) : null}
                </div>
                <p className="mt-4 text-xs leading-relaxed text-ink-muted">
                  The email link opens your own mail application with a blank
                  enquiry template. Nothing is submitted from this website, and
                  no data you type is sent to or stored by {PRODUCT_NAME}.
                </p>
              </div>
            ) : (
              <div className="rounded-card border border-gold-300 bg-gold-50 p-6">
                <h2 className="flex items-center gap-2 text-lg font-semibold text-ink-deep">
                  <Info size={19} className="text-gold-700" aria-hidden />
                  The public enquiry channel is not published yet
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-ink">
                  {COMPANY_NAME} has not yet supplied a business email address or
                  telephone number for public enquiries, and this site will not
                  invent one or pretend an enquiry has been sent. Until the
                  channel is configured, this page is published without a
                  submission route.
                </p>
                <div className="mt-4 rounded-lg border border-gold-200 bg-white p-4">
                  <h3 className="text-sm font-semibold text-ink-deep">
                    Required before demonstrations can be requested here
                  </h3>
                  <ul className="mt-2 space-y-1.5 text-sm text-ink">
                    <li>• A monitored business email address (for example enquiries@your-domain)</li>
                    <li>• A business telephone number, if enquiries should also be accepted by phone</li>
                    <li>• Confirmation that both may be published on this public page</li>
                  </ul>
                  <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                    Once supplied, set <code className="font-mono">CONTACT_EMAIL</code>{" "}
                    and/or <code className="font-mono">CONTACT_PHONE</code> on the
                    hosting service. The enquiry channel appears on this page after
                    the next restart — no code change is required.
                  </p>
                </div>
              </div>
            )}

            <div className="mt-6 rounded-card border border-line bg-surface-muted p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-deep">
                <ShieldCheck size={17} className="text-brand-700" aria-hidden />
                Already have a workspace?
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-ink">
                Existing businesses sign in with the account their administrator
                gave them. Administrators sign in separately from their staff.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Link
                  href={BUSINESS_LOGIN_PATH}
                  className="inline-flex items-center gap-2 rounded-control bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800"
                >
                  Business sign in
                  <ArrowRight size={15} aria-hidden />
                </Link>
                <Link
                  href="/access"
                  className="inline-flex items-center rounded-control border border-line-strong bg-white px-4 py-2.5 text-sm font-semibold text-ink hover:border-brand-300 hover:text-brand-700"
                >
                  All sign-in options
                </Link>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <SectionHeading
              eyebrow="A useful first message"
              title="What to include"
              lead="Enough detail for us to say whether the platform fits, and which modules your business would use."
            />
            <ul className="space-y-3">
              {ENQUIRY_CHECKLIST.map((item) => (
                <li key={item} className="flex gap-3 rounded-control border border-line bg-white p-4 text-sm text-ink">
                  <CheckCircle2 size={17} className="mt-0.5 flex-none text-brand-600" aria-hidden />
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            <Panel title="What happens next">
              <ol className="mt-1 space-y-2">
                <li>1. {COMPANY_NAME} reviews the request.</li>
                <li>2. We confirm the modules that fit your operations.</li>
                <li>3. Your workspace is created and your administrator signs in.</li>
                <li>4. You add locations and staff and start recording work.</li>
              </ol>
            </Panel>

            <Panel title="What we will not ask for">
              <p>
                We never ask for your customer records, mobile money balances or
                account passwords in an enquiry. No financial data should be sent
                through the contact channel.
              </p>
            </Panel>

            <p className="flex items-start gap-2 text-sm leading-relaxed text-ink-muted">
              <Building2 size={16} className="mt-0.5 flex-none" aria-hidden />
              <span>
                {COMPANY_NAME} — a business based in {COMPANY_LOCATION}. We do
                not use social media accounts for enquiries, and none are linked
                here.
              </span>
            </p>
          </div>
        </div>
      </Section>
    </>
  );
}
