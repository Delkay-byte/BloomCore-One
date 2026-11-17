import { requireTenantAdminSusu } from "@/lib/tenant";
import { listFinancialApprovals } from "@/lib/actions/financial-approval.actions";
import ApprovalsQueue from "@/components/susu/ApprovalsQueue";
import { PageHeader } from "@/components/ui/DataDisplay";

export const metadata = { title: "Financial approvals" };
export const dynamic = "force-dynamic";

/**
 * Residual E: maker-checker queue. A correction requested by one administrator
 * is posted only after a different active administrator approves it here.
 */
export default async function ApprovalsPage() {
  await requireTenantAdminSusu();
  const rows = await listFinancialApprovals();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Financial approvals"
        description="Sensitive corrections and reversals that need a second administrator."
      />
      <ApprovalsQueue initial={rows} />
    </div>
  );
}
