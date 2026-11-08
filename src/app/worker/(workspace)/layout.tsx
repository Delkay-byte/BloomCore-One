import { requireTenantWorker } from "@/lib/tenant";
import { getZeliAvailability } from "@/lib/zeli/availability";
import WorkerShell from "./WorkerShell";

/**
 * MoMo workspace layout.
 *
 * Identity, tenant name and Zeli availability are resolved on the server from
 * this tab's verified session. Nothing here asks the browser to re-fetch
 * `/api/auth/me`, so a slow service-worker credential attach can no longer blank
 * the workspace header or lose the tenant.
 */
export default async function WorkerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireTenantWorker();
  const zeliEnabled = (await getZeliAvailability()).enabled;
  const bothModules =
    ctx.modules.includes("momo") && ctx.modules.includes("susu");

  return (
    <WorkerShell
      tenantName={ctx.tenantName}
      zeliEnabled={zeliEnabled}
      bothModules={bothModules}
    >
      {children}
    </WorkerShell>
  );
}
