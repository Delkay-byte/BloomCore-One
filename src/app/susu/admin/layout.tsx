import { requireTenantAdminSusu } from "@/lib/tenant";
import { evaluateZeliAccess, getZeliEntitlement } from "@/lib/zeli/entitlements";
import { getZeliAvailability } from "@/lib/zeli/availability";
import AdminWorkspaceShell from "@/components/AdminWorkspaceShell";

/**
 * Susu administration workspace. It shares the tenant-administration shell with
 * `/admin/*` but requires the administrator role AND the Susu entitlement.
 */
export default async function SusuAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireTenantAdminSusu();
  const [entitlement, availability] = await Promise.all([
    getZeliEntitlement(ctx.tenantId),
    getZeliAvailability(),
  ]);
  const analytics = evaluateZeliAccess({ role: ctx.role, entitlement });

  return (
    <AdminWorkspaceShell
      tenantName={ctx.tenantName}
      momoEnabled={ctx.momoEnabled}
      susuEnabled={ctx.susuEnabled}
      analytics={Boolean(analytics?.allowed)}
      zeliEnabled={availability.enabled}
    >
      {children}
    </AdminWorkspaceShell>
  );
}
