import { redirect } from "next/navigation";
import { getAdminSession, isSessionCurrent } from "@/lib/auth";
import { getTenantContext } from "@/lib/tenant";
import AdminLoginForm from "./AdminLoginForm";

export const dynamic = "force-dynamic";

// An already-authenticated administrator opening the login page is sent to the
// dashboard only when the whole workspace chain still resolves: a live session,
// the correct role, and a business the guard accepts. A stale cookie (revoked
// session, changed password, suspended business) shows the form instead, so the
// page never bounces through the dashboard and back.
export default async function AdminLoginPage() {
  const session = await getAdminSession();
  if (session && session.role === "admin" && (await isSessionCurrent(session))) {
    if (session.forcePasswordReset) redirect("/admin/first-login");
    const ctx = await getTenantContext("admin");
    if (ctx && ctx.role === "admin") redirect("/admin/dashboard");
  }
  return <AdminLoginForm />;
}
