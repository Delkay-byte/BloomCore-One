import { redirect } from "next/navigation";
import { clearAllSessions, getSusuSession, isSessionCurrent } from "@/lib/auth";
import FirstLoginPasswordForm from "@/components/FirstLoginPasswordForm";

export const dynamic = "force-dynamic";

/**
 * Standalone first-login password change for Susu collectors.
 *
 * Lives outside the `(workspace)` route group so the collector header,
 * workspace switcher and sign-out menu are not rendered before the forced
 * change.
 */
export default async function CollectorFirstLoginPage() {
  const session = await getSusuSession();
  if (!session) redirect("/login?role=susu");
  if (!(await isSessionCurrent(session))) {
    await clearAllSessions();
    redirect("/login?reason=session_expired");
  }
  if (!session.forcePasswordReset) redirect("/collector/dashboard");

  return (
    <FirstLoginPasswordForm
      mode="staff"
      module="susu"
      fullName={session.fullName || "Susu Collector"}
      email={session.email}
      roleLabel="Susu Collector"
      dashboardPath="/collector/dashboard"
    />
  );
}
