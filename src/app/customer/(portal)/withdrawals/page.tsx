"use client";
import { SkeletonPage } from "@/components/ui/Skeletons";

import { useCallback, useEffect, useState } from "react";
import { getCustomerWithdrawals } from "@/lib/actions/susu-customer.actions";
import {
  cancelMyWithdrawalRequest,
  getMyWithdrawalRequests,
  requestWithdrawal,
  type WithdrawalRequestView,
} from "@/lib/actions/withdrawal-request.actions";
import { getCustomerAccount } from "@/lib/actions/susu-customer.actions";
import { formatDateTime } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import { WITHDRAWAL_REQUEST_DISCLAIMER } from "@/lib/withdrawal-request";

interface Withdrawal {
  id: string;
  requestedAmount: number;
  commissionAmount: number;
  netAmount: number;
  remainingBalance: number;
  createdAt: Date;
  notes?: string | null;
  cycleNumber: number;
}

interface AccountChoice {
  id: string;
  accountId: string;
}

/**
 * Withdrawals for the customer.
 *
 * Two things live here: what the office has already paid, and a request the
 * customer can raise. A request is not a withdrawal — the page says so, shows
 * the decision, and lets the customer cancel while it is still waiting.
 */
export default function CustomerWithdrawalsPage() {
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [requests, setRequests] = useState<WithdrawalRequestView[]>([]);
  const [accounts, setAccounts] = useState<AccountChoice[]>([]);
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(async () => {
    try {
      const [paid, requested, account] = await Promise.all([
        getCustomerWithdrawals(),
        getMyWithdrawalRequests(),
        getCustomerAccount(),
      ]);
      setWithdrawals(paid as unknown as Withdrawal[]);
      setRequests(requested.requests ?? []);
      const choices = ((account as unknown as { accounts?: AccountChoice[] } | null)?.accounts ??
        []).map((row) => ({ id: row.id, accountId: row.accountId }));
      setAccounts(choices);
      setAccountId((current) => current || choices[0]?.id || "");
    } catch {
      setError("Failed to load withdrawals");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitRequest() {
    setBusy(true);
    setError("");
    setSuccess("");
    const parsed = Number(amount);
    if (!accountId) {
      setError("Choose the account to withdraw from.");
      setBusy(false);
      return;
    }
    const result = await requestWithdrawal({
      accountId,
      amount: parsed,
      reason,
    });
    if (!result.success) {
      setError(result.error ?? "The request could not be sent.");
    } else {
      setAmount("");
      setReason("");
      setSuccess(
        `Request ${result.data?.reference} sent. The office will review it; nothing has been paid yet.`
      );
      await load();
    }
    setBusy(false);
  }

  async function cancel(id: string) {
    setBusy(true);
    setError("");
    setSuccess("");
    const result = await cancelMyWithdrawalRequest(id);
    if (!result.success) {
      setError(result.error ?? "The request could not be cancelled.");
    } else {
      setSuccess("Request cancelled. No money moved.");
      await load();
    }
    setBusy(false);
  }

  if (loading) return <SkeletonPage variant="table" />;

  const openRequest = requests.find(
    (request) => request.status === "requested" || request.status === "needs_review"
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">My Withdrawals</h1>
        <p className="mt-1 text-slate-500">
          Ask to withdraw from your savings, and track what the office has paid.
        </p>
      </div>

      {error && <Notice type="error">{error}</Notice>}
      {success && <Notice type="success">{success}</Notice>}

      <section className="card space-y-3" aria-labelledby="withdrawal-request-heading">
        <h2 id="withdrawal-request-heading" className="text-lg font-semibold text-slate-900">
          Ask to withdraw
        </h2>
        <p className="text-xs text-slate-600">{WITHDRAWAL_REQUEST_DISCLAIMER}</p>

        {openRequest ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-medium">
              {openRequest.reference} · {openRequest.amountLabel} · {openRequest.statusLabel}
            </p>
            <p className="mt-1 text-xs">{openRequest.nextStep}</p>
            {openRequest.canCancel && (
              <button
                type="button"
                onClick={() => void cancel(openRequest.id)}
                disabled={busy}
                className="btn btn-secondary btn-sm mt-2"
              >
                Cancel this request
              </button>
            )}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {accounts.length > 1 && (
              <label className="block text-xs font-medium text-slate-600">
                Account
                <select
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value)}
                  className="input mt-1 w-full"
                >
                  {accounts.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.accountId}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block text-xs font-medium text-slate-600">
              Amount you want (GH₵)
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="input mt-1 w-full"
                placeholder="0.00"
              />
            </label>
            <label className="block text-xs font-medium text-slate-600 sm:col-span-2">
              Why do you need it?
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                className="input mt-1 w-full"
                placeholder="Tell the office why you are withdrawing."
              />
            </label>
            <div className="sm:col-span-2">
              <button
                type="button"
                onClick={() => void submitRequest()}
                disabled={busy || !amount.trim() || reason.trim().length < 10}
                className="btn btn-primary"
              >
                {busy ? "Sending…" : "Send request"}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="withdrawal-requests-heading">
        <h2 id="withdrawal-requests-heading" className="mb-3 text-lg font-semibold text-slate-900">
          My requests
        </h2>
        {requests.length === 0 ? (
          <p className="text-sm text-slate-500">You have not asked to withdraw yet.</p>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Asked</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <tr key={request.id}>
                    <td className="font-mono text-xs">{request.reference}</td>
                    <td className="text-sm">{formatDateTime(request.createdAt)}</td>
                    <td className="font-mono">{request.amountLabel}</td>
                    <td className="text-sm">{request.statusLabel}</td>
                    <td className="text-xs text-slate-600">
                      {request.decisionNote ??
                        (request.canCancel ? (
                          <button
                            type="button"
                            onClick={() => void cancel(request.id)}
                            disabled={busy}
                            className="btn btn-secondary btn-xs"
                          >
                            Cancel
                          </button>
                        ) : (
                          "—"
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="withdrawals-paid-heading">
        <h2 id="withdrawals-paid-heading" className="mb-3 text-lg font-semibold text-slate-900">
          Withdrawals paid
        </h2>
        {withdrawals.length === 0 ? (
          <p className="text-sm text-slate-500">No withdrawals recorded.</p>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Amount Requested</th>
                  <th>Commission</th>
                  <th>Amount Paid</th>
                  <th>Balance After</th>
                  <th>Cycle</th>
                </tr>
              </thead>
              <tbody>
                {withdrawals.map((w) => (
                  <tr key={w.id}>
                    <td className="text-sm">{formatDateTime(w.createdAt)}</td>
                    <td className="font-mono">
                      <CediAmount amount={w.requestedAmount} />
                    </td>
                    <td className="font-mono text-purple-600">
                      {w.commissionAmount > 0 ? (
                        <>
                          <CediAmount amount={w.commissionAmount} />
                          <span className="ml-1 text-xs">(First withdrawal)</span>
                        </>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="font-mono font-semibold text-orange-700">
                      <CediAmount amount={w.netAmount} />
                    </td>
                    <td className="font-mono">
                      <CediAmount amount={w.remainingBalance} />
                    </td>
                    <td className="text-sm text-slate-500">Cycle {w.cycleNumber}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
