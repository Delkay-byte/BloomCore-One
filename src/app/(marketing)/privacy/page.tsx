import Link from "next/link";
import { DraftNotice, PageHero, Section, SectionHeading } from "@/components/marketing/Sections";
import { BUSINESS_LOGIN_PATH, COMPANY_NAME, PRODUCT_NAME } from "@/lib/site";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  path: "/privacy",
  title: "Privacy",
  description: `How ${PRODUCT_NAME} handles account, business and operational data, written from what the deployed application actually processes.`,
});

export default function PrivacyPage() {
  return (
    <>
      <PageHero
        eyebrow="Privacy"
        title="Privacy information"
        lead={`This page explains what ${PRODUCT_NAME} collects and stores, written from how the deployed application actually works rather than from a template.`}
      />

      <Section tone="white">
        <div className="max-w-3xl space-y-8">
          <DraftNotice>
            This is a factual description of the deployed system, prepared for
            review. It has not been reviewed by a lawyer and is not a legal
            agreement. It must be reviewed before commercial launch, and it does
            not yet name a data-protection contact because no verified public
            contact channel has been supplied.
          </DraftNotice>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">Who is responsible</h2>
            <p>
              {COMPANY_NAME}, a business based in Ghana, operates {PRODUCT_NAME}.
              Each business that uses the platform is responsible for the
              accuracy of the records its own staff enter, and for telling its
              own customers how their information is used.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">
              What the platform stores
            </h2>
            <p>
              When a business is enrolled, and as its staff work, the platform
              stores:
            </p>
            <ul className="space-y-2">
              <li>
                <strong className="font-semibold text-ink-deep">Account details</strong> — name,
                email address, telephone number where supplied, role, status, and a
                one-way password hash. Passwords themselves are never stored.
              </li>
              <li>
                <strong className="font-semibold text-ink-deep">Business records</strong> —
                locations, staff assignments, customers, Susu accounts and cycles,
                contributions and their allocations, withdrawals, collector
                assignments and remittances, MoMo daily accounts, commission,
                expenses and reconciliation entries.
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
            </ul>
            <p>
              Records entered for one business are only visible to that business
              and to the platform operators who administer the platform.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">Cookies and sessions</h2>
            <p>
              The platform uses its own session cookies, which are limited to the
              site and are not readable by other sites. There is no advertising
              or analytics cookie. Different roles — business administrator,
              worker, collector, customer, and the separate platform
              administrator — use separate session cookies, and one cannot be
              used in place of another.
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
              enrolled device are held in that device&apos;s browser storage until
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
              The application is hosted by a cloud hosting provider, and its
              database is hosted by a managed PostgreSQL provider. Those providers
              process data on our behalf to run the service. The public site and
              the application also load the Noto Sans typeface from Google Fonts,
              which means your browser contacts Google&apos;s font service to
              fetch it.
            </p>
            <p>
              We do not sell business or customer data, and we do not use it for
              advertising.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">This website</h2>
            <p>
              The public pages of this site do not contain analytics, tracking
              pixels or advertising code, and they do not set session cookies. The
              contact page does not submit anything: if an email link is used, your
              own mail application opens and nothing is stored by this site.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">
              Retention and your requests
            </h2>
            <p>
              A fixed retention period is not published here, because the
              business that owns the records decides how long it needs them and
              legal requirements differ. Retention practice is being finalised and
              this page will be updated before commercial launch.
            </p>
            <p>
              Requests to access, correct or remove information should be made to
              the business whose records they are, or to {COMPANY_NAME}. A
              dedicated privacy contact is not yet published; it will be added here
              when the owner supplies one.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">Changes</h2>
            <p>
              When this page changes, the updated version is published here. It
              is marked as a draft until the owner and their legal adviser have
              reviewed it.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">Related</h2>
            <p>
              See the{" "}
              <Link href="/terms" className="font-medium text-brand-700 hover:text-brand-800">
                Terms of Service
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
          eyebrow="Note"
          title="This page describes the product, not a legal guarantee"
          lead="It states what the deployed software does. It does not claim a certification, a regulatory approval or a security guarantee."
        />
      </Section>
    </>
  );
}
