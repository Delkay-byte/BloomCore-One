import { requireTenantAdminSusu } from "@/lib/tenant";
import { getStaffLifecycleOverview } from "@/lib/actions/susu-staff-lifecycle.actions";
import StaffLifecycleBoard from "./_components/StaffLifecycleBoard";

export const metadata = { title: "Staff & access — MaaCash Susu" };
export const dynamic = "force-dynamic";

/**
 * Susu staff lifecycle. Capabilities, module grants and password actions remain
 * on /admin/staff/[id]; this page owns joining, branch access, role changes and
 * offboarding, with a pre-flight readiness check before any consequence.
 */
export default async function SusuStaffPage() {
  await requireTenantAdminSusu();
  const overview = await getStaffLifecycleOverview();
  return <StaffLifecycleBoard initial={overview} />;
}
