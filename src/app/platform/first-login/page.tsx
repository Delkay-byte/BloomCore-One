import { redirect } from "next/navigation";
import { getPlatformAdminOrNull } from "@/lib/platform-auth";
import FirstLoginPasswordForm from "@/components/FirstLoginPasswordForm";

export const dynamic = "force-dynamic";

/**
 * Standalone first-login password change for platform operators.
 *
 * Lives outside the `(console)` route group so PlatformShell — sidebar, mobile
 * header and sign-out control — is not rendered before the forced change. The
 * console layout redirects here instead of to a page it also wraps, which
 * removes the previous redirect loop.
 */
export default async function PlatformFirstLoginPage() {
  const session = await getPlatformAdminOrNull();
  if (!session) redirect("/platform/login");
  if (!session.forcePasswordReset) redirect("/platform/dashboard");

  return (
    <FirstLoginPasswordForm
      mode="platform"
      fullName={session.fullName || "Platform Operator"}
      email={session.email}
      roleLabel="Platform Operator"
      dashboardPath="/platform/dashboard"
    />
  );
}
