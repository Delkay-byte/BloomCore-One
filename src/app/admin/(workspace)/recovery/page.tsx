import { requireTenantAdmin } from "@/lib/tenant";
import AdminRecoveryPanel from "@/components/security/AdminRecoveryPanel";

export const metadata = { title: "Account recovery" };

export default async function AdminRecoveryPage() {
  await requireTenantAdmin();
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Account recovery</h1>
        <p className="text-sm text-slate-500 mt-1">
          Issue a one-time recovery code for a worker, agent, collector or
          customer in your business. Business owner accounts are recovered by
          the BloomCore platform operator.
        </p>
      </div>
      <div className="card">
        <AdminRecoveryPanel />
      </div>
    </div>
  );
}
