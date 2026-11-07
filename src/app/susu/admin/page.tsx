"use client";
import { SkeletonPage } from "@/components/ui/Skeletons";

import { Footprints } from "lucide-react";
import { useEffect, useState } from "react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { getSusuDashboardStats, getAdminCollectorBreakdown } from "@/lib/actions/susu-dashboard.actions";
import CediAmount from "@/components/CediAmount";
import InfoTooltip from "@/components/InfoTooltip";

interface DashboardStats {
  activeCustomers: number;
  activeCollectors: number;
  totalCustomers: number;
  paidToday: number;
  outstandingToday: number;
  todayContributions: number;
  todayContributionCount: number;
  todayCollectorContributions: number;
  todayCollectorContributionCount: number;
  todayOfficeContributions: number;
  todayOfficeContributionCount: number;
  todayWithdrawals: number;
  todayWithdrawalCount: number;
  todayCommission: number;
  todayNetPaid: number;
  totalCardFees: number;
  pendingMoneyHandedIn: number;
  pendingRemittanceCount: number;
}

interface CollectorBreakdown {
  collectorId: string;
  collectorName: string;
  todayContributions: number;
  expectedToBringIn: number;
  amountHandedInToday: number;
  difference: number;
}

export default function SusuAdminOverviewPage() {
  const handleRedirect = useRedirectHandler();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [collectorBreakdown, setCollectorBreakdown] = useState<CollectorBreakdown[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadStats() {
    try {
      const [data, breakdown] = await Promise.all([
        getSusuDashboardStats(),
        getAdminCollectorBreakdown(),
      ]);
      setStats(data);
      setCollectorBreakdown(breakdown);
    } catch (err) { if (handleRedirect(err, setError, "Failed to load dashboard data")) return;
      setError("Failed to load dashboard data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStats();
  }, []);

  if (loading) return <SkeletonPage variant="dashboard" />;
  if (error)
    return (
      <div role="alert" className="banner banner-error">
        {error}
      </div>
    );
  if (!stats) return null;

  const statCards = [
    { label: "Active Customers", value: stats.activeCustomers, icon: "🧑", color: "bg-blue-50" },
    { label: "Active Collectors", value: stats.activeCollectors, icon: "🚶", color: "bg-green-50" },
    { label: "Paid Today", value: stats.paidToday, icon: "✅", color: "bg-emerald-50" },
    { label: "Outstanding Today", value: stats.outstandingToday, icon: "⏳", color: "bg-yellow-50" },
  ];

  const financialCards = [
    { label: "Collected from customers today", value: stats.todayContributions, icon: "💵", color: "bg-green-50" },
    { label: "Cash paid out to customers today", value: stats.todayWithdrawals, icon: "🏧", color: "bg-orange-50" },
    { label: "Commission earned today", value: stats.todayCommission, icon: "💼", color: "bg-purple-50" },
    { label: "Card fee income", value: stats.totalCardFees, icon: "💳", color: "bg-indigo-50" },
    { label: "Collected but not yet handed in", value: stats.pendingMoneyHandedIn, icon: "🏦", color: stats.pendingMoneyHandedIn > 0 ? "bg-red-50" : "bg-green-50" },
  ];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Susu Overview</h1>
        <p className="text-slate-500 mt-1">What customers paid in, what was paid out, and what collectors still owe the business today.</p>
      </div>

      {/* Overview Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {statCards.map((card) => (
          <div key={card.label} className={`card ${card.color} text-center`}>
            <div className="text-2xl mb-1">{card.icon}</div>
            <div className="text-2xl font-bold">{card.value}</div>
            <div className="text-xs text-slate-600 mt-1">{card.label}</div>
          </div>
        ))}
      </div>

      {/* Financial Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {financialCards.slice(0, 3).map((card) => (
          <div key={card.label} className="card">
            <div className="flex items-center gap-3">
              <span className="text-2xl">{card.icon}</span>
              <div>
                <div className="flex items-center gap-1 text-sm text-slate-500">
                  {card.label}
                  <InfoTooltip text="Total successful contributions across all channels today." />
                </div>
                <div className="text-xl font-bold"><CediAmount amount={card.value} /></div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {financialCards.slice(3).map((card) => (
          <div key={card.label} className="card">
            <div className="flex items-center gap-3">
              <span className="text-2xl">{card.icon}</span>
              <div>
                <div className="flex items-center gap-1 text-sm text-slate-500">
                  {card.label}
                  {card.label === "Collected but not yet handed in" && (
                    <InfoTooltip text="Money a collector has collected from customers but has not yet handed to the business." />
                  )}
                </div>
                <div className="text-xl font-bold"><CediAmount amount={card.value} /></div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Collector Breakdown */}
      <div className="card mb-8">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          Collector Cash Accountability
          <InfoTooltip text="Per-collector breakdown of today's collections and money handed in." />
        </h2>
        {collectorBreakdown.length === 0 ? (
          <div className="text-center py-8 text-slate-500">
            <p className="text-4xl mb-2 [&>svg]:h-9 [&>svg]:w-9 flex justify-center text-brand-300" aria-hidden><Footprints size={36} /></p>
            <p className="font-medium">No active collectors</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Collector</th>
                  <th className="text-right">Today&apos;s Contributions</th>
                  <th className="text-right">Expected to Bring In</th>
                  <th className="text-right">Amount Handed In</th>
                  <th className="text-right">Difference</th>
                </tr>
              </thead>
              <tbody>
                {collectorBreakdown.map((c) => (
                  <tr key={c.collectorId}>
                    <td className="font-medium">{c.collectorName}</td>
                    <td className="text-right font-mono"><CediAmount amount={c.todayContributions} /></td>
                    <td className="text-right font-mono"><CediAmount amount={c.expectedToBringIn} /></td>
                    <td className="text-right font-mono"><CediAmount amount={c.amountHandedInToday} /></td>
                    <td className={`text-right font-mono font-semibold ${c.difference > 0 ? "text-red-600" : c.difference < 0 ? "text-amber-600" : "text-green-700"}`}>
                      <CediAmount amount={Math.abs(c.difference)} />
                      <div className="text-[11px] font-normal text-slate-500">
                        {c.difference > 0 ? "still owed" : c.difference < 0 ? "over-handed" : "balances"}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Quick Info */}
      <div className="card">
        <h2 className="text-lg font-semibold mb-4">Quick Summary</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-slate-500">Total Registered Customers</div>
            <div className="font-semibold text-lg">{stats.totalCustomers}</div>
          </div>
          <div>
            <div className="text-slate-500">Contribution Events Today</div>
            <div className="font-semibold text-lg">{stats.todayContributionCount}</div>
          </div>
          <div>
            <div className="text-slate-500">Withdrawals Today</div>
            <div className="font-semibold text-lg">{stats.todayWithdrawalCount}</div>
          </div>
          <div>
            <div className="text-slate-500">Net Paid to Customers Today</div>
            <div className="font-semibold text-lg text-green-700"><CediAmount amount={stats.todayNetPaid} /></div>
          </div>
        </div>
      </div>
    </div>
  );
}
