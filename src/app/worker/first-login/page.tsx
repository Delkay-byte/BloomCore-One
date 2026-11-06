import { redirect } from "next/navigation";
import { getMomoSession, isSessionCurrent } from "@/lib/auth";
import FirstLoginPasswordForm from "@/components/FirstLoginPasswordForm";

export const dynamic = "force-dynamic";

/**
 * Standalone first-login password change for MoMo agents.
 *
 * Lives outside the `(workspace)` route group so the worker header, workspace
 * switcher and sign-out menu are not rendered before the forced change.
 */
export default async function WorkerFirstLoginPage() {
  const session = await getMomoSession();
  if (!session) redirect("/login?role=momo");
  if (!(await isSessionCurrent(session))) {
    redirect("/login?reason=session_expired");
  }
  if (!session.forcePasswordReset) redirect("/worker/dashboard");

  return (
    <FirstLoginPasswordForm
      mode="staff"
      module="momo"
      fullName={session.fullName || "MoMo Agent"}
      email={session.email}
      roleLabel="MoMo Agent"
      dashboardPath="/worker/dashboard"
    />
  );
}
