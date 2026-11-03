"use server";

import {
  getApiZeliAnalyticsContext,
  requireZeliAnalyticsContext,
} from "@/lib/zeli/entitlements";
import {
  buildAnalyticsSnapshot,
  refreshZeliAnalyticsForTenant,
  type AnalyticsFilters,
  type AnalyticsSnapshot,
} from "@/lib/zeli/intelligence/metrics";
import { detectInsights, recommendationsFrom, type Insight } from "@/lib/zeli/intelligence/insights";
import {
  explainChart,
  isExplainableChart,
  type ComposedAnswer,
  type ExplainableChartId,
} from "@/lib/zeli/intelligence/compose";
import { PeriodValidationError, type PeriodPreset } from "@/lib/zeli/intelligence/period";
import { isRedirectError } from "@/lib/errors";

export interface AnalyticsActionResponse<T> {
  success: boolean;
  error?: string;
  data?: T;
}

export interface AnalyticsDashboardData {
  snapshot: AnalyticsSnapshot;
  insights: Insight[];
  recommendations: ReturnType<typeof recommendationsFrom>;
}

function normalizeFilters(input: {
  period?: string;
  from?: string;
  to?: string;
  locationId?: string;
}): AnalyticsFilters {
  const period = (input.period || "this_month") as PeriodPreset;
  return {
    period,
    from: input.from || undefined,
    to: input.to || undefined,
    locationId: input.locationId && input.locationId !== "all" ? input.locationId : undefined,
  };
}

async function load(
  input: Parameters<typeof normalizeFilters>[0],
  options: { forceRefresh?: boolean } = {}
): Promise<AnalyticsDashboardData> {
  const ctx = await requireZeliAnalyticsContext();
  const tenant = await import("@/lib/db").then(({ db }) =>
    db.businessTenant.findUnique({
      where: { id: ctx.tenantId },
      select: { id: true, name: true, code: true, status: true },
    })
  );
  if (!tenant || tenant.status !== "ACTIVE") {
    throw new Error("This business is not available.");
  }
  const snapshot = await buildAnalyticsSnapshot({
    tenant: { id: tenant.id, name: tenant.name, code: tenant.code },
    filters: normalizeFilters(input),
    forceRefresh: options.forceRefresh,
  });
  const insights = detectInsights(snapshot);
  return { snapshot, insights, recommendations: recommendationsFrom(insights) };
}

/** Read the analytics workspace. Entitlement and role are enforced server-side. */
export async function getZeliAnalyticsDashboard(input: {
  period?: string;
  from?: string;
  to?: string;
  locationId?: string;
}): Promise<AnalyticsActionResponse<AnalyticsDashboardData>> {
  try {
    return { success: true, data: await load(input) };
  } catch (error) {
    if (error instanceof PeriodValidationError) {
      return { success: false, error: error.message };
    }
    if (isRedirectError(error)) throw error;
    return {
      success: false,
      error: "Zeli Business Intelligence could not load the selected period.",
    };
  }
}

/** Force refresh. Never touches financial records. */
export async function refreshZeliAnalyticsNow(input: {
  period?: string;
  from?: string;
  to?: string;
  locationId?: string;
}): Promise<AnalyticsActionResponse<{ refreshedAt: string; period: string }>> {
  try {
    const ctx = await requireZeliAnalyticsContext();
    const result = await refreshZeliAnalyticsForTenant({
      tenantId: ctx.tenantId,
      filters: normalizeFilters(input),
    });
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof PeriodValidationError) {
      return { success: false, error: error.message };
    }
    if (isRedirectError(error)) throw error;
    return {
      success: false,
      error: "The analytics refresh failed. The previous aggregates were kept.",
    };
  }
}

/** Explain one chart from freshly checked server metrics. */
export async function explainZeliChartAction(params: {
  chartId: string;
  period?: string;
  from?: string;
  to?: string;
  locationId?: string;
}): Promise<AnalyticsActionResponse<ComposedAnswer>> {
  try {
    await requireZeliAnalyticsContext();
    if (!isExplainableChart(params.chartId)) {
      return { success: false, error: "Unknown chart." };
    }
    const data = await load({
      period: params.period,
      from: params.from,
      to: params.to,
      locationId: params.locationId,
    });
    return {
      success: true,
      data: explainChart(data.snapshot, params.chartId as ExplainableChartId),
    };
  } catch (error) {
    if (error instanceof PeriodValidationError) {
      return { success: false, error: error.message };
    }
    if (isRedirectError(error)) throw error;
    return { success: false, error: "Zeli could not explain this chart." };
  }
}

/**
 * Non-redirecting check used by API routes. Returns null for unauthenticated,
 * non-admin, unentitled or expired callers. No analytics query runs first.
 */
export async function getAnalyticsApiContext() {
  return getApiZeliAnalyticsContext();
}
