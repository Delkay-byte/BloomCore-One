import Link from "next/link";
import { DraftNotice, PageHero, Section, SectionHeading } from "@/components/marketing/Sections";
import { BUSINESS_LOGIN_PATH, COMPANY_LOCATION, COMPANY_NAME, PRODUCT_NAME } from "@/lib/site";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  path: "/terms",
  title: "Terms",
  description: `Terms of service for ${PRODUCT_NAME}, operated by ${COMPANY_NAME}. Draft pending owner and legal review.`,
});

export default function TermsPage() {
  return (
    <>
      <PageHero
        eyebrow="Terms"
        title="Terms of Service"
        lead={`These terms describe the basis on which ${PRODUCT_NAME} is provided to a business, as the software operates today.`}
      />

      <Section tone="white">
        <div className="max-w-3xl space-y-8">
          <DraftNotice>
            Draft. These terms have not been reviewed by a lawyer, no service
            level is promised, and commercial terms (fees, term, notice) are not
            stated here because they are agreed separately in writing with each
            business. Do not treat this page as the final agreement.
          </DraftNotice>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">1. Who these terms are with</h2>
            <p>
              {PRODUCT_NAME} is operated by {COMPANY_NAME}, a registered
              sole-proprietorship business in {COMPANY_LOCATION}. These terms
              apply to the business that has been enrolled on the platform
              (&quot;your business&quot;) and to the people your business
              authorises to use it.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">2. What the service is</h2>
            <p>
              {PRODUCT_NAME} is a business and financial operations platform. It
              records the operations your business enters: mobile money daily
              accounts, Susu contributions and withdrawals, staff and collector
              activity, and related reports.
            </p>
            <p>
              It is <strong className="font-semibold text-ink-deep">not</strong> a bank, a
              mobile money network, a payment processor or a regulated financial
              institution. It does not hold customer funds, move money between
              accounts or networks, or provide credit, savings or investment
              products. It does not replace your accounting, tax or regulatory
              obligations.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">3. Accounts and access</h2>
            <p>
              Businesses are enrolled by {COMPANY_NAME} after a request is
              reviewed. There is no open public registration. Your business
              nominates an administrator, and that administrator creates the
              staff accounts for your workspace.
            </p>
            <p>
              Your business is responsible for who it gives access to, for
              removing access when someone leaves, and for keeping credentials
              confidential. Staff are required to change their password at first
              sign-in. Sessions end automatically after periods of inactivity and
              at fixed limits.
            </p>
            <p>
              Platform administration is a separate account type operated by{" "}
              {COMPANY_NAME}. It is not available to businesses, and a business
              account can never be used in its place.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">4. Your records</h2>
            <p>
              The business records your staff enter belong to your business. We
              store and process them to provide the service, and we do not sell
              them or use them for advertising.
            </p>
            <p>
              {PRODUCT_NAME} keeps a record of who entered and changed
              operational records, so the history of a record remains visible.
              Your business is responsible for the accuracy and lawfulness of what
              it enters, and for the instructions it gives its staff.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">5. Acceptable use</h2>
            <ul className="space-y-2">
              <li>Use the platform only for lawful business purposes.</li>
              <li>Do not attempt to reach another business&apos;s workspace or records.</li>
              <li>Do not share credentials between people, or use another person&apos;s account.</li>
              <li>Do not attempt to interfere with, or gain unauthorised access to, the platform or its hosting.</li>
              <li>Do not enter data you are not authorised to hold.</li>
            </ul>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">6. Availability and support</h2>
            <p>
              The platform is provided as it is. {COMPANY_NAME} aims to keep it
              available and to fix faults promptly, but no service level, uptime
              percentage or response time is promised on this page. Hosting may be
              interrupted for maintenance, or by failures outside our control.
            </p>
            <p>
              Where a business enables offline capture, records entered on an
              enrolled device are held on that device until they are sent to the
              platform. Keeping devices synced is part of using that feature.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">7. Fees and term</h2>
            <p>
              Fees, the term of service and notice periods are agreed separately
              in writing with each business. Nothing on this page sets or implies
              a price.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">
              8. Suspension and ending the service
            </h2>
            <p>
              Access may be suspended where these terms are breached, where a
              business&apos;s account is not in good standing under its separate
              agreement, or where it is necessary to protect the platform or
              another business. A business may stop using the service under the
              notice terms of its own agreement. We will explain how records can
              be exported at that point.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">9. Liability</h2>
            <p>
              {PRODUCT_NAME} records what your business enters. Decisions about
              money, and their consequences, remain with your business. Liability
              is limited to the extent permitted by the law that applies, and the
              final wording of this clause must be settled by legal review before
              commercial launch.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">10. Changes and governing law</h2>
            <p>
              These terms may be updated as the service changes; the current
              version is always published on this page. They are governed by the
              laws of {COMPANY_LOCATION}.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">11. Contact</h2>
            <p>
              A verified public contact channel for contractual notices is not yet
              published. It will be added here, together with the draft review
              note, before commercial launch. Existing businesses can reach their
              administrator through the{" "}
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
          title="Draft status"
          lead="These terms must be reviewed and completed before the platform is offered commercially. Until then this page is published for transparency about how the product works."
        />
      </Section>
    </>
  );
}
