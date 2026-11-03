import { requirePlatformPage } from "@/lib/platform-auth";
import {
  getZeliPlatformOverview,
  listZeliTenants,
} from "@/lib/actions/zeli-platform.actions";
import {
  getZeliCommerceOverview,
  listZeliPlansForPlatform,
  listZeliSubscriptions,
} from "@/lib/actions/zeli-commerce.actions";
import { getZeliProviderControlState } from "@/lib/actions/zeli-provider.actions";
import ZeliControlCentre from "./ZeliControlCentre";
import ProviderControlPanel from "./ProviderControlPanel";
import CommercePanel from "./CommercePanel";

export const dynamic = "force-dynamic";

/**
 * Platform Super Admin — Zeli control centre.
 *
 * The console layout already requires a platform session. This page never
 * renders inside tenant navigation and exposes no tenant customer or financial
 * records, only entitlement lifecycle and aggregate usage.
 */
export default async function PlatformZeliPage() {
  await requirePlatformPage();
  const [overview, tenants, providerState, commerce, plans, subscriptions] =
    await Promise.all([
      getZeliPlatformOverview(),
      listZeliTenants(""),
      getZeliProviderControlState(),
      getZeliCommerceOverview(),
      listZeliPlansForPlatform(),
      listZeliSubscriptions(""),
    ]);
  return (
    <div className="space-y-6">
      <ZeliControlCentre initialOverview={overview} initialTenants={tenants} />
      <ProviderControlPanel state={providerState} />
      <CommercePanel
        overview={commerce}
        plans={plans}
        subscriptions={subscriptions}
      />
    </div>
  );
}
