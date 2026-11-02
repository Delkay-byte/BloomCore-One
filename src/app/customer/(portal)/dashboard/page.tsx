"use client";
import { SkeletonPage } from "@/components/ui/Skeletons";

import { useEffect, useState } from "react";
import { getCustomerAccount, getCustomerCycles } from "@/lib/actions/susu-customer.actions";
import { formatDate, formatDateTime } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";

interface CustomerAccount {
  customer: {
    id: string;
    fullName: string;
    customerId: string;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    dailyContribution: number;
    portalEnabled: boolean;
    status: string;
  };
  account: {
    id: string;
    accountId: string;
    dailyContribution: number;
    status: string;
    cardCustody: string;
  };
  currentCycle: {
    id: string;
    cycleNumber: number;
    startDate: Date;
    endDate: Date;
    dailyContribution: number;
    status: string;
    commissionCharged: boolean;
      contributions: Array<{
        id: string;
        amount: number;
        collectionDate: Date;
        channel: string;
        receivedBy?: { fullName: string } | null;
        collector?: { user?: { fullName: string } } | null;
        allocations: Array<{ cycleDay: number }>;
      }>;
    withdrawals: Array<{
      id: string;
      requestedAmount: number;
      commissionAmount: number;
      netAmount: number;
      remainingBalance: number;
      createdAt: Date;
      notes?: string | null;
    }>;
    commissions: Array<{ id: string; amount: number; createdAt: Date }>;
  } | null;
  collector: { fullName: string } | null;
}

interface CycleHistory {
  id: string;
  cycleNumber: number;
  startDate: Date;
  endDate: Date;
  dailyContribution: number;
  status: string;
  totalContributed: number;
  totalWithdrawn: number;
  totalCommissions: number;
  paidDays: number;
  balance: number;
}

