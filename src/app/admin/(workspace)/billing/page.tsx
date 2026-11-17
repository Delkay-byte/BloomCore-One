import { requireTenantAdmin } from "@/lib/tenant";
import { getBillingOverview } from "@/lib/actions/billing.actions";
import BillingClient from "./BillingClient";

export const dynamic = "force-dynamic";

export const metadata = { title: "Billing & Plan | MaaCash" };

/** Business owner subscription and billing. Server resolves the tenant first. */
export default async function BillingPage() {
  await requireTenantAdmin();
  const overview = await getBillingOverview();
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <BillingClient overview={overview} />
    </div>
  );
}
