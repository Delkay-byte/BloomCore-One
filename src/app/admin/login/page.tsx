import { redirect } from "next/navigation";
import { getAdminSession, isSessionCurrent } from "@/lib/auth";
import AdminLoginForm from "./AdminLoginForm";

export const dynamic = "force-dynamic";

// An already-authenticated administrator opening the login page should be sent
// straight to the dashboard — not shown the login form again (no redirect loop,
// since the dashboard layout does not redirect back here).
export default async function AdminLoginPage() {
  const session = await getAdminSession();
  if (session && (await isSessionCurrent(session))) {
    redirect(
      session.forcePasswordReset
        ? "/admin/first-login"
        : "/admin/dashboard"
    );
  }
  return <AdminLoginForm />;
}
