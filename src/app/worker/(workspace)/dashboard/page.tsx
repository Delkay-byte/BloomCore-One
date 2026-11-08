import { db } from "@/lib/db";
import { requireTenantWorker } from "@/lib/tenant";
import WorkerDashboardClient, { type DailyAccountView } from "./WorkerDashboardClient";

/**
 * Server-resolved MoMo dashboard.
 *
 * Everything the first paint needs — the agent's name, their location, and the
 * recent accounts — comes from the tab's verified session. The previous version
 * first called `/api/auth/me?module=momo` and then `/api/user/[id]` in the
 * browser, so a slow or failed credential attach left the page without a
 * location id and the "Start daily account" action silently did nothing.
 */
export default async function WorkerDashboardPage() {
  const ctx = await requireTenantWorker();

  const [worker, accounts] = await Promise.all([
    db.user.findUnique({
      where: { id: ctx.userId },
      select: {
        fullName: true,
        locationId: true,
        location: { select: { name: true } },
      },
    }),
    db.dailyAccount.findMany({
      where: { workerId: ctx.userId, tenantId: ctx.tenantId },
      select: {
        id: true,
        businessDate: true,
        status: true,
        calculatedDifference: true,
        differenceStatus: true,
        calculatedMomoVariance: true,
        calculatedCashVariance: true,
        location: { select: { name: true } },
      },
      orderBy: { businessDate: "desc" },
      take: 30,
    }),
  ]);

  const views: DailyAccountView[] = accounts.map((account) => ({
    id: account.id,
    businessDate: account.businessDate.toISOString(),
    status: account.status,
    calculatedDifference: Number(account.calculatedDifference ?? 0),
    differenceStatus: String(account.differenceStatus ?? ""),
    calculatedMomoVariance: Number(account.calculatedMomoVariance ?? 0),
    calculatedCashVariance: Number(account.calculatedCashVariance ?? 0),
    location: { name: account.location.name },
  }));

  return (
    <WorkerDashboardClient
      userName={worker?.fullName ?? ""}
      locationId={worker?.locationId ?? null}
      locationName={worker?.location?.name ?? null}
      accounts={views}
    />
  );
}
