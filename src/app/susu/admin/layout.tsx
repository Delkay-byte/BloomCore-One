import { requireTenantAdminSusu } from "@/lib/tenant";
import { evaluateZeliAccess, getZeliEntitlement } from "@/lib/zeli/entitlements";
import { getZeliAvailability } from "@/lib/zeli/availability";
import AdminWorkspaceShell from "@/components/AdminWorkspaceShell";
import { getBranchesForScope } from "@/lib/actions/branch.actions";
import { resolveBranchScope } from "@/lib/branch";

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
  const [entitlement, availability, branches, scope] = await Promise.all([
    getZeliEntitlement(ctx.tenantId),
    getZeliAvailability(),
    getBranchesForScope(),
    resolveBranchScope(ctx),
  ]);
  const analytics = evaluateZeliAccess({ role: ctx.role, entitlement });
  const scopeLabel =
    scope.kind === "all"
      ? "All branches"
      : branches.map((branch) => branch.name).join(", ") || "No branch assigned";

  return (
    <AdminWorkspaceShell
      tenantName={ctx.tenantName}
      momoEnabled={ctx.momoEnabled}
      susuEnabled={ctx.susuEnabled}
      analytics={Boolean(analytics?.allowed)}
      zeliEnabled={availability.enabled}
    >
      <div
        data-branch-scope={scope.kind}
        className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-white px-4 py-2 text-sm text-ink"
      >
        <span>
          <span className="font-semibold">Branch scope:</span> {scopeLabel}
        </span>
        {scope.kind === "all" ? (
          <a href="/susu/admin/branches" className="font-medium text-brand-700 hover:underline">
            Manage branches
          </a>
        ) : null}
      </div>
      {children}
    </AdminWorkspaceShell>
  );
}
