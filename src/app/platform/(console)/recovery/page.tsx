import { requirePlatformPage } from "@/lib/platform-auth";
import AdminRecoveryPanel from "@/components/security/AdminRecoveryPanel";

export const metadata = { title: "Account recovery" };

export default async function PlatformRecoveryPage() {
  await requirePlatformPage();
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Account recovery</h1>
        <p className="text-sm text-slate-500 mt-1">
          Issue a one-time recovery code for a business owner or tenant
          administrator, or assist an ordinary account as an escalation path.
        </p>
      </div>
      <div className="card">
        <AdminRecoveryPanel />
      </div>
    </div>
  );
}
