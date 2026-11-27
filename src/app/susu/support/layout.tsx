import Link from "next/link";
import AdminWorkspaceShell from "@/components/AdminWorkspaceShell";
import { requireSupportIdentity } from "@/lib/support-access";
import { evaluateZeliAccess, getZeliEntitlement } from "@/lib/zeli/entitlements";
import { getZeliAvailability } from "@/lib/zeli/availability";

export const dynamic = "force-dynamic";

/**
 * Support is available to every Susu staff member. Administrators keep the
 * administration shell so support sits beside the operational pages; collectors
 * and office staff get a small standalone header instead of an administration
 * navigation they cannot use.
 */
export default async function SusuSupportLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireSupportIdentity();

  if (ctx.role === "admin") {
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

  const workspace = ctx.role === "collector" ? "/collector" : "/worker";
  return (
    <div className="min-h-screen bg-brand-50">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-brand-900">{ctx.tenantName}</p>
            <p className="text-xs text-ink-muted">Support</p>
          </div>
          <Link href={workspace} className="btn btn-secondary btn-sm">
            Back to workspace
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}