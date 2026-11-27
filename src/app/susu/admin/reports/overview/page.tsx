"use client";
import { SkeletonTable } from "@/components/ui/Skeletons";
import Notice from "@/components/ui/Notice";

import { useEffect, useState } from "react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { getSusuOverview } from "@/lib/actions/susu-reporting.actions";
import { formatCedi } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";
import { Receipt } from "lucide-react";

interface BranchComparison {
  branchId: string;
  branchName: string;
  contributions: number;
  remittancesDeclared: number;
  remittancesReceived: number;
  outstanding: number;
}

interface OverviewData {
  contributions: { grossRecorded: number; reversedAmount: number; netAmount: number; count: number };
  outstandingBalances: number;
  remittanceActivity: { declared: number; received: number; verified: number; count: number };
  unresolvedExceptions: number;
  branchComparisons: BranchComparison[];
}

export default function SusuOverviewPage() {
  const handleRedirect = useRedirectHandler();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState<OverviewData | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const result = await getSusuOverview();
        if (cancelled) return;
        if (!result.success) {
          if (handleRedirect(new Error("UNAUTHENTICATED"), setError, "Failed to load overview")) return;
          return;
        }
        setData(result.data ?? null);
      } catch {
        if (!cancelled) setError("Failed to load overview");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Susu Management Overview</h1>
          <p className="text-slate-500 mt-1">Operational and financial position across the Susu book</p>
        </div>
      </div>

      {error && (
        <Notice type="error" className="mb-4" message={error}>
          {error}
        </Notice>
      )}

      {loading ? (
        <SkeletonTable rows={6} columns={4} />
      ) : !data ? (
        <Notice type="error" className="mb-4" message="Failed to load overview" />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="card">
              <h3 className="text-sm font-semibold text-slate-500">Contributions recorded</h3>
              <p className="mt-2 text-2xl font-bold text-slate-900">
                <CediAmount amount={data.contributions?.grossRecorded ?? 0} />
              </p>
              <p className="text-xs text-slate-500">Net after reversals: <CediAmount amount={data.contributions?.netAmount ?? 0} /></p>
            </div>
            <div className="card">
              <h3 className="text-sm font-semibold text-slate-500">Outstanding balances</h3>
              <p className="mt-2 text-2xl font-bold text-slate-900">
                <CediAmount amount={data.outstandingBalances ?? 0} />
              </p>
              <p className="text-xs text-slate-500">Unresolved exceptions: {data.unresolvedExceptions ?? 0}</p>
            </div>
            <div className="card">
              <h3 className="text-sm font-semibold text-slate-500">Remittances</h3>
              <p className="mt-2 text-2xl font-bold text-slate-900">
                <CediAmount amount={data.remittanceActivity?.declared ?? 0} />
              </p>
              <p className="text-xs text-slate-500">Declared / received / verified</p>
            </div>
          </div>

          <div className="card">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Receipt size={18} aria-hidden /> Branch comparisons
            </h2>
            {data.branchComparisons?.length ? (
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>Branch</th>
                      <th>Contributions</th>
                      <th>Remittances declared</th>
                      <th>Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.branchComparisons.map((b) => (
                      <tr key={b.branchId}>
                        <td className="text-sm font-medium">{b.branchName}</td>
                        <td className="font-mono"><CediAmount amount={b.contributions ?? 0} /></td>
                        <td className="font-mono"><CediAmount amount={b.remittancesDeclared ?? 0} /></td>
                        <td className="font-mono"><CediAmount amount={b.outstanding ?? 0} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-slate-500">No branch data available for this period.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
