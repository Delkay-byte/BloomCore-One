"use client";
import { SkeletonPage } from "@/components/ui/Skeletons";
import { ClipboardList, X } from "lucide-react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getCustomerById, reassignCustomer, createCustomerPortalAccess, resetCustomerPassword, toggleCustomerPortal } from "@/lib/actions/susu-customer.actions";
import { getCollectors } from "@/lib/actions/susu-collector.actions";
import { formatDate, formatDateTime } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";
import PasswordInput from "@/components/PasswordInput";

interface CustomerDetail {
  id: string;
  customerId: string;
  fullName: string;
  phone?: string | null;
  address?: string | null;
  status: string;
  registeredAt: Date;
  portalEnabled: boolean;
  portalPasswordHash?: string | null;
  forcePortalPasswordReset?: boolean;
  accounts: Array<{
    id: string;
    accountId: string;
    dailyContribution: number;
    status: string;
    cardCustody: string;
    cardFees: Array<{ id: string; amount: number; createdAt: Date }>;
    cycles: Array<{
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
        channel: string;                          allocations: Array<{ cycleDay: number; amount: number }>;
                          recordedBy?: { fullName: string } | null;
                          receivedBy?: { fullName: string } | null;
                          collector?: { user?: { fullName: string } } | null;
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
                      }>;
                    }>;
  assignments: Array<{
    id: string;
    active: boolean;
    assignedAt: Date;
    unassignedAt?: Date | null;
    collector: { user: { id: string; fullName: string } };
  }>;
}

interface Collector {
  id: string;
  user: { fullName: string; email: string; status: string };
}

