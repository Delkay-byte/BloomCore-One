import { requireTenantAdmin } from "@/lib/tenant";
import { getZeliAnalyticsDashboard } from "@/lib/actions/zeli-analytics.actions";
import AnalyticsDashboard from "./AnalyticsDashboard";
import { getZeliSubscriptionSummary } from "@/lib/actions/zeli-billing.actions";
import { getZeliAvailability } from "@/lib/zeli/availability";
import ZeliUnavailable from "@/components/zeli/ZeliUnavailable";
import type { PeriodPreset } from "@/lib/zeli/intelligence/period";

export const dynamic = "force-dynamic";

/**
 * Zeli Business Intelligence — tenant-admin analytics workspace.
 *
 * The page resolves entitlement before any analytics query. An unentitled
 * business is redirected to the upgrade/denial screen, so direct URL access
 * cannot preload analytics data.
 */
export default async function ZeliAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{
    period?: string;
    from?: string;
    to?: string;
    location?: string;
  }>;
}) {
  await requireTenantAdmin();
  const availability = await getZeliAvailability();
  if (!availability.enabled) {
    return <ZeliUnavailable reason={availability.reason} />;
  }
  const params = await searchParams;
  const period = (params.period || "this_month") as PeriodPreset;
  const result = await getZeliAnalyticsDashboard({
    period,
    from: params.from,
    to: params.to,
    locationId: params.location,
  });
  if (!result.success || !result.data) {
    // A redirect thrown by the guard is re-thrown by the action; a validation
    // error is shown in place rather than redirecting away.
    return (
      <div className="mx-auto max-w-2xl py-16">
        <div className="card bg-white">
          <h1 className="text-lg font-semibold text-slate-900">
            Zeli Business Intelligence could not load
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {result.error ?? "The selected filters are not valid."}
          </p>
          <a
            href="/admin/zeli-analytics"
            className="btn btn-primary btn-sm mt-4 inline-flex"
          >
            Reset filters
          </a>
        </div>
      </div>
    );
  }
  const subscription = await getZeliSubscriptionSummary();
  return (
    <AnalyticsDashboard
      data={result.data}
      subscription={subscription.success ? subscription.data ?? null : null}
      filters={{
        period,
        from: params.from ?? null,
        to: params.to ?? null,
        locationId: params.location ?? null,
      }}
    />
  );
}
