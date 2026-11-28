import { redirect } from "next/navigation";
import { getAdminSession, isSessionCurrent } from "@/lib/auth";
import { getTenantContext } from "@/lib/tenant";
import { billingHref, resolveSubscriptionAccess } from "@/lib/billing/access";
import AdminLoginForm from "./AdminLoginForm";

export const dynamic = "force-dynamic";

/**
 * An already-authenticated administrator is sent to the workspace only when
 * the whole chain still resolves: a live session, the correct role, an open
 * business, and a package state that can actually perform operations.
 *
 * The public role chooser links here with ?switch=1. That is a deliberate
 * sign-in action: it must show the form instead of silently restoring a
 * previous dashboard from another session.
 *
 * A stale cookie, revoked session, suspended business or blocked package never
 * bounces through the dashboard and back. The package state goes to Billing &
 * Plan with its reason so the owner sees a business restriction, not a logout.
 */
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ switch?: string }>;
}) {
  const params = await searchParams;
  const switchingAccount = params.switch === "1";

  if (!switchingAccount) {
    const session = await getAdminSession();
    if (session && session.role === "admin" && (await isSessionCurrent(session))) {
      if (session.forcePasswordReset) redirect("/admin/first-login");
      const ctx = await getTenantContext("admin");
      if (ctx && ctx.role === "admin") {
        const access = await resolveSubscriptionAccess(ctx.tenantId);
        if (access.reason === "tenant_unavailable") {
          // Keep the form visible; the login action refuses the workspace with
          // a clear message rather than issuing another unusable session.
          return <AdminLoginForm />;
        }
        if (!access.operable && access.billingRequired) {
          redirect(billingHref(access.reason));
        }
        redirect("/admin/dashboard");
      }
    }
  }

  return <AdminLoginForm />;
}
