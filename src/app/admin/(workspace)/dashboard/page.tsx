"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  ClipboardList,
  Landmark,
  MapPin,
  Users,
  Vault,
  Wallet,
} from "lucide-react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { getAdminDashboardStats } from "@/lib/actions/daily-account.actions";
import { getSusuDashboardStats } from "@/lib/actions/susu-dashboard.actions";
import { getGreeting } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";
import { PageHeader, StatCard } from "@/components/ui/DataDisplay";

interface MoMoStats {
  totalActiveLocations: number;
  totalActiveWorkers: number;
  submittedToday: number;
  pendingToday: number;
  balancedReports: number;
  discrepancyReports: number;
  totalCashPosition: number;
  totalFloat: number;
  totalCustomerDeposits: number;
  totalCashOut: number;
  totalCashIn: number;
  totalExpenses: number;
  locationStatus: Array<{
    location: { name: string; code: string; id: string };
    worker: string;
    status: string;
    difference: number | null;
  }>;
}

interface SusuStats {
  activeCustomers: number;
  activeCollectors: number;
  paidToday: number;
  outstandingToday: number;
  todayContributions: number;
  todayWithdrawals: number;
  todayCommission: number;
  totalCardFees: number;
  pendingMoneyHandedIn: number;
}

export default function AdminDashboardPage() {
  const handleRedirect = useRedirectHandler();
  const [momoStats, setMomoStats] = useState<MoMoStats | null>(null);
  const [susuStats, setSusuStats] = useState<SusuStats | null>(null);
  const [userName, setUserName] = useState("Admin");
  // Tenant module entitlement — a disabled module is never rendered (not even
  // as zeros) and its data is never fetched.
  const [modules, setModules] = useState<{ momo: boolean; susu: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadStats() {
    try {
      const authRes = await fetch("/api/auth/me?module=admin");
      const authUser = authRes.ok ? await authRes.json() : null;
      // /api/auth/me already carries the session's fullName — no second
      // request to /api/user/[id] is needed (it used to serialize in front
      // of the stats fetches and stretch the whole dashboard load).
      if (authUser?.fullName) {
        setUserName(authUser.fullName);
      } else if (authUser?.userId) {
        const userRes = await fetch(`/api/user/${authUser.userId}`);
        const fullUser = userRes.ok ? await userRes.json() : null;
        if (fullUser?.fullName) setUserName(fullUser.fullName);
      }
      const momoEnabled = authUser?.tenant ? !!authUser.tenant.momoEnabled : true;
      const susuEnabled = authUser?.tenant ? !!authUser.tenant.susuEnabled : true;
      setModules({ momo: momoEnabled, susu: susuEnabled });

      const [momo, susu] = await Promise.all([
        momoEnabled ? getAdminDashboardStats() : Promise.resolve(null),
        susuEnabled ? getSusuDashboardStats() : Promise.resolve(null),
      ]);
      setMomoStats(momo);
      setSusuStats(susu);
    } catch (err) {
      if (handleRedirect(err, setError, "Failed to load dashboard data")) return;
      setError("Failed to load dashboard data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStats();
  }, []);

  if (loading) {
    return (
      <div className="space-y-6" role="status" aria-label="Loading dashboard">
        <div className="skeleton h-16 w-96 rounded-lg" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="skeleton h-44 rounded-xl" />
          <div className="skeleton h-44 rounded-xl" />
        </div>
        <div className="skeleton h-64 rounded-xl" />
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" className="banner banner-error">
        {error}
      </div>
    );
  }

  const needsAttention: { label: string; detail: string; href: string; cta: string }[] = [];
  if (momoStats && momoStats.pendingToday > 0) {
    needsAttention.push({
      label: `${momoStats.pendingToday} MoMo daily ${momoStats.pendingToday === 1 ? "account" : "accounts"} not yet submitted today`,
      detail: "Follow up with the workers at these locations.",
      href: "/admin/reports",
      cta: "Review reports",
    });
  }
  if (susuStats && susuStats.pendingMoneyHandedIn > 0) {
    needsAttention.push({
      label: "Collector money handed in does not balance",
      detail: "A collector has an outstanding shortage awaiting reconciliation.",
      href: "/susu/admin/remittances",
      cta: "Reconcile hand-ins",
    });
  }
  if (momoStats && momoStats.discrepancyReports > 0) {
    needsAttention.push({
      label: `${momoStats.discrepancyReports} report${momoStats.discrepancyReports === 1 ? "" : "s"} with discrepancies`,
      detail: "Variance between expected and entered balances needs explanation.",
      href: "/admin/reports",
      cta: "Investigate",
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${getGreeting()}, ${userName}`}
        description="Overview of all modules in your business."
      />

      {/* What needs attention today — only when there is something to act on. */}
      {needsAttention.length > 0 && (
        <section aria-label="Needs attention" className="space-y-2">
          {needsAttention.map((item) => (
            <div key={item.href + item.label} className="banner banner-warning items-center">
              <AlertTriangle size={18} className="flex-none mt-0.5" aria-hidden />
              <div className="flex-1 min-w-0">
                <p className="font-medium">{item.label}</p>
                <p className="text-xs opacity-80">{item.detail}</p>
              </div>
              <Link href={item.href} className="btn btn-secondary btn-sm flex-none">
                {item.cta} <ArrowRight size={13} aria-hidden />
              </Link>
            </div>
          ))}
        </section>
      )}

      {/* Module sections — gated by tenant entitlement; a disabled module is
          simply absent, never rendered as zeros. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {modules?.momo && momoStats && (
          <section className="card bg-white" aria-label="MoMo module">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-brand-100 text-brand-700" aria-hidden>
                  <MapPin size={16} />
                </span>
                <div>
                  <h2 className="font-semibold text-slate-900">MoMo</h2>
                  <p className="text-xs text-slate-500">Mobile money operations</p>
                </div>
              </div>
              <Link href="/admin/reports" className="text-sm font-medium text-brand-700 hover:text-brand-800 inline-flex items-center gap-1">
                Reports <ArrowRight size={13} aria-hidden />
              </Link>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Locations" value={momoStats.totalActiveLocations} icon={<MapPin />} />
              <StatCard label="Workers" value={momoStats.totalActiveWorkers} icon={<Users />} />
              <StatCard label="Submitted today" value={momoStats.submittedToday} tone="positive" icon={<ClipboardList />} />
              <StatCard
                label="Pending"
                value={momoStats.pendingToday}
                tone={momoStats.pendingToday > 0 ? "warning" : "default"}
                icon={<AlertTriangle />}
              />
            </div>
            <div className="mt-4 pt-4 border-t border-slate-100 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Customer deposit today</span>
                <span className="font-semibold tnum text-emerald-700">
                  <CediAmount amount={momoStats.totalCustomerDeposits} />
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Cash out to customers today</span>
                <span className="font-semibold tnum text-red-700">
                  <CediAmount amount={momoStats.totalCashOut} />
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Cash in today</span>
                <span className="font-semibold tnum">
                  <CediAmount amount={momoStats.totalCashIn} />
                </span>
              </div>
              <div className="flex items-center justify-between border-t border-slate-100 pt-2">
                <span className="text-slate-500">Cash + MoMo held at close</span>
                <span className="font-semibold tnum">
                  <CediAmount amount={momoStats.totalCashPosition} />
                </span>
              </div>
            </div>
          </section>
        )}

        {modules?.susu && susuStats && (
          <section className="card bg-white" aria-label="Susu module">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-gold-100 text-gold-700" aria-hidden>
                  <Wallet size={16} />
                </span>
                <div>
                  <h2 className="font-semibold text-slate-900">Susu</h2>
                  <p className="text-xs text-slate-500">Savings operations</p>
                </div>
              </div>
              <Link href="/susu/admin" className="text-sm font-medium text-brand-700 hover:text-brand-800 inline-flex items-center gap-1">
                Overview <ArrowRight size={13} aria-hidden />
              </Link>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Customers" value={susuStats.activeCustomers} icon={<Users />} />
              <StatCard label="Collectors" value={susuStats.activeCollectors} icon={<Vault />} />
              <StatCard label="Paid today" value={susuStats.paidToday} tone="positive" icon={<Banknote />} />
              <StatCard
                label="Outstanding"
                value={susuStats.outstandingToday}
                tone={susuStats.outstandingToday > 0 ? "warning" : "default"}
                icon={<AlertTriangle />}
              />
            </div>
            <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-2 gap-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Contributions today</span>
                <span className="font-semibold tnum">
                  <CediAmount amount={susuStats.todayContributions} />
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Pending hand-in</span>
                <span className={`font-semibold tnum ${susuStats.pendingMoneyHandedIn > 0 ? "text-red-700" : ""}`}>
                  <CediAmount amount={susuStats.pendingMoneyHandedIn} />
                </span>
              </div>
            </div>
          </section>
        )}
      </div>

      {/* Module status today */}
      {modules?.momo && momoStats && momoStats.locationStatus.length > 0 && (
        <div className="card bg-white !p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Landmark size={16} className="text-brand-500" aria-hidden />
              <h2 className="font-semibold text-slate-900">Location status today</h2>
            </div>
            <Link href="/admin/reports" className="text-sm font-medium text-brand-700 hover:text-brand-800 inline-flex items-center gap-1">
              All reports <ArrowRight size={13} aria-hidden />
            </Link>
          </div>
          <div className="table-container">
            <table>
              <caption className="sr-only">MoMo location status today</caption>
              <thead>
                <tr>
                  <th scope="col">Location</th>
                  <th scope="col">Worker</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">Difference</th>
                </tr>
              </thead>
              <tbody>
                {momoStats.locationStatus.map((row) => (
                  <tr key={row.location.id}>
                    <td>
                      <div className="font-medium text-slate-900">{row.location.name}</div>
                      <div className="text-xs text-slate-500 font-mono">{row.location.code}</div>
                    </td>
                    <td className="text-slate-600">{row.worker}</td>
                    <td>
                      <span
                        className={`badge ${
                          row.status === "Submitted"
                            ? "badge-yellow"
                            : row.status === "Reviewed"
                              ? "badge-green"
                              : row.status === "Draft"
                                ? "badge-gray"
                                : "badge-gray"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            row.status === "Submitted"
                              ? "bg-amber-500"
                              : row.status === "Reviewed"
                                ? "bg-emerald-600"
                                : "bg-slate-400"
                          }`}
                          aria-hidden
                        />
                        {row.status}
                      </span>
                    </td>
                    <td className="num">
                      {row.difference !== null ? (
                        row.difference === 0 ? (
                          <span className="text-emerald-700">
                            <CediAmount amount={0} />
                          </span>
                        ) : (
                          <span className="text-red-700 font-semibold">
                            <CediAmount amount={row.difference} showSign />
                          </span>
                        )
                      ) : (
                        <span className="text-slate-400">&mdash;</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