export default function SusuCustomerDetailPage() {
  const handleRedirect = useRedirectHandler();
  const params = useParams();
  const router = useRouter();
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [collectors, setCollectors] = useState<Collector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Reassignment modal
  const [showReassign, setShowReassign] = useState(false);
  const [newCollectorId, setNewCollectorId] = useState("");
  const [collectorSearch, setCollectorSearch] = useState("");
  const [reassigning, setReassigning] = useState(false);

  // Customer portal provisioning
  const [showPortalForm, setShowPortalForm] = useState(false);

  const [portalTempPassword, setPortalTempPassword] = useState("");
  const [portalProvisioning, setPortalProvisioning] = useState(false);
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [resetConfirmPassword, setResetConfirmPassword] = useState("");
  const [resettingPassword, setResettingPassword] = useState(false);

  // Statement view state
  const [statementFilter, setStatementFilter] = useState<"all" | "contributions" | "withdrawals">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [viewMode, setViewMode] = useState<"cycles" | "statement">("cycles");

  async function loadCustomer() {
    try {
      const [customerData, collectorData] = await Promise.all([
        getCustomerById(params.id as string),
        getCollectors(),
      ]);
      setCustomer(customerData as unknown as CustomerDetail);
      setCollectors(collectorData as unknown as Collector[]);
    } catch (err) {
      if (handleRedirect(err, setError, "Failed to load customer")) return;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadCustomer();
  }, [params.id]);

  // ── Customer Portal Provisioning ──────────────────────────────────
  async function handleCreatePortalAccess() {
    if (!customer) return;
    setPortalProvisioning(true);
    setError("");
    setSuccess("");
    try {
      const formData = new FormData();
      formData.set("loginIdentifier", customer.customerId);
      formData.set("temporaryPassword", portalTempPassword);
      const result = await createCustomerPortalAccess(customer.id, formData);
      if (result.success) {
        setSuccess("Customer portal access created successfully.");
        setShowPortalForm(false);
        setPortalTempPassword("");
        loadCustomer();
      } else {
        setError(result.error || "Failed to create portal access");
      }
    } catch (err) {
      if (handleRedirect(err, setError, "An unexpected error occurred")) return;
    } finally {
      setPortalProvisioning(false);
    }
  }

  async function handleResetCustomerPassword() {
    if (!customer) return;
    if (resetNewPassword !== resetConfirmPassword) {
      setError("Passwords don't match");
      return;
    }
    if (resetNewPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setResettingPassword(true);
    setError("");
    setSuccess("");
    try {
      const formData = new FormData();
      formData.set("newPassword", resetNewPassword);
      const result = await resetCustomerPassword(customer.id, formData);
      if (result.success) {
        setSuccess("Customer password reset. Customer will need to change password on next login.");
        setShowResetPassword(false);
        setResetNewPassword("");
        setResetConfirmPassword("");
        loadCustomer();
      } else {
        setError(result.error || "Failed to reset password");
      }
    } catch (err) {
      if (handleRedirect(err, setError, "An unexpected error occurred")) return;
    } finally {
      setResettingPassword(false);
    }
  }

  async function handleTogglePortal(enabled: boolean) {
    if (!customer) return;
    setPortalProvisioning(true);
    setError("");
    setSuccess("");
    try {
      const result = await toggleCustomerPortal(customer.id, enabled);
      if (result.success) {
        setSuccess(enabled ? "Customer portal enabled." : "Customer portal disabled.");
        loadCustomer();
      } else {
        setError(result.error || "Failed to toggle portal");
      }
    } catch (err) {
      if (handleRedirect(err, setError, "An unexpected error occurred")) return;
    } finally {
      setPortalProvisioning(false);
    }
  }

  async function handleReassign() {
    if (!newCollectorId || !customer) return;
    setReassigning(true);
    setError("");
    setSuccess("");
    try {
      const account = customer.accounts[0];
      if (!account) {
        setError("No active account found");
        return;
      }
      const result = await reassignCustomer({
        customerId: customer.id,
        accountId: account.id,
        newCollectorId,
      });
      if (result.success) {
        setSuccess("Customer reassigned successfully");
        setShowReassign(false);
        setNewCollectorId("");
        setCollectorSearch("");
        loadCustomer();
      } else {
        setError(result.error || "Failed to reassign customer");
      }
    } catch (err) {
      if (handleRedirect(err, setError, "An unexpected error occurred")) return;
    } finally {
      setReassigning(false);
    }
  }

  if (loading) return <SkeletonPage variant="detail" />;
  if (!customer)
    return (
      <div className="text-center py-20">
        <p className="text-slate-500">Customer not found</p>
        <button onClick={() => router.push("/susu/admin/customers")} className="btn btn-primary mt-4">
          Back to Customers
        </button>
      </div>
    );

  const account = customer.accounts[0];
  const currentCycle = account?.cycles[0];
  const activeAssignment = customer.assignments.find((a) => a.active);
  const currentCollector = activeAssignment?.collector?.user?.fullName;

  // Filter collectors for search
  const filteredCollectors = collectors.filter((c) => {
    if (c.user.status !== "active") return false;
    if (!collectorSearch) return true;
    const q = collectorSearch.toLowerCase();
    return (
      c.user.fullName.toLowerCase().includes(q) ||
      c.user.email.toLowerCase().includes(q)
    );
  });

  // Assignment history (inactive assignments + current)
  const assignmentHistory = customer.assignments;

  // Calculate cycle totals
  function getCycleStats(cycle: CustomerDetail["accounts"][0]["cycles"][0]) {
    const totalContributed = cycle.contributions.reduce((sum, c) => sum + Number(c.amount), 0);
    const totalWithdrawn = cycle.withdrawals.reduce((sum, w) => sum + Number(w.netAmount), 0);
    const totalCommissions = cycle.commissions.reduce((sum, c) => sum + Number(c.amount), 0);
    const paidDays = new Set(cycle.contributions.flatMap((c) => c.allocations.map((a) => a.cycleDay)));
    return { totalContributed, totalWithdrawn, totalCommissions, paidDays: paidDays.size };
  }

  // Current Savings Summary (derived from current cycle)
  const currentCycleStats = currentCycle ? getCycleStats(currentCycle) : null;
  const currentBalance = currentCycleStats
    ? currentCycleStats.totalContributed - currentCycleStats.totalWithdrawn - currentCycleStats.totalCommissions
    : 0;
  const daysCovered = currentCycleStats?.paidDays || 0;
  const daysOutstanding = Math.max(0, 31 - daysCovered);

  // Build chronological statement entries
  function buildStatementEntries() {
    if (!account) return [];
    const entries: Array<{
      date: Date;
      type: "contribution" | "withdrawal";
      amount: number;
      commission?: number;
      balance?: number;
      channel: string;
      receivedBy?: string;
      reference?: string;
      notes?: string;
      cycleNumber: number;
    }> = [];

    account.cycles.forEach((cycle) => {
      cycle.contributions.forEach((c) => {
        entries.push({
          date: new Date(c.collectionDate),
          type: "contribution",
          amount: Number(c.amount),
          channel: c.channel,
          receivedBy: (c as { receivedByName?: string | null }).receivedByName ?? c.receivedBy?.fullName,
          cycleNumber: cycle.cycleNumber,
        });
      });
      cycle.withdrawals.forEach((w) => {
        entries.push({
          date: new Date(w.createdAt),
          type: "withdrawal",
          amount: Number(w.netAmount),
          commission: w.commissionAmount > 0 ? Number(w.commissionAmount) : undefined,
          balance: Number(w.remainingBalance),
          channel: "withdrawal",
          cycleNumber: cycle.cycleNumber,
          notes: w.notes || undefined,
        });
      });
    });

    return entries.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  const statementEntries = buildStatementEntries();

  // Filter statement entries
  const filteredStatementEntries = statementEntries.filter((entry) => {
    if (statementFilter === "contributions" && entry.type !== "contribution") return false;
    if (statementFilter === "withdrawals" && entry.type !== "withdrawal") return false;
    if (dateFrom && entry.date < new Date(dateFrom + "T00:00:00")) return false;
    if (dateTo && entry.date > new Date(dateTo + "T23:59:59")) return false;
    return true;
  });

  function handleExportCSV() {
    if (!account || !customer) return;
    const entriesToExport = viewMode === "statement" ? filteredStatementEntries : statementEntries;
    if (entriesToExport.length === 0) return;
    const headers = [
      "Date",
      "Type",
      "Amount",
      "Commission",
      "Balance",
      "Channel",
      "Received By",
      "Cycle",
      "Notes",
    ];
    const rows = entriesToExport.map((e) => [
      formatDateTime(e.date),
      e.type === "contribution" ? "Contribution" : "Withdrawal",
      e.type === "contribution" ? String(e.amount) : String(-e.amount),
      e.commission ? String(e.commission) : "",
      e.balance !== undefined ? String(e.balance) : "",
      e.type === "contribution" ? (e.channel === "collector" ? "Collector" : "Office") : "Withdrawal",
      e.receivedBy || "",
      String(e.cycleNumber),
      e.notes || "",
    ]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `maacash-susu-statement-${customer.customerId}-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="mb-8">
        <button
          onClick={() => router.push("/susu/admin/customers")}
          className="text-sm text-slate-500 hover:text-slate-700 mb-2 inline-block"
        >
          ← Back to Customers
        </button>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{customer.fullName}</h1>
            <p className="text-slate-500 mt-1">
              Account Number: {customer.customerId} &bull; {customer.phone || "No phone"}
              {customer.address && ` &bull; ${customer.address}`}
            </p>
          </div>
          <span
            className={`badge ${customer.status === "active" ? "badge-green" : "badge-red"}`}
          >
            {customer.status}
          </span>
        </div>
      </div>

      {error && (
        <div role="alert" className="banner banner-error mb-4">
          {error}
          <button onClick={() => setError("")} className="ml-2"><X size={14} aria-hidden /></button>
        </div>
      )}
      {success && (
        <div role="status" className="banner banner-success mb-4">
          {success}
          <button onClick={() => setSuccess("")} className="ml-2"><X size={14} aria-hidden /></button>
        </div>
      )}

      {/* Current Savings Summary */}
      {account && currentCycle && currentCycleStats && (
        <div className="card border-l-4 border-l-green-500 mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-green-700">Current Savings Summary</h2>
            <span className={`badge ${currentCycle.status === "active" ? "badge-green" : "badge-blue"}`}>
              Current Cycle: {formatDate(currentCycle.startDate)} – {formatDate(currentCycle.endDate)}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
            <div className="bg-green-50 rounded-lg p-3 text-center">
              <div className="text-xs text-green-600">Current Balance</div>
              <div className="text-2xl font-bold text-green-800"><CediAmount amount={currentBalance} /></div>
            </div>
            <div className="bg-blue-50 rounded-lg p-3 text-center">
              <div className="text-xs text-blue-600">Total Saved</div>
              <div className="font-semibold"><CediAmount amount={currentCycleStats.totalContributed} /></div>
            </div>
            <div className="bg-purple-50 rounded-lg p-3 text-center">
              <div className="text-xs text-purple-600">Commission</div>
              <div className="font-semibold"><CediAmount amount={currentCycleStats.totalCommissions} /></div>
            </div>
            <div className="bg-orange-50 rounded-lg p-3 text-center">
              <div className="text-xs text-orange-600">Total Withdrawn</div>
              <div className="font-semibold"><CediAmount amount={currentCycleStats.totalWithdrawn} /></div>
            </div>
            <div className="bg-emerald-50 rounded-lg p-3 text-center">
              <div className="text-xs text-emerald-600">Days Covered</div>
              <div className="font-semibold text-lg">{daysCovered}/31</div>
            </div>
            <div className="bg-yellow-50 rounded-lg p-3 text-center">
              <div className="text-xs text-yellow-600">Days Outstanding</div>
              <div className="font-semibold text-lg">{daysOutstanding}</div>
            </div>
          </div>
          <div className="mt-4 p-3 bg-slate-50 rounded-lg text-sm">
            <div className="flex justify-between text-slate-600">
              <span>Daily Rate:</span>
              <span className="font-medium"><CediAmount amount={currentCycle.dailyContribution} />/day</span>
            </div>
            {currentCycleStats.totalCommissions > 0 && (
              <div className="flex justify-between text-purple-600 mt-1">
                <span>First-withdrawal commission charged:</span>
                <span className="font-medium"><CediAmount amount={currentCycleStats.totalCommissions} /></span>
              </div>
            )}
            {currentCycleStats.totalCommissions === 0 && (
              <div className="flex justify-between text-slate-500 mt-1">
                <span>First-withdrawal commission:</span>
                <span className="font-medium">Not yet charged</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Physical Card Check */}
      {account && currentCycle && currentCycleStats && (
        <div className="card border border-dashed border-slate-300 mb-8">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">💳</span>
            <h3 className="font-semibold text-slate-700">Physical Card Check</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-slate-500">Daily Contribution</div>
              <div className="font-semibold"><CediAmount amount={account.dailyContribution} />/day</div>
            </div>
            <div>
              <div className="text-slate-500">Days Covered (Digital)</div>
              <div className="font-semibold">{daysCovered}/31</div>
            </div>
            <div>
              <div className="text-slate-500">Current Cycle</div>
              <div className="font-semibold">Cycle {currentCycle.cycleNumber}</div>
            </div>
            <div>
              <div className="text-slate-500">Current Balance (Digital)</div>
              <div className="font-semibold text-green-700"><CediAmount amount={currentBalance} /></div>
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-3">
            Compare with physical Susu card. Digital ledger is authoritative; reconcile during pilot.
          </p>
        </div>
      )}

      {/* Current Collector + Account Info */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="card border-l-4 border-l-blue-500">
          <div className="text-sm text-slate-500 mb-1">Current Collector</div>
          {currentCollector ? (
            <div className="font-semibold text-lg">{currentCollector}</div>
          ) : (
            <div className="text-slate-400 italic">No Collector Assigned</div>
          )}
          <button
            onClick={() => setShowReassign(true)}
            className="btn btn-secondary btn-sm mt-2"
          >
            Change Collector
          </button>
        </div>
        {account && (
          <>
            <div className="card">
              <div className="text-sm text-slate-500 mb-1">Account Number</div>
              <div className="font-mono font-semibold text-lg">{customer.customerId}</div>
            </div>
            <div className="card">
              <div className="text-sm text-slate-500 mb-1">Daily Contribution</div>
              <div className="font-semibold text-lg text-green-700">
                <CediAmount amount={account.dailyContribution} />/day
              </div>
            </div>
          </>
        )}
      </div>

      {/* View Toggle */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setViewMode("cycles")}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            viewMode === "cycles" ? "bg-green-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-gray-200"
          }`}
        >
          Cycle History
        </button>
        <button
          onClick={() => setViewMode("statement")}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            viewMode === "statement" ? "bg-green-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-gray-200"
          }`}
        >
          Account Statement
        </button>
      </div>

      {/* Collector History */}
      {assignmentHistory.length > 0 && (
        <div className="card mb-8">
          <h3 className="font-semibold mb-3">Collector History</h3>
          <div className="space-y-2">
            {assignmentHistory.map((a) => (
              <div key={a.id} className={`flex items-center justify-between p-3 rounded-lg ${a.active ? "bg-green-50 border border-green-200" : "bg-slate-50"}`}>
                <div>
                  <div className="font-medium text-sm">{a.collector.user.fullName}</div>
                  <div className="text-xs text-slate-500">
                    {formatDate(a.assignedAt)}
                    {a.unassignedAt ? ` — ${formatDate(a.unassignedAt)}` : " — Current"}
                  </div>
                </div>
                {a.active && <span className="badge badge-green text-xs">Current</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Customer Portal Access */}
      <div className="card mb-8">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-lg">Customer Portal Access</h3>
          {!customer.portalPasswordHash ? (
            <span className="badge badge-gray">Not Created</span>
          ) : customer.portalEnabled && customer.forcePortalPasswordReset ? (
            <span className="badge badge-yellow">Password Change Required</span>
          ) : customer.portalEnabled ? (
            <span className="badge badge-green">Active</span>
          ) : (
            <span className="badge badge-yellow">Disabled</span>
          )}
        </div>

        {!customer.portalEnabled && !customer.portalPasswordHash && !showPortalForm && (
          <div>
            <p className="text-sm text-slate-500 mb-3">Customer does not have portal access yet.</p>
            <button
              onClick={() => setShowPortalForm(true)}
              className="btn btn-primary btn-sm"
            >
              Create Login
            </button>
          </div>
        )}

        {customer.portalEnabled && !showResetPassword && (
          <div className="flex gap-2">
            <button
              onClick={() => handleTogglePortal(false)}
              className="btn btn-secondary btn-sm"
              disabled={portalProvisioning}
            >
              Disable Portal
            </button>
            <button
              onClick={() => setShowResetPassword(true)}
              className="btn btn-secondary btn-sm"
            >
              Reset Password
            </button>
          </div>
        )}

        {!customer.portalEnabled && customer.portalPasswordHash && !showPortalForm && (
          <div className="flex gap-2">
            <button
              onClick={() => handleTogglePortal(true)}
              className="btn btn-primary btn-sm"
              disabled={portalProvisioning}
            >
              Enable Customer Portal
            </button>
            <button
              onClick={() => setShowResetPassword(true)}
              className="btn btn-secondary btn-sm"
            >
              Reset Password
            </button>
          </div>
        )}

        {/* Create Portal Access Form */}
        {showPortalForm && (
          <div className="mt-4 p-4 bg-slate-50 rounded-lg">
            <h4 className="font-medium mb-3">Create Customer Portal Login</h4>
            <div className="space-y-3">
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
                <p className="text-xs font-medium text-slate-500">Account Number</p>
                <p className="font-mono font-semibold text-slate-900">{customer.customerId}</p>
                <p className="form-hint">The customer signs in with this Account Number or their registered phone number.</p>
              </div>
              <div className="form-group">
                <label className="form-label">Temporary Password</label>
                <PasswordInput
                  value={portalTempPassword}
                  onChange={(e) => setPortalTempPassword(e.target.value)}
                  placeholder="Min 8 characters"
                  required
                />
                <p className="form-hint">Customer will be required to change this on first login.</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleCreatePortalAccess}
                  className="btn btn-primary btn-sm"
                  disabled={portalProvisioning || !portalTempPassword}
                >
                  {portalProvisioning ? "Creating..." : "Create Login"}
                </button>
                <button
                  onClick={() => { setShowPortalForm(false); setPortalTempPassword(""); }}
                  className="btn btn-secondary btn-sm"
                  disabled={portalProvisioning}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Reset Password Form */}
        {showResetPassword && (
          <div className="mt-4 p-4 bg-slate-50 rounded-lg">
            <h4 className="font-medium mb-3">Reset Customer Password</h4>
            <div className="space-y-3">
              <div className="form-group">
                <label className="form-label">New Password</label>
                <PasswordInput
                  value={resetNewPassword}
                  onChange={(e) => setResetNewPassword(e.target.value)}
                  placeholder="Min 8 characters"
                  required
                />
                <p className="form-hint">Existing sessions will be invalidated. Customer must change password on next login.</p>
              </div>
              <div className="form-group">
                <label className="form-label">Confirm Password</label>
                <PasswordInput
                  value={resetConfirmPassword}
                  onChange={(e) => setResetConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  required
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleResetCustomerPassword}
                  className="btn btn-primary btn-sm"
                  disabled={resettingPassword || !resetNewPassword || !resetConfirmPassword}
                >
                  {resettingPassword ? "Resetting..." : "Reset Password"}
                </button>
                <button
                  onClick={() => { setShowResetPassword(false); setResetNewPassword(""); setResetConfirmPassword(""); }}
                  className="btn btn-secondary btn-sm"
                  disabled={resettingPassword}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Card Fee */}
      {account && account.cardFees.length > 0 && (
        <div className="card mb-8">
          <h3 className="font-semibold mb-3">Card Fee</h3>
          {account.cardFees.map((fee) => (
            <div key={fee.id} className="flex justify-between items-center p-2 rounded-lg bg-slate-50">
              <span className="text-sm">Card Purchase Fee</span>
              <span className="font-mono font-semibold"><CediAmount amount={fee.amount} /></span>
            </div>
          ))}
        </div>
      )}

      {/* Cycle History View */}
      {viewMode === "cycles" && account && account.cycles.length > 0 && (
        <div className="space-y-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-slate-900">Cycle History</h2>
            <button onClick={handleExportCSV} className="btn btn-secondary btn-sm" disabled={statementEntries.length === 0}>
              📥 Export Statement CSV
            </button>
          </div>
          {account.cycles.map((cycle) => {
            const stats = getCycleStats(cycle);
            return (
              <div key={cycle.id} className="card">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-semibold">
                      Cycle {cycle.cycleNumber} —{" "}
                      {formatDate(cycle.startDate)} to {formatDate(cycle.endDate)}
                    </h3>
                    <p className="text-sm text-slate-500">
                      {stats.paidDays}/31 days paid &bull; Daily rate: <CediAmount amount={cycle.dailyContribution} />
                    </p>
                  </div>
                  <span
                    className={`badge ${
                      cycle.status === "active" ? "badge-green" : "badge-blue"
                    }`}
                  >
                    {cycle.status}
                  </span>
                </div>

                {/* Cycle Summary */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                  <div className="bg-green-50 rounded-lg p-3">
                    <div className="text-xs text-green-600">Gross Contributions</div>
                    <div className="font-semibold"><CediAmount amount={stats.totalContributed} /></div>
                  </div>
                  <div className="bg-purple-50 rounded-lg p-3">
                    <div className="text-xs text-purple-600">Commission Charged</div>
                    <div className="font-semibold"><CediAmount amount={stats.totalCommissions} /></div>
                  </div>
                  <div className="bg-orange-50 rounded-lg p-3">
                    <div className="text-xs text-orange-600">Total Withdrawn</div>
                    <div className="font-semibold"><CediAmount amount={stats.totalWithdrawn} /></div>
                  </div>
                  <div className="bg-blue-50 rounded-lg p-3">
                    <div className="text-xs text-blue-600">Remaining Balance</div>
                    <div className="font-semibold">
                      <CediAmount amount={stats.totalContributed - stats.totalWithdrawn - stats.totalCommissions} />
                    </div>
                  </div>
                </div>

                {/* Contributions */}
                {cycle.contributions.length > 0 && (
                  <div className="mb-4">
                    <h4 className="text-sm font-semibold text-slate-600 mb-2">Contributions</h4>
                    <div className="space-y-1">
                      {cycle.contributions.map((c) => (
                        <div key={c.id} className="flex justify-between items-center text-sm p-2 rounded bg-slate-50">
                          <div>
                            <span>{formatDate(c.collectionDate)}</span>
                            <span className="text-slate-400 ml-2">
                              ({c.channel === "collector" ? "Collector" : "Office"})
                              {c.channel === "direct_office" && ((c as { receivedByName?: string | null }).receivedByName || c.receivedBy?.fullName)
                                ? ` — Received by ${(c as { receivedByName?: string | null }).receivedByName || c.receivedBy?.fullName}`
                                : c.channel === "collector" && c.collector?.user?.fullName
                                ? ` — Collected by ${c.collector.user.fullName}`
                                : ""}
                            </span>
                          </div>
                          <span className="font-mono"><CediAmount amount={c.amount} /></span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Withdrawals */}
                {cycle.withdrawals.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-slate-600 mb-2">Withdrawals</h4>
                    <div className="space-y-1">
                      {cycle.withdrawals.map((w) => (
                        <div key={w.id} className="flex justify-between items-center text-sm p-2 rounded bg-orange-50">
                          <div>
                            <span>{formatDateTime(w.createdAt)}</span>
                            {w.commissionAmount > 0 && (
                              <span className="text-orange-600 ml-2">
                                (incl. <CediAmount amount={w.commissionAmount} /> commission)
                              </span>
                            )}
                          </div>
                          <div className="text-right">
                            <div className="font-mono font-semibold"><CediAmount amount={w.netAmount} /></div>
                            <div className="text-xs text-slate-500">
                              Balance: <CediAmount amount={w.remainingBalance} />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Account Statement View */}
      {viewMode === "statement" && (
        <div className="card">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-4">
            <h2 className="text-xl font-bold text-slate-900">Account Statement</h2>
            <div className="flex flex-wrap gap-2">
              <select
                value={statementFilter}
                onChange={(e) => setStatementFilter(e.target.value as "all" | "contributions" | "withdrawals")}
                className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
              >
                <option value="all">All Transactions</option>
                <option value="contributions">Contributions Only</option>
                <option value="withdrawals">Withdrawals Only</option>
              </select>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="Date From"
              />
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-lg text-sm"
                placeholder="Date To"
              />
              <button onClick={handleExportCSV} className="btn btn-secondary btn-sm" disabled={filteredStatementEntries.length === 0}>
                📥 Export CSV
              </button>
            </div>
          </div>

          {filteredStatementEntries.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <p className="text-4xl mb-2 [&>svg]:h-9 [&>svg]:w-9 flex justify-center text-brand-300" aria-hidden><ClipboardList size={36} /></p>
              <p className="font-medium">No transactions found</p>
              <p className="text-sm mt-1">Try adjusting your filters.</p>
            </div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Amount</th>
                    <th>Commission</th>
                    <th>Balance</th>
                    <th>Channel / Received By</th>
                    <th>Cycle</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStatementEntries.map((entry) => (
                    <tr key={`${entry.date.getTime()}-${entry.type}-${entry.amount}`}>
                      <td className="text-sm whitespace-nowrap">{formatDateTime(entry.date)}</td>
                      <td>
                        <span className={`badge ${entry.type === "contribution" ? "badge-green" : "badge-red"}`}>
                          {entry.type === "contribution" ? "Contribution" : "Withdrawal"}
                        </span>
                      </td>
                      <td className="font-mono font-semibold text-right">
                        {entry.type === "contribution" ? (
                          <>+<CediAmount amount={entry.amount} /></>
                        ) : (
                          <>-<CediAmount amount={entry.amount} /></>
                        )}
                      </td>
                      <td className="font-mono text-right">
                        {entry.commission ? (
                          <span className="text-purple-600"><CediAmount amount={entry.commission} /></span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="font-mono text-right">
                        {entry.balance !== undefined ? <CediAmount amount={entry.balance} /> : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="text-sm">
                        {entry.type === "contribution" ? (
                          <>
                            {entry.channel === "collector" ? "Collector" : "Office"}
                            {entry.receivedBy && <span className="ml-1">({entry.receivedBy})</span>}
                          </>
                        ) : (
                          "Withdrawal"
                        )}
                      </td>
                      <td className="text-sm text-slate-500">Cycle {entry.cycleNumber}</td>
                      <td className="text-sm text-slate-500 max-w-xs truncate">{entry.notes || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Reassignment Modal */}
      {showReassign && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-2">Change Collector</h3>

            <div className="bg-slate-50 rounded-lg p-3 mb-4 text-sm">
              <div className="flex justify-between mb-1">
                <span className="text-slate-500">Customer:</span>
                <span className="font-medium">{customer.fullName}</span>
              </div>
              <div className="flex justify-between mb-1">
                <span className="text-slate-500">Account Number:</span>
                <span className="font-mono">{customer.customerId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Current Collector:</span>
                <span className="font-medium">{currentCollector || "None"}</span>
              </div>
            </div>

            <div className="form-group mb-4">
              <label className="form-label">New Collector</label>
              <input
                type="text"
                placeholder="Search collector by name..."
                value={collectorSearch}
                onChange={(e) => setCollectorSearch(e.target.value)}
                className="w-full"
              />
              <div className="mt-2 max-h-48 overflow-y-auto border border-slate-200 rounded-lg">
                {filteredCollectors.length === 0 ? (
                  <div className="p-3 text-sm text-slate-500 text-center">No collectors found</div>
                ) : (
                  filteredCollectors.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        setNewCollectorId(c.id);
                        setCollectorSearch(c.user.fullName);
                      }}
                      className={`w-full text-left p-3 text-sm border-b border-slate-100 last:border-0 hover:bg-green-50 transition-colors ${
                        newCollectorId === c.id ? "bg-green-50 border-l-2 border-l-green-500" : ""
                      }`}
                    >
                      <div className="font-medium">{c.user.fullName}</div>
                      <div className="text-xs text-slate-500">{c.user.email}</div>
                    </button>
                  ))
                )}
              </div>
            </div>

            {newCollectorId && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-sm text-blue-800">
                <strong>Reassign this customer?</strong>
                <br />
                {customer.fullName} will be moved from {currentCollector || "no collector"} to{" "}
                {filteredCollectors.find((c) => c.id === newCollectorId)?.user?.fullName}.
                <br />
                <span className="text-blue-600">Previous collection history will remain unchanged.</span>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowReassign(false);
                  setNewCollectorId("");
                  setCollectorSearch("");
                }}
                className="btn btn-secondary flex-1"
                disabled={reassigning}
              >
                Cancel
              </button>
              <button
                onClick={handleReassign}
                className="btn btn-primary flex-1"
                disabled={!newCollectorId || reassigning}
              >
                {reassigning ? "Reassigning..." : "Reassign Customer"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
