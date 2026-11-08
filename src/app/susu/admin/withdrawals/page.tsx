"use client";
import { SkeletonTable } from "@/components/ui/Skeletons";

import { CreditCard, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useObjectDraft } from "@/hooks/useObjectDraft";
import DraftIndicator from "@/components/DraftIndicator";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { getWithdrawals, processWithdrawal } from "@/lib/actions/susu-withdrawal.actions";
import { reverseWithdrawal } from "@/lib/actions/financial-reversal.actions";
import { searchCustomers } from "@/lib/actions/susu-customer.actions";
import { formatCedi, formatDateTime } from "@/lib/utils";
import ReauthDialog from "@/components/ReauthDialog";
import { PromptDialog } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import CediAmount from "@/components/CediAmount";

interface WithdrawalRecord {
  id: string;
  requestedAmount: number;
  commissionAmount: number;
  netAmount: number;
  remainingBalance: number;
  status: string;
  createdAt: Date;
  reversalOfId?: string | null;
  notes?: string | null;
  account: {
    accountId: string;
    customer: { customerId: string; fullName: string };
  };
  cycle: { cycleNumber: number };
}

interface CustomerSearchResult {
  id: string;
  customerId: string;
  fullName: string;
  accounts: Array<{
    id: string;
    accountId: string;
    dailyContribution: number;
    cycles: Array<{ id: string; status: string }>;
  }>;
}

