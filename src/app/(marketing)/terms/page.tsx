import type { Metadata } from "next";
import Link from "next/link";
import { PageHero, Section } from "@/components/marketing/Sections";
import {
  BUSINESS_LOGIN_PATH,
  COMPANY_LOCATION,
  COMPANY_NAME,
  CONTACT_EMAIL,
  PRODUCT_NAME,
} from "@/lib/site";
import { pageMetadata } from "@/lib/metadata";

export const metadata: Metadata = {
  ...pageMetadata({
    path: "/terms",
    title: "Service terms",
    description: `How ${PRODUCT_NAME} service terms are agreed with each business.`,
  }),
  robots: { index: false, follow: true },
};

/**
 * Service-terms notice.
 *
 * The commercial agreement is signed with each business at onboarding. This
 * page therefore explains where the agreement lives and what the product does
 * not do; it does not publish an unreviewed draft as if it were the contract.
 */
export default function TermsPage() {
  return (
    <>
      <PageHero
        eyebrow="Terms"
        title="Service terms"
        lead={`${PRODUCT_NAME} is provided to a business under the written agreement signed when the business is onboarded.`}
      />

      <Section tone="white">
        <div className="max-w-3xl space-y-8">
          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">
              Where the agreement is
            </h2>
            <p>
              Fees, billing period, notice and support commitments are stated in
              the agreement signed with your business and in the package you
              select in Subscription &amp; Billing. Those signed terms apply. This
              page is a short notice about the product, not a substitute for them.
            </p>
            <p>
              The prices shown on the{" "}
              <Link href="/pricing" className="font-medium text-brand-700 hover:text-brand-800">
                pricing page
              </Link>{" "}
              are the current package prices. The amount you are asked to pay in
              Subscription &amp; Billing is the amount that applies to your
              business, including any founding-customer price already assigned to
              it.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">What MaaCash is</h2>
            <p>
              {PRODUCT_NAME} records the operations a business enters: mobile
              money daily accounts, Susu contributions and withdrawals, staff and
              collector activity, and related reports.
            </p>
            <p>
              It is not a bank, a mobile money network, a payment processor or a
              regulated financial institution. It does not hold customer funds,
              move money between accounts or networks, or provide credit, savings
              or investment products. Decisions about money, and their
              consequences, remain with your business.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">
              Access, renewal and suspension
            </h2>
            <p>
              A business is activated after its first payment is verified by
              MaaCash. Access continues for the paid period. When a period ends
              without a verified renewal, the workspace enters a short grace period
              and then paid operations are suspended until a renewal is verified.
              Records are retained; they are not deleted because a payment is late.
            </p>
            <p>
              Package changes take effect at the next renewal. An already-paid
              period is never repriced, and choosing a smaller package never
              deletes business records.
            </p>
          </div>

          <div className="space-y-3 text-base leading-relaxed text-ink">
            <h2 className="text-xl font-semibold text-ink-deep">Contact</h2>
            <p>
              {CONTACT_EMAIL ? (
                <>
                  Questions about your agreement can be sent to{" "}
                  <a
                    href={`mailto:${CONTACT_EMAIL}`}
                    className="font-medium text-brand-700 hover:text-brand-800"
                  >
                    {CONTACT_EMAIL}
                  </a>
                  .
                </>
              ) : (
                <>
                  Existing businesses can reach the platform operator through
                  their administrator.
                </>
              )}{" "}
              {PRODUCT_NAME} is operated by {COMPANY_NAME}, based in{" "}
              {COMPANY_LOCATION}, and is governed by the laws of{" "}
              {COMPANY_LOCATION}. Signed-in administrators can review their
              package in{" "}
              <Link href="/admin/billing" className="font-medium text-brand-700 hover:text-brand-800">
                Subscription &amp; Billing
              </Link>
              , or sign in through the{" "}
              <Link href={BUSINESS_LOGIN_PATH} className="font-medium text-brand-700 hover:text-brand-800">
                business sign in
              </Link>
              .
            </p>
          </div>
        </div>
      </Section>
    </>
  );
}
