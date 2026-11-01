import { requireTenantAdmin } from "@/lib/tenant";
import MfaSettings from "@/components/security/MfaSettings";

export const metadata = { title: "Two-factor authentication" };

export default async function AdminMfaSettingsPage() {
  await requireTenantAdmin();
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Account security</h1>
        <p className="text-sm text-slate-500 mt-1">
          Protect administrator access with an authenticator app.
        </p>
      </div>
      <div className="card">
        <MfaSettings />
      </div>
    </div>
  );
}
