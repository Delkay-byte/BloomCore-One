"use client";
import { SkeletonPage } from "@/components/ui/Skeletons";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getDailyAccountById, reviewDailyAccount } from "@/lib/actions/daily-account.actions";
import { resolveStoredDifference, statusLabel } from "@/lib/momo-reconciliation";
import { formatDate, formatDateTime } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";

interface AccountDetail {
  id: string; businessDate: Date; status: string; submittedAt?: Date | null; reviewedAt?: Date | null;
  openingMomoFloat: number; openingCash: number;
  additionalCashReceived: number; additionalMomoFloat: number;
  totalCashIn: number; totalCashOut: number; totalAirtimeSold: number;
  commission: number; debtsCollected: number; totalExpenses: number;
  closingMomoFloat: number; closingCash: number;
  calculatedDifference: number; differenceStatus: string;
  reconciliationNote?: string | null;
  location: { id: string; name: string; code: string; address?: string | null; contactPhone?: string | null };
  worker: { id: string; fullName: string; email: string; phone?: string | null };
  expenses: Array<{ id: string; description: string; amount: number }>;
}

export default function ReportDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [account, setAccount] = useState<AccountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const handleRedirect = useRedirectHandler();

  useEffect(() => { loadAccount(); }, [params.id]);

  async function loadAccount() {
    try { const data = await getDailyAccountById(params.id as string); setAccount(data as unknown as AccountDetail); }
    catch { setError("Failed to load report"); } finally { setLoading(false); }
  }

  async function handleReview() {
    if (!account) return;
    setReviewing(true);
    try {
      const result = await reviewDailyAccount(account.id);
      if (result.success) { setSuccess("Report reviewed successfully"); loadAccount(); }
      else setError(result.error || "Failed to review report");
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return; } finally { setReviewing(false); }
  }

  if (loading) return <SkeletonPage variant="detail" />;
  if (!account) return <div className="text-center py-20"><p className="text-slate-500">Report not found</p><button onClick={() => router.push("/admin/reports")} className="btn btn-primary mt-4">Back to Reports</button></div>;

  const stored = resolveStoredDifference(account);
  const difference = stored.difference;
  // Historical rows keep their stored difference. Deriving expected from
  // actual minus the stored difference avoids recalculating an old record with
  // the simplified formula.
  const actualClosing =
    Number(account.closingCash) + Number(account.closingMomoFloat);
  const expectedClosing = actualClosing - difference;
  const hasLegacyActivity =
    Number(account.totalCashIn) !== 0 ||
    Number(account.totalCashOut) !== 0 ||
    Number(account.totalAirtimeSold) !== 0 ||
    Number(account.additionalCashReceived) !== 0 ||
    Number(account.additionalMomoFloat) !== 0;
  const differenceLabel = statusLabel(stored.status);
  const differenceTone =
    stored.status === "shortage" ? "text-red-600" : "text-green-600";

  return (
    <div>
      <div className="mb-8">
        <button onClick={() => router.push("/admin/reports")} className="text-sm text-slate-500 hover:text-slate-700 mb-2 inline-block">← Back to Reports</button>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Daily Report — {formatDate(account.businessDate)}</h1>
            <p className="text-slate-500 mt-1">{account.location.name} ({account.location.code}) &bull; {account.worker.fullName}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`badge ${account.status === "submitted" ? "badge-green" : account.status === "reviewed" ? "badge-blue" : "badge-yellow"}`}>{account.status === "draft" ? "Draft Saved" : account.status === "submitted" ? "Submitted" : account.status === "reviewed" ? "Reviewed" : account.status}</span>
            {account.status === "submitted" && <button onClick={handleReview} className="btn btn-primary btn-sm" disabled={reviewing}>{reviewing ? "Reviewing..." : "✓ Mark as Reviewed"}</button>}
          </div>
        </div>
      </div>

      {error && <div role="alert" className="banner banner-error mb-4">{error}</div>}
      {success && <div role="status" className="banner banner-success mb-4">{success}</div>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="card"><div className="text-sm text-slate-500">Business Date</div><div className="font-medium">{formatDate(account.businessDate)}</div></div>
        <div className="card"><div className="text-sm text-slate-500">Submitted At</div><div className="font-medium">{account.submittedAt ? formatDateTime(account.submittedAt) : "Not submitted"}</div></div>
        <div className="card"><div className="text-sm text-slate-500">Reviewed At</div><div className="font-medium">{account.reviewedAt ? formatDateTime(account.reviewedAt) : "Not reviewed"}</div></div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="font-semibold mb-4">Balances</h3>
          <div className="space-y-4">
            <div>
              <h4 className="text-sm font-medium text-slate-500 mb-2">Starting Balances</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-blue-50 rounded-lg p-3"><div className="text-xs text-blue-600">MoMo Balance</div><div className="font-semibold text-blue-800"><CediAmount amount={account.openingMomoFloat} /></div></div>
                <div className="bg-green-50 rounded-lg p-3"><div className="text-xs text-green-600">Cash on Hand</div><div className="font-semibold text-green-800"><CediAmount amount={account.openingCash} /></div></div>
              </div>
            </div>
            <div>
              <h4 className="text-sm font-medium text-slate-500 mb-2">Ending Balances</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-blue-50 rounded-lg p-3"><div className="text-xs text-blue-600">MoMo Balance</div><div className="font-semibold text-blue-800"><CediAmount amount={account.closingMomoFloat} /></div></div>
                <div className="bg-green-50 rounded-lg p-3"><div className="text-xs text-green-600">Cash on Hand</div><div className="font-semibold text-green-800"><CediAmount amount={account.closingCash} /></div></div>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 className="font-semibold mb-4">Daily Business Totals</h3>
          <div className="space-y-2">
            <div className="flex justify-between"><span className="text-sm text-slate-600">Debts Collected</span><span className="font-mono text-sm"><CediAmount amount={account.debtsCollected} /></span></div>
            <div className="flex justify-between"><span className="text-sm text-slate-600">Commission</span><span className="font-mono text-sm"><CediAmount amount={account.commission} /></span></div>
            <div className="flex justify-between"><span className="text-sm text-slate-600">Expenses</span><span className="font-mono text-sm text-red-700"><CediAmount amount={account.totalExpenses} /></span></div>
            {hasLegacyActivity && (
              <details className="pt-2">
                <summary className="cursor-pointer text-xs font-medium text-slate-500">
                  Historical transaction totals (read-only legacy record)
                </summary>
                <div className="mt-2 space-y-2 border-t pt-2">
                  <div className="flex justify-between"><span className="text-xs text-slate-500">Customer deposit (Cash in)</span><span className="font-mono text-xs"><CediAmount amount={account.totalCashIn} /></span></div>
                  <div className="flex justify-between"><span className="text-xs text-slate-500">Cash out</span><span className="font-mono text-xs"><CediAmount amount={account.totalCashOut} /></span></div>
                  <div className="flex justify-between"><span className="text-xs text-slate-500">Airtime sold</span><span className="font-mono text-xs"><CediAmount amount={account.totalAirtimeSold} /></span></div>
                  <div className="flex justify-between"><span className="text-xs text-slate-500">Additional cash received</span><span className="font-mono text-xs"><CediAmount amount={account.additionalCashReceived} /></span></div>
                  <div className="flex justify-between"><span className="text-xs text-slate-500">Additional MoMo float received</span><span className="font-mono text-xs"><CediAmount amount={account.additionalMomoFloat} /></span></div>
                </div>
              </details>
            )}
          </div>
        </div>

        <div className="card">
          <h3 className="font-semibold mb-4">Account Check</h3>
          <div className="space-y-3">
            <div className="bg-slate-50 rounded-lg p-3">
              <div className="text-sm text-slate-600 mb-1">Expected closing accountability</div>
              <div className="text-lg font-bold text-slate-900"><CediAmount amount={expectedClosing} /></div>
              <div className="text-xs text-slate-500 mt-1">Opening cash + E-cash + debts collected + commission − expenses</div>
            </div>
            <div className="bg-slate-50 rounded-lg p-3">
              <div className="text-sm text-slate-600 mb-1">Actual closing accountability</div>
              <div className="text-lg font-bold text-slate-900"><CediAmount amount={actualClosing} /></div>
              <div className="text-xs text-slate-500 mt-1">Closing cash + closing MoMo float</div>
            </div>
            <div className="border-t pt-3">
              <div className="flex justify-between items-center">
                <span className="font-medium">Difference</span>
                <span className={`text-xl font-bold ${differenceTone}`}><CediAmount amount={difference} showSign /></span>
              </div>
              <div className="text-right"><span className={`badge ${stored.status === "shortage" ? "badge-red" : "badge-green"} mt-1`}>{differenceLabel}</span></div>
              {stored.status === "shortage" && account.reconciliationNote && (
                <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">
                  <div className="font-medium">Explanation</div>
                  <p className="mt-1">{account.reconciliationNote}</p>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <h3 className="font-semibold mb-4">Expenses ({account.expenses.length})</h3>
          {account.expenses.length === 0 ? <p className="text-slate-500 text-sm">No expenses recorded.</p> : (
            <div className="space-y-2">
              {account.expenses.map((expense) => (
                <div key={expense.id} className="flex justify-between items-center p-2 rounded-lg bg-slate-50">
                  <span className="text-sm">{expense.description}</span>
                  <span className="font-mono text-sm"><CediAmount amount={expense.amount} /></span>
                </div>
              ))}
              <div className="flex justify-between items-center pt-2 border-t font-medium">
                <span>Total Expenses</span>
                <span className="font-mono"><CediAmount amount={account.totalExpenses} /></span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
