import { requireTenantCollector } from "@/lib/tenant";
import { getZeliAvailability } from "@/lib/zeli/availability";
import CollectorShell from "./CollectorShell";

/**
 * Susu collector workspace layout. The collector's business and Zeli
 * availability are resolved from this tab's verified server session.
 */
export default async function CollectorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireTenantCollector();
  const zeliEnabled = (await getZeliAvailability()).enabled;
  const bothModules =
    ctx.modules.includes("momo") && ctx.modules.includes("susu");

  return (
    <CollectorShell
      tenantName={ctx.tenantName}
      zeliEnabled={zeliEnabled}
      bothModules={bothModules}
    >
      {children}
    </CollectorShell>
  );
}
