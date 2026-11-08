import { db } from "@/lib/db";
import { requireTenantCollector } from "@/lib/tenant";
import CollectorDashboardClient from "./CollectorDashboardClient";

/**
 * Server-resolved Susu collector dashboard.
 *
 * The collector's name, user id and tenant id come from the verified tab
 * session, so the page never asks `/api/auth/me` or `/api/user/[id]` before it
 * can load. The server action still re-derives identity on every call.
 */
export default async function CollectorDashboardPage() {
  const ctx = await requireTenantCollector();
  const user = await db.user.findUnique({
    where: { id: ctx.userId },
    select: { fullName: true },
  });

  return (
    <CollectorDashboardClient
      userId={ctx.userId}
      userName={user?.fullName ?? ctx.tenantName}
      tenantId={ctx.tenantId}
    />
  );
}
