"use client";
import { SkeletonPage } from "@/components/ui/Skeletons";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getWorkerDailyAccounts, createDailyAccount } from "@/lib/actions/daily-account.actions";
import { formatDate, getGreeting, getTodayString, getDailyQuote } from "@/lib/utils";
import Link from "next/link";
import CediAmount from "@/components/CediAmount";
import { resolveStoredDifference } from "@/lib/momo-reconciliation";

interface DailyAccount {
  id: string; businessDate: Date; status: string;
  calculatedDifference: number; differenceStatus: string;
  calculatedMomoVariance?: number; calculatedCashVariance?: number;
  location: { name: string };
}

interface UserInfo { userId: string; email: string; role: string; locationId?: string; }
interface FullUser { id: string; fullName: string; email: string; location?: { id: string; name: string; code: string } | null; locationId?: string; }

export default function WorkerDashboardPage() {
  const handleRedirect = useRedirectHandler();
  const router = useRouter();
  const [userName, setUserName] = useState("");
  const [locationName, setLocationName] = useState("");
  const [accounts, setAccounts] = useState<DailyAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [locationId, setLocationId] = useState("");
  const [quote] = useState(() => getDailyQuote("momo"));

  async function loadData() {
    try {
      // Get user info via API
      const authRes = await fetch("/api/auth/me?module=momo");
      const authUser: UserInfo | null = authRes.ok ? await authRes.json() : null;

      if (authUser?.userId) {
        // User profile and daily accounts are independent — load them together
        // instead of one after the other.
        const [userRes, accountsData] = await Promise.all([
          fetch(`/api/user/${authUser.userId}`),
          getWorkerDailyAccounts(),
        ]);
        const fullUser: FullUser | null = userRes.ok ? await userRes.json() : null;
        if (fullUser) {
          setUserName(fullUser.fullName);
          setLocationName(fullUser.location?.name || "");
          setLocationId(fullUser.locationId || "");
        }
        setAccounts(accountsData as unknown as DailyAccount[]);
      } else {
        const accountsData = await getWorkerDailyAccounts();
        setAccounts(accountsData as unknown as DailyAccount[]);
      }
    } catch (err) { if (handleRedirect(err, setError, "Failed to load dashboard")) return; }
    finally { setLoading(false); }
  }

  useEffect(() => { loadData(); }, []);

  async function handleCreateAccount() {
    if (!locationId) return;
    setCreating(true); setError("");
    try {
      const today = getTodayString();
      const result = await createDailyAccount(locationId, today);
      if (result.success) {
        const account = result.data as { id: string };
        router.push(`/worker/daily/${account.id}`);
      } else { setError(result.error || "Failed to create daily account"); }
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return; }
    finally { setCreating(false); }
  }

  if (loading) return <SkeletonPage variant="dashboard" />;

  const todayAccount = accounts.find((a) => new Date(a.businessDate).toISOString().split("T")[0] === getTodayString());

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl p-6 shadow-sm border border-slate-100">
        <h1 className="text-2xl font-bold text-slate-900">{getGreeting()}, {userName || "Worker"}! 👋</h1>
        {locationName && <p className="text-slate-500 mt-1">Location: <span className="font-medium text-slate-700">{locationName}</span></p>}
        <p className="text-sm text-green-600 italic mt-1">&ldquo;{quote}&rdquo;</p>
      </div>

      {error && <div role="alert" className="banner banner-error text-sm">{error}</div>}

      <div className="bg-white rounded-xl p-6 shadow-sm border border-slate-100">
        <h2 className="text-lg font-semibold mb-1">Today&apos;s Account</h2>
        <p className="text-sm text-slate-500 mb-4">Open your account in the morning, record today&apos;s customer deposit, cash out, airtime sales and any additional funding, then count your cash and confirm your MoMo float before submitting.</p>
        {todayAccount ? (
          <div>
            <div className="flex items-center justify-between mb-4">
              <span className={`badge ${todayAccount.status === "submitted" ? "badge-green" : todayAccount.status === "reviewed" ? "badge-blue" : "badge-yellow"}`}>{todayAccount.status === "draft" ? "Draft Saved" : todayAccount.status === "submitted" ? "Submitted" : todayAccount.status === "reviewed" ? "Reviewed" : todayAccount.status}</span>
              {todayAccount.status === "draft" && <Link href={`/worker/daily/${todayAccount.id}`} className="btn btn-primary btn-sm">Continue →</Link>}
            </div>
            {todayAccount.status !== "draft" && (
              <div className="text-center py-4 text-slate-500"><p className="text-2xl mb-2">✅</p><p className="font-medium">Today&apos;s account has been submitted</p></div>
            )}
          </div>
        ) : (
          <div className="text-center py-6">
            <p className="text-slate-500 mb-4">No account opened for today yet</p>
            <button onClick={handleCreateAccount} className="btn btn-primary" disabled={creating}>
              {creating ? <span className="flex items-center gap-2"><span className="spinner"></span>Opening...</span> : "Start Daily Account"}
            </button>
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl p-6 shadow-sm border border-slate-100">
        <h2 className="text-lg font-semibold mb-4">Recent Reports</h2>
        {accounts.length === 0 ? (
          <div className="text-center py-6 text-slate-500"><p className="text-3xl mb-2">📋</p><p>No reports yet</p></div>
        ) : (
          <div className="space-y-2">
            {accounts.slice(0, 10).map((account) => {
              const stored = resolveStoredDifference(account);
              const difference = stored.difference;
              const shortage = stored.status === "shortage";
              return (
                <Link key={account.id} href={`/worker/daily/${account.id}`} className="flex items-center justify-between p-3 rounded-lg hover:bg-slate-50 border border-slate-100 transition-colors">
                  <div className="font-medium text-sm">{formatDate(account.businessDate)}</div>
                  <div className="text-right">
                    <span className={`badge ${account.status === "submitted" ? "badge-green" : account.status === "reviewed" ? "badge-blue" : "badge-yellow"}`}>{account.status === "draft" ? "Draft Saved" : account.status === "submitted" ? "Submitted" : account.status === "reviewed" ? "Reviewed" : account.status}</span>
                    {account.status !== "draft" && (
                      <div className="text-xs mt-1">
                        {difference === 0 ? (
                          <span className="text-green-600">✓ Balanced</span>
                        ) : shortage ? (
                          <span className="text-red-600">
                            Short <CediAmount amount={Math.abs(difference)} />
                            <br />⚠ Explanation required
                          </span>
                        ) : (
                          <span className="text-green-600">
                            Positive difference <CediAmount amount={difference} showSign />
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