export default function CustomerDashboardPage() {
  const [data, setData] = useState<CustomerAccount | null>(null);
  const [cycles, setCycles] = useState<CycleHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadData() {
      try {
        const [accountResult, cyclesResult] = await Promise.all([
          getCustomerAccount(),
          getCustomerCycles(),
        ]);
        setData(accountResult as unknown as CustomerAccount);
        setCycles(cyclesResult as unknown as CycleHistory[]);
      } catch (err) {
        setError("Failed to load account data");
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  if (loading) return <SkeletonPage variant="dashboard" />;

  if (error || !data) {
    return (
      <div className="text-center py-20">
        <p className="text-slate-500">{error || "Unable to load account"}</p>
      </div>
    );
  }

  const { customer, account, currentCycle, collector } = data;

  // Calculate cycle stats
  const totalSaved = currentCycle?.contributions.reduce((sum, c) => sum + Number(c.amount), 0) || 0;
  const totalWithdrawn = currentCycle?.withdrawals.reduce((sum, w) => sum + Number(w.netAmount), 0) || 0;
  const totalCommission = currentCycle?.commissions.reduce((sum, c) => sum + Number(c.amount), 0) || 0;
  const paidDays = new Set(currentCycle?.contributions.flatMap((c) => c.allocations?.map((a: { cycleDay: number }) => a.cycleDay)) || []);
  const daysCovered = paidDays.size;
  const daysOutstanding = Math.max(0, 31 - daysCovered);
  const currentBalance = totalSaved - totalWithdrawn - totalCommission;

  function getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    return "Good evening";
  }

  const quotes = [
    "Consistent saving builds a stronger tomorrow.",
    "Every payment brings you closer to your goals.",
    "Small steps today, big results tomorrow.",
    "Your savings journey matters.",
    "Discipline with money creates freedom.",
  ];
  const quote = quotes[new Date().getDate() % quotes.length];

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl p-6 shadow-sm border border-slate-100">
        <h1 className="text-2xl font-bold text-slate-900">{getGreeting()}, {customer.fullName}</h1>
        <p className="text-sm text-blue-600 italic mt-1">&ldquo;{quote}&rdquo;</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card border-l-4 border-l-green-500">
          <div className="text-sm text-slate-500 mb-1">Current Balance</div>
          <div className="text-3xl font-bold text-green-700"><CediAmount amount={currentBalance} /></div>
        </div>
        <div className="card border-l-4 border-l-blue-500">
          <div className="text-sm text-slate-500 mb-1">Total Saved This Cycle</div>
          <div className="text-3xl font-bold text-blue-700"><CediAmount amount={totalSaved} /></div>
        </div>
        <div className="card border-l-4 border-l-purple-500">
          <div className="text-sm text-slate-500 mb-1">Commission Charged</div>
          <div className="text-3xl font-bold text-purple-700"><CediAmount amount={totalCommission} /></div>
        </div>
      </div>

      {currentCycle && (
        <div className="card border-l-4 border-l-indigo-500">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-indigo-700">Current 31-Day Cycle</h2>
            <span className={`badge ${currentCycle.status === "active" ? "badge-green" : "badge-blue"}`}>
              Cycle {currentCycle.cycleNumber}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div className="bg-slate-50 rounded-lg p-3 text-center">
              <div className="text-xs text-slate-500">Daily Contribution</div>
              <div className="font-semibold"><CediAmount amount={currentCycle.dailyContribution} />/day</div>
            </div>
            <div className="bg-emerald-50 rounded-lg p-3 text-center">
              <div className="text-xs text-emerald-600">Days Covered</div>
              <div className="font-semibold text-lg">{daysCovered}/31</div>
            </div>
            <div className="bg-yellow-50 rounded-lg p-3 text-center">
              <div className="text-xs text-yellow-600">Days Outstanding</div>
              <div className="font-semibold text-lg">{daysOutstanding}</div>
            </div>
            <div className="bg-orange-50 rounded-lg p-3 text-center">
              <div className="text-xs text-orange-600">Total Withdrawn</div>
              <div className="font-semibold"><CediAmount amount={totalWithdrawn} /></div>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-sm text-slate-500">Cycle Period</div>
              <div className="font-medium">{formatDate(currentCycle.startDate)} – {formatDate(currentCycle.endDate)}</div>
            </div>
            <div>
              <div className="text-sm text-slate-500">Card Status</div>
              <div className="font-medium capitalize">{account.cardCustody}</div>
            </div>
            <div>
              <div className="text-sm text-slate-500">Current Collector</div>
              <div className="font-medium">{collector?.fullName || "No collector assigned"}</div>
            </div>
            <div>
              <div className="text-sm text-slate-500">Commission Status</div>
              <div className="font-medium">
                {totalCommission > 0 ? <CediAmount amount={totalCommission} /> : "Not yet charged"}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Recent Payments</h3>
            <a href="/customer/payments" className="text-sm text-brand-700 hover:text-brand-800">View all →</a>
          </div>
          {currentCycle?.contributions.length ? (
            <div className="space-y-2">
              {currentCycle.contributions.slice(0, 5).map((c) => (
                <div key={c.id} className="flex justify-between items-center p-2 rounded bg-slate-50">
                   <div className="text-sm">
                     <span className="font-medium">{formatDate(c.collectionDate)}</span>
                     <span className="text-slate-400 ml-2">
                       {c.channel === "collector" ? "Paid to Collector" : "Paid at Office"}
                     </span>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {c.channel === "collector"
                          ? `Collected by ${c.collector?.user?.fullName || "—"}`
                          : `Received by ${(c as { receivedByName?: string | null }).receivedByName || c.receivedBy?.fullName || "—"}`}
                      </div>
                   </div>
                  <span className="font-mono font-semibold text-green-700"><CediAmount amount={c.amount} /></span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-slate-500 text-sm text-center py-4">No payments recorded yet</p>
          )}
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Recent Withdrawals</h3>
            <a href="/customer/withdrawals" className="text-sm text-brand-700 hover:text-brand-800">View all →</a>
          </div>
          {currentCycle?.withdrawals.length ? (
            <div className="space-y-2">
              {currentCycle.withdrawals.slice(0, 5).map((w) => (
                <div key={w.id} className="flex justify-between items-center p-2 rounded bg-orange-50">
                  <div className="text-sm">
                    <span className="font-medium">{formatDate(w.createdAt)}</span>
                    {w.commissionAmount > 0 && (
                      <span className="text-orange-600 ml-2 text-xs">(incl. <CediAmount amount={w.commissionAmount} /> commission)</span>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="font-mono font-semibold text-orange-700"><CediAmount amount={w.netAmount} /></div>
                    <div className="text-xs text-slate-500">Balance: <CediAmount amount={w.remainingBalance} /></div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-slate-500 text-sm text-center py-4">No withdrawals recorded</p>
          )}
        </div>
      </div>

      <div className="card border border-dashed border-slate-300">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-lg">💳</span>
          <h3 className="font-semibold text-slate-700">My Susu Card</h3>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div>
            <div className="text-slate-500">Customer ID</div>
            <div className="font-mono font-semibold">{customer.customerId}</div>
          </div>
          <div>
            <div className="text-slate-500">Daily Contribution</div>
            <div className="font-semibold"><CediAmount amount={customer.dailyContribution} />/day</div>
          </div>
          <div>
            <div className="text-slate-500">Current Cycle</div>
            <div className="font-semibold">Cycle {currentCycle?.cycleNumber || "—"}</div>
          </div>
          <div>
            <div className="text-slate-500">Days Covered (Digital)</div>
            <div className="font-semibold">{daysCovered}/31</div>
          </div>
        </div>
        <p className="text-xs text-slate-500 mt-3">
          Compare with your physical Susu card. Digital ledger is authoritative.
        </p>
      </div>

      {/* Cycle History */}
      {cycles.length > 0 && (
        <div className="card">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">Cycle History</h2>
          <div className="space-y-3">
            {cycles.map((cycle) => (
              <div
                key={cycle.id}
                className={`border rounded-lg p-4 ${
                  cycle.status === "active"
                    ? "border-green-200 bg-green-50"
                    : "border-slate-200 bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <h3 className="font-semibold">
                      {new Date(cycle.startDate).toLocaleDateString("en-GB", { month: "long" })} Cycle
                    </h3>
                    <p className="text-sm text-slate-500">
                      {formatDate(cycle.startDate)} – {formatDate(cycle.endDate)}
                    </p>
                  </div>
                  <span className={`badge ${cycle.status === "active" ? "badge-green" : "badge-blue"}`}>
                    {cycle.status === "active" ? "Current" : "Completed"}
                  </span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div>
                    <div className="text-slate-500">Total Saved</div>
                    <div className="font-semibold"><CediAmount amount={cycle.totalContributed} /></div>
                  </div>
                  <div>
                    <div className="text-slate-500">Withdrawn</div>
                    <div className="font-semibold"><CediAmount amount={cycle.totalWithdrawn} /></div>
                  </div>
                  <div>
                    <div className="text-slate-500">Commission</div>
                    <div className="font-semibold"><CediAmount amount={cycle.totalCommissions} /></div>
                  </div>
                  <div>
                    <div className="text-slate-500">Closing Balance</div>
                    <div className="font-semibold text-green-700"><CediAmount amount={cycle.balance} /></div>
                  </div>
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  {cycle.paidDays}/31 days paid • <CediAmount amount={cycle.dailyContribution} />/day
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}