export default function SusuWithdrawalsPage() {
  const handleRedirect = useRedirectHandler();
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[]>([]);
  const [pagination, setPagination] = useState<{ page: number; totalPages: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [page, setPage] = useState(1);

  // Withdrawal form
  const [showForm, setShowForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<CustomerSearchResult[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSearchResult | null>(null);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showReauth, setShowReauth] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<WithdrawalRecord | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseBusy, setReverseBusy] = useState(false);
  const [reverseError, setReverseError] = useState("");
  const toast = useToast();
  // Reused across retries so a timed-out withdrawal cannot post twice.
  const withdrawalKeyRef = useRef<string | null>(null);

  // Financial draft. It never posts automatically and is cleared only after
  // the server confirms the withdrawal.
  const withdrawalDraft = useObjectDraft({
    draftKey: "susu-withdrawal:new",
    workflow: "susu.withdrawal.create",
    enabled: showForm,
    value: { selectedCustomer, withdrawAmount, notes, searchQuery },
    restore: (draft) => {
      const value = draft as Record<string, unknown>;
      if (value.selectedCustomer) setSelectedCustomer(value.selectedCustomer as CustomerSearchResult);
      if (typeof value.withdrawAmount === "string") setWithdrawAmount(value.withdrawAmount);
      if (typeof value.notes === "string") setNotes(value.notes);
      if (typeof value.searchQuery === "string") setSearchQuery(value.searchQuery);
    },
  });

  useEffect(() => {
    loadWithdrawals();
  }, [page]);

  async function loadWithdrawals() {
    setLoading(true);
    try {
      const result = await getWithdrawals({ page, limit: 15 });
      setWithdrawals(result.withdrawals as unknown as WithdrawalRecord[]);
      setPagination(result.pagination);
    } catch (err) { if (handleRedirect(err, setError, "Failed to load withdrawals")) return;
    } finally {
      setLoading(false);
    }
  }

  async function handleSearch(query: string) {
    setSearchQuery(query);
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    try {
      const results = await searchCustomers(query);
      setSearchResults(results as unknown as CustomerSearchResult[]);
    } catch (err) { if (handleRedirect(err, setError, "Search failed")) return;
    }
  }

  function handleProcessWithdrawal() {
    if (!selectedCustomer) return;
    const account = selectedCustomer.accounts[0];
    if (!account) {
      setError("No active account found");
      return;
    }

    const amountNum = parseFloat(withdrawAmount);
    if (!amountNum || amountNum <= 0) {
      setError("Please enter a valid withdrawal amount");
      return;
    }

    // Require reauthentication before withdrawal
    setShowReauth(true);
  }

  function handleReverse(w: WithdrawalRecord) {
    setReverseTarget(w);
    setReverseReason("");
    setReverseError("");
  }

  async function submitReverse() {
    if (!reverseTarget || reverseBusy) return;
    if (reverseReason.trim().length < 10) {
      setReverseError("Enter a reversal reason of at least 10 characters.");
      return;
    }
    setReverseBusy(true);
    setReverseError("");
    try {
      const result = await reverseWithdrawal({
        withdrawalId: reverseTarget.id,
        reason: reverseReason.trim(),
      });
      if (!result.success) {
        setReverseError(result.error || "The withdrawal could not be reversed.");
        return;
      }
      setSuccess("Withdrawal reversed. The original entry and the reversal are both in the audit trail.");
      toast.push("success", "Withdrawal reversed successfully.");
      setReverseTarget(null);
      setReverseReason("");
      await loadWithdrawals();
    } catch {
      setReverseError("The withdrawal could not be reversed. Please try again.");
    } finally {
      setReverseBusy(false);
    }
  }

  async function executeWithdrawal() {
    if (!selectedCustomer) return;
    const account = selectedCustomer.accounts[0];
    if (!account) return;

    const amountNum = parseFloat(withdrawAmount);
    if (!amountNum || amountNum <= 0) return;

    setSubmitting(true);
    setError("");
    setSuccess("");

    const idempotencyKey =
      withdrawalKeyRef.current ?? crypto.randomUUID();
    withdrawalKeyRef.current = idempotencyKey;

    try {
      const result = await processWithdrawal({
        accountId: account.id,
        requestedAmount: amountNum,
        notes: notes || undefined,
        idempotencyKey,
      });

      if (result.success) {
        withdrawalKeyRef.current = null;
        const data = result.data as { commissionAmount: number; netAmount: number };
        setSuccess(
          `Withdrawal processed: ${formatCedi(amountNum)}${data.commissionAmount > 0 ? ` (commission: ${formatCedi(data.commissionAmount)})` : ""}`
        );
        setShowForm(false);
        setSelectedCustomer(null);
        setSearchQuery("");
        setWithdrawAmount("");
        setNotes("");
        await withdrawalDraft.clearDraft();
        loadWithdrawals();
      } else {
        withdrawalKeyRef.current = null;
        setError(result.error || "Failed to process withdrawal");
      }
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return;
      setError("We couldn't confirm the result. Retry to check the same withdrawal.");
    } finally {
      setSubmitting(false);
      setShowReauth(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Withdrawals</h1>
          <p className="text-slate-500 mt-1">Process and view customer withdrawals</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="btn btn-primary">
          {showForm ? "Cancel" : "+ Process Withdrawal"}
        </button>
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

      <ReauthDialog
        open={showReauth}
        onClose={() => setShowReauth(false)}
        onConfirmed={executeWithdrawal}
        title="Confirm your identity"
        description="For your security, enter your own administrator password before completing this withdrawal."
        actionLabel="Confirm Withdrawal"
        module="admin"
      />

      {/* Withdrawal Form */}
      {showForm && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4">Process Withdrawal</h2>

          <div className="form-group">
            <label className="form-label">Search Customer *</label>
            <input
              type="text"
              placeholder="Search by name, ID, or phone..."
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
            />
            {searchResults.length > 0 && (
              <div className="border border-slate-200 rounded-lg mt-1 max-h-48 overflow-y-auto">
                {searchResults.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setSelectedCustomer(c);
                      setSearchQuery(c.fullName);
                      setSearchResults([]);
                    }}
                    className="w-full text-left p-3 hover:bg-slate-50 border-b border-slate-100 last:border-0"
                  >
                    <div className="font-medium text-sm">{c.fullName}</div>
                    <div className="text-xs text-slate-500">
                      Account Number: {c.customerId}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {selectedCustomer && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
              <div className="font-medium">{selectedCustomer.fullName}</div>
              <div className="text-sm text-slate-600">
                Account Number: {selectedCustomer.customerId} &bull; Daily:{" "}
                <CediAmount amount={selectedCustomer.accounts[0]?.dailyContribution || 0} />/day
              </div>
              <p className="text-xs text-orange-600 mt-1">
                ⚠️ First withdrawal in a cycle will incur a one-day commission (
                <CediAmount amount={selectedCustomer.accounts[0]?.dailyContribution || 0} />)
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="form-group">
              <label className="form-label">Withdrawal Amount (GH₵) *</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                placeholder="Amount to withdraw"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Notes</label>
              <input
                type="text"
                placeholder="Optional note"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
          <div className="mb-3">
            <DraftIndicator
              status={withdrawalDraft.status}
              lastSavedAt={withdrawalDraft.lastSavedAt}
              onDiscard={withdrawalDraft.clearDraft}
              onAcknowledge={withdrawalDraft.acknowledgeRestored}
              onRetry={withdrawalDraft.retry}
            />
          </div>
          <div className="flex gap-3 mt-4">
            <button
              onClick={handleProcessWithdrawal}
              className="btn btn-primary"
              disabled={submitting || showReauth || !selectedCustomer}
            >
              {submitting ? "Processing..." : "Process Withdrawal"}
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setSelectedCustomer(null);
              }}
              className="btn btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Withdrawals List */}
      <div className="card">
        {loading ? (
          <SkeletonTable rows={8} columns={6} />
        ) : withdrawals.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <p className="text-4xl mb-2 [&>svg]:h-9 [&>svg]:w-9 flex justify-center text-brand-300" aria-hidden><CreditCard size={36} /></p>
            <p className="font-medium">No withdrawals yet</p>
          </div>
        ) : (
          <>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Customer</th>
                    <th>Requested</th>
                    <th>Commission</th>
                    <th>Net Paid</th>
                    <th>Balance</th>
                    <th>Cycle</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {withdrawals.map((w) => (
                    <tr key={w.id}>
                      <td className="text-sm">{formatDateTime(w.createdAt)}</td>
                      <td>
                        <div className="font-medium text-sm">{w.account.customer.fullName}</div>
                        <div className="text-xs text-slate-500">{w.account.customer.customerId}</div>
                      </td>
                      <td className="font-mono text-sm"><CediAmount amount={w.requestedAmount} /></td>
                      <td className="font-mono text-sm">
                        {w.commissionAmount > 0 ? (
                          <span className="text-orange-600"><CediAmount amount={w.commissionAmount} /></span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="font-mono text-sm font-semibold"><CediAmount amount={w.netAmount} /></td>
                      <td className="font-mono text-sm text-blue-600"><CediAmount amount={w.remainingBalance} /></td>
                      <td>
                        <span className="badge badge-blue">Cycle {w.cycle.cycleNumber}</span>
                      </td>
                      <td>
                        <span className={`badge ${w.status === "completed" ? "badge-green" : "badge-orange"}`}>
                          {w.status}
                        </span>
                      </td>
                      <td>
                        {w.status === "completed" && !w.reversalOfId && (
                          <button
                            type="button"
                            className="text-xs text-red-600 hover:text-red-700 underline"
                            onClick={() => handleReverse(w)}
                          >
                            Reverse
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pagination && pagination.totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
                <p className="text-sm text-slate-500">
                  Page {pagination.page} of {pagination.totalPages}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="btn btn-secondary btn-sm"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                    disabled={page === pagination.totalPages}
                    className="btn btn-secondary btn-sm"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <PromptDialog
        open={Boolean(reverseTarget)}
        onClose={() => {
          if (!reverseBusy) setReverseTarget(null);
        }}
        onSubmit={submitReverse}
        title="Reverse this withdrawal?"
        description="The original entry is kept and a reversal entry is posted to the audit trail."
        label="Reason for reversal (minimum 10 characters)"
        placeholder="Explain what was wrong and what evidence supports the reversal."
        confirmLabel="Reverse withdrawal"
        required
        loading={reverseBusy}
        value={reverseReason}
        onChange={setReverseReason}
        error={reverseError}
        multiline
      />
    </div>
  );
}
