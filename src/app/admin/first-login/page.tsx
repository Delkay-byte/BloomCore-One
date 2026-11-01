import { redirect } from "next/navigation";
import { clearAllSessions, getAdminSession, isSessionCurrent } from "@/lib/auth";
import FirstLoginPasswordForm from "@/components/FirstLoginPasswordForm";

export const dynamic = "force-dynamic";

/**
 * Standalone first-login password change for tenant administrators.
 *
 * This route sits outside the `(workspace)` route group, so AppShell — the
 * sidebar, mobile header and sign-out control — is never rendered before the
 * administrator has completed the forced password change.
 */
export default async function AdminFirstLoginPage() {
  const session = await getAdminSession();
  if (!session) redirect("/admin/login");
  if (!(await isSessionCurrent(session))) {
    await clearAllSessions();
    redirect("/login?reason=session_expired");
  }
  if (!session.forcePasswordReset) redirect("/admin/dashboard");

  return (
    <FirstLoginPasswordForm
      mode="staff"
      module="admin"
      fullName={session.fullName || "Administrator"}
      email={session.email}
      roleLabel="Administrator"
      dashboardPath="/admin/dashboard"
    />
  );
}
