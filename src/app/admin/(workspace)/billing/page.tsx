import { requireTenantAdmin } from "@/lib/tenant";
import { getBillingOverview } from "@/lib/actions/billing.actions";
import { resolveSubscriptionAccess } from "@/lib/billing/access";
import BillingClient from "./BillingClient";

export const dynamic = "force-dynamic";

export const metadata = { title: "Billing & Plan | MaaCash" };

/** Business owner subscription and billing. Server resolves the tenant first. */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ payment?: string; state?: string }>;
}) {
  const ctx = await requireTenantAdmin();
  const [overview, access, params] = await Promise.all([
    getBillingOverview(),
    resolveSubscriptionAccess(ctx.tenantId),
    searchParams,
  ]);
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <BillingClient
        overview={overview}
        paymentRequired={params.payment === "required" && !access.operable}
        accessState={access.reason}
      />
    </div>
  );
}
