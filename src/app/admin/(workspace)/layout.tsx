import { requireTenantAdmin } from "@/lib/tenant";
import { evaluateZeliAccess, getZeliEntitlement } from "@/lib/zeli/entitlements";
import { getZeliAvailability } from "@/lib/zeli/availability";
import AdminWorkspaceShell from "@/components/AdminWorkspaceShell";

/**
 * Administration workspace layout.
 *
 * Entitlement, analytics access and Zeli availability are resolved from the
 * administrator's verified server session. The client shell only renders what
 * the server authorised; every page and action re-checks independently.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireTenantAdmin();
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
