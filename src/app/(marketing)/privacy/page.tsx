import Link from "next/link";
import { PageHero, Section, SectionHeading } from "@/components/marketing/Sections";
import {
  BUSINESS_LOGIN_PATH,
  COMPANY_NAME,
  COMPANY_REGISTRATION_NUMBER,
  PRODUCT_NAME,
} from "@/lib/site";
import { pageMetadata } from "@/lib/metadata";
import {
  BLOOMCORE_PRIVACY_EMAIL,
  renderPublicPrivacyAddendum,
} from "@/lib/risk-intelligence/legal-instruments";
import { getRiskOrganisationConfig } from "@/lib/risk-intelligence/organisation-profile";

export const metadata = pageMetadata({
  path: "/privacy",
  title: "Privacy",
  description: `What ${PRODUCT_NAME} collects, why it is collected, and how business and enquiry information is handled.`,
});

/**
 * Public privacy notice.
 *
 * It describes how the deployed system actually behaves: no analytics, no
 * advertising, no data sale. The owner-approved privacy contact is published
 * exactly; no invented address, DPO or representative is implied.
 */
export const dynamic = "force-dynamic";

export default async function PrivacyPage() {
  const config = await getRiskOrganisationConfig();
  const publicEmail = config.legal.contactEmail.includes("@")
    ? config.legal.contactEmail
    : BLOOMCORE_PRIVACY_EMAIL;

  return (
    <>
      <PageHero
        eyebrow="Privacy"
        title="Privacy notice"
        lead={`What ${PRODUCT_NAME} collects, why, and who can see it.`}
      />

      <Section tone="white">
        <div className="max-w-3xl space-y-8">
          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">Who is responsible</h2>
            <p>
              {COMPANY_NAME}, Business Registration Number{" "}
              {COMPANY_REGISTRATION_NUMBER}, operates {PRODUCT_NAME}. Each business
              that uses the platform is responsible for the records its own staff
              enter, and for telling its own customers how their information is
              used.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">
              Shared Agent Risk Intelligence
            </h2>
            <p>
              This addendum applies when a business joins the Shared Agent Risk
              Intelligence programme. It explains the joint-controller role, the
              categories of pseudonymised data, the legal thresholds, retention,
              security and how an agent exercises rights. The text below is the
              operative public addendum and is rendered from the same controlled
              source as the participation instruments.
            </p>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-line bg-surface p-4 font-sans text-sm leading-relaxed text-ink">
              {renderPublicPrivacyAddendum(config.legal, config.infrastructure)}
            </pre>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">
              Information collected when you request an account
            </h2>
            <p>
              The account enquiry form on the pricing page asks for your business
              name, the name of the person we should contact, a Ghana phone
              number, an email address, an optional number of locations,
              an optional package preference, and anything you choose to write in
              the message box.
            </p>
            <p>
              It is used for one purpose: to review your request and contact you
              about setting up your business on {PRODUCT_NAME}. Submitting the
              form does not create an account, a login or a subscription, and it
              does not take a payment. Enquiries are visible only to the platform
              operators who review them, and are kept while we follow up on the
              request. They are not used for advertising and are not sold.
            </p>
            <p>
              The form is protected by Cloudflare Turnstile, which checks that the
              submission comes from a person rather than an automated script. The
              challenge is answered by Cloudflare in your browser.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">
              What the platform stores for a business
            </h2>
            <ul className="space-y-2">
              <li>
                <strong className="font-semibold text-ink-deep">Account details</strong> —
                name, email address, telephone number where supplied, role, status,
                and a one-way password hash. Passwords themselves are never stored.
              </li>
              <li>
                <strong className="font-semibold text-ink-deep">Business records</strong> —
                locations, staff assignments, customers, Susu accounts and cycles,
                contributions and their allocations, withdrawals, collector
                assignments and remittances, mobile money daily accounts,
                commission, expenses and reconciliation entries.
              </li>
              <li>
                <strong className="font-semibold text-ink-deep">Device records</strong> —
                which device is enrolled to which staff account, when it was
                enrolled, and its status.
              </li>
              <li>
                <strong className="font-semibold text-ink-deep">Activity records</strong> —
                sign-in, security and administrative events, and the audit entries
                written when records are created or changed, including who did it
                and when.
              </li>
              <li>
                <strong className="font-semibold text-ink-deep">Sessions</strong> — a
                signed session token held in your browser to keep you signed in.
              </li>
              <li>
                <strong className="font-semibold text-ink-deep">Zeli usage</strong> —
                how many Zeli requests a business has used in the current month.
                Zeli answers from the business&rsquo;s own authorized records and
                cannot post, reverse or delete money.
              </li>
            </ul>
            <p>
              Records entered for one business are visible only to that business
              and to the platform operators who administer the platform.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">Cookies and sessions</h2>
            <p>
              The platform uses its own session cookies, limited to the site and
              not readable by other sites. There is no advertising or analytics
              cookie. Different roles — business administrator, worker, collector,
              customer, and the separate platform administrator — use separate
              session cookies, and one cannot be used in place of another.
            </p>
            <p>
              Sessions end automatically after inactivity and at fixed limits set
              for the deployment. Signing out ends the session for that role.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">
              Information kept on a device
            </h2>
            <p>
              Where a business enables offline capture, records entered on an
              enrolled device are held in that device&rsquo;s browser storage until
              they are sent to the platform. Removing the application data from
              the device removes those unsent records, which is why staff are
              asked to sync before uninstalling or clearing browser data.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">
              Services used to run the platform
            </h2>
            <p>
              The application is hosted by a cloud hosting provider, its database
              is hosted by a managed PostgreSQL provider, account and security
              emails are sent through an email delivery provider, and payments are
              processed by Paystack. Those providers process data on our behalf to
              run the service. The public site loads the Noto Sans typeface from
              Google Fonts, which means your browser contacts Google&rsquo;s font
              service to fetch it.
            </p>
            <p>
              We do not sell business or customer data, and we do not use it for
              advertising.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">This website</h2>
            <p>
              The public pages do not contain analytics, tracking pixels or
              advertising code, and they do not set session cookies. The only
              form that stores anything is the account enquiry form described
              above.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">
              Retention and your requests
            </h2>
            <p>
              The business that owns operational records decides how long it needs
              them, because retention requirements differ between businesses.
              Platform records such as security events and audit entries are kept
              for the period configured for the deployment.
            </p>
            <p>
              Requests to access, correct, block or erase information should first
              be made to the business whose records they are. Privacy questions for
              {" "}{COMPANY_NAME} can be sent to{" "}
              <a
                href={`mailto:${publicEmail}`}
                className="font-medium text-brand-700 hover:text-brand-800"
              >
                {publicEmail}
              </a>
              . The request is acknowledged within 3 business days, excluding
              weekends and gazetted Ghana public holidays, and resolved within 21
              calendar days, with at most one reasoned 14-day extension.
            </p>
            <p>
              Under the Data Protection Act, 2012 (Act 843) you may request access
              to your personal data, correction, blocking or erasure, and you may
              object to processing on reasonable grounds. You may also complain to
              the Data Protection Commission through its published channels.
              Exercising a right will not by itself affect your account, employment
              or access to the service.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">Changes</h2>
            <p>
              When this notice changes, the updated version is published on this
              page.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">Related</h2>
            <p>
              See the{" "}
              <Link href="/terms" className="font-medium text-brand-700 hover:text-brand-800">
                service terms notice
              </Link>{" "}
              and the{" "}
              <Link href={BUSINESS_LOGIN_PATH} className="font-medium text-brand-700 hover:text-brand-800">
                business sign in
              </Link>
              .
            </p>
          </div>
        </div>
      </Section>

      <Section tone="ivory">
        <SectionHeading
          eyebrow="Scope"
          title="What this page is"
          lead="A plain description of how the deployed product handles information. It is not a certification, a regulatory approval or a security guarantee."
        />
      </Section>
    </>
  );
}
