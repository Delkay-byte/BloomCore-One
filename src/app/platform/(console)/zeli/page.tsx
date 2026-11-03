import { requirePlatformPage } from "@/lib/platform-auth";
import {
  getZeliPlatformOverview,
  listZeliTenants,
} from "@/lib/actions/zeli-platform.actions";
import ZeliControlCentre from "./ZeliControlCentre";

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
  const [overview, tenants] = await Promise.all([
    getZeliPlatformOverview(),
    listZeliTenants(""),
  ]);
  return <ZeliControlCentre initialOverview={overview} initialTenants={tenants} />;
}
