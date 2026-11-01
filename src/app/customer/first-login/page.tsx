import { redirect } from "next/navigation";
import { clearAllSessions, getCustomerSession, isSessionCurrent } from "@/lib/auth";
import FirstLoginPasswordForm from "@/components/FirstLoginPasswordForm";

export const dynamic = "force-dynamic";

/**
 * Standalone first-login password change for customers.
 *
 * Lives outside the `(portal)` route group so the customer header, menu and
 * sign-out control are not rendered before the forced change.
 */
export default async function CustomerFirstLoginPage() {
  const session = await getCustomerSession();
  if (!session) redirect("/login?role=customer");
  if (!(await isSessionCurrent(session))) {
    await clearAllSessions();
    redirect("/login?reason=session_expired");
  }
  if (!session.forcePasswordReset) redirect("/customer/dashboard");

  return (
    <FirstLoginPasswordForm
      mode="customer"
      fullName={session.fullName || "Customer"}
      email={session.email}
      roleLabel="Customer"
      dashboardPath="/customer/dashboard"
    />
  );
}
