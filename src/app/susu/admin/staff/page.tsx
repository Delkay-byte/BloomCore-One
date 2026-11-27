import { requireTenantAdminSusu } from "@/lib/tenant";
import { isCompanyWideAdmin } from "@/lib/branch";
import { getStaffLifecycleOverview } from "@/lib/actions/susu-staff-lifecycle.actions";
import StaffLifecycleBoard from "./_components/StaffLifecycleBoard";

export const metadata = { title: "Staff & access — MaaCash Susu" };
export const dynamic = "force-dynamic";

/**
 * Susu staff lifecycle. Capabilities, module grants and password actions remain
 * on /admin/staff/[id]; this page owns joining, branch access, role changes and
 * offboarding, with a pre-flight readiness check before any consequence.
 *
 * Staff moves are company-wide: a branch-limited administrator is shown an
 * explanation instead of the tenant directory.
 */
export default async function SusuStaffPage() {
  const ctx = await requireTenantAdminSusu();
  if (!(await isCompanyWideAdmin(ctx))) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold text-brand-900">Staff &amp; access</h1>
          <p className="text-sm text-ink-muted">
            Offboarding, reactivation and branch moves touch the whole business.
          </p>
        </header>
        <section className="card p-6">
          <h2 className="text-base font-semibold text-brand-900">Company-wide access required</h2>
          <p className="mt-2 text-sm text-ink-muted">
            Staff administration is limited to company-wide administrators. Ask an administrator
            with company-wide access to make this change, or ask platform support to review the
            account.
          </p>
        </section>
      </div>
    );
  }
  const overview = await getStaffLifecycleOverview();
  return <StaffLifecycleBoard initial={overview} />;
}
