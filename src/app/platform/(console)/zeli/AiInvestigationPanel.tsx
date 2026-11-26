"use client";

import { useState } from "react";
import { BadgeCheck, Loader2, ShieldAlert } from "lucide-react";
import {
  activateAiInvestigation,
  getAiInvestigationAdminState,
  revokeAiInvestigation,
  type AiInvestigationAdminState,
} from "@/lib/actions/ai-investigation-admin.actions";

/**
 * Platform Super Admin control for the AI Investigation package.
 *
 * Payment is shown as the provider confirmed it, the activation is a separate
 * decision, and revocation takes effect on the next request rather than when a cache
 * expires. Every button here needs a written reason and writes a platform audit row.
 */
function money(value: number | null, currency: string | null): string {
  if (value === null) return "—";
  return `${currency ?? "GHS"} ${value.toFixed(2)}`;
}

function stamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export default function AiInvestigationPanel({
  initial,
}: {
  initial: AiInvestigationAdminState;
}) {
  const [state, setState] = useState(initial);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refresh() {
    const result = await getAiInvestigationAdminState();
    if (result.success && result.data) setState(result.data);
  }

  async function run(
    action: () => Promise<{ success: boolean; error?: string }>,
    message: string
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await action();
      if (!result.success) {
        setError(result.error ?? "The change could not be saved.");
        return;
      }
      setNotice(message);
      setReason("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5" data-testid="ai-package-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <BadgeCheck size={16} aria-hidden /> AI Investigation package
          </h2>
          <p className="mt-1 max-w-3xl text-xs text-slate-600">
            External AI over real financial evidence is approved only for this paid
            package. A confirmed payment is required, and so is activation here: a
            payment alone never switches the feature on. Tenant administrators cannot
            activate it, and a revoked activation stops access on the next request.
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
          {state.codeApproved ? "Deployment approval: present" : "Deployment approval: absent"}
        </span>
      </div>

      {error ? <p className="notice notice-danger mt-3 text-xs">{error}</p> : null}
      {notice ? <p className="notice mt-3 text-xs">{notice}</p> : null}

      <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
        {state.packages.length === 0 ? (
          <p>
            No AI Investigation package is configured. Set the approved price in the
            commerce panel first: this screen never invents one.
          </p>
        ) : (
          <ul className="space-y-1">
            {state.packages.map((plan) => (
              <li key={plan.id}>
                <span className="font-semibold text-slate-900">{plan.name}</span> ·{" "}
                {money(plan.price, plan.currency)} / {plan.billingInterval} · allowance{" "}
                {plan.allowance ?? "unset"} requests a month · {plan.status}
              </li>
            ))}
          </ul>
        )}
      </div>

      <label className="mt-3 block text-xs font-semibold text-slate-700">
        Reason for this change (required, written to the audit trail)
        <input
          className="input mt-1 text-xs"
          data-testid="ai-package-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="e.g. Payment verified in Paystack and the business requested the package"
        />
      </label>

      <div className="mt-3 overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Business</th>
              <th>Package</th>
              <th>Payment</th>
              <th>Paid period ends</th>
              <th>Activation</th>
              <th>Used this month</th>
              <th>Next step</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.businesses.map((row) => (
              <tr key={row.tenantId} data-testid={`ai-row-${row.tenantCode}`}>
                <td className="text-xs font-medium">
                  {row.tenantName}
                  <span className="block font-mono text-[10px] text-slate-400">{row.tenantCode}</span>
                </td>
                <td className="text-xs">
                  {row.planName ?? "—"}
                  {row.allowance !== null ? (
                    <span className="block text-slate-400">{row.allowance}/month</span>
                  ) : null}
                </td>
                <td className="text-xs">
                  {row.paymentConfirmed ? (
                    <span className="text-emerald-700">Confirmed {stamp(row.paidAt)}</span>
                  ) : (
                    <span className="text-amber-700">Not confirmed</span>
                  )}
                  <span className="block text-slate-400">{row.subscriptionStatus ?? "—"}</span>
                </td>
                <td className="text-xs">{stamp(row.periodEnd)}</td>
                <td className="text-xs">
                  {row.activationStatus === "active" ? (
                    <span className="text-emerald-700">
                      Active until {stamp(row.expiresAt)}
                      <span className="block text-slate-400">by {row.activatedByEmail ?? "platform"}</span>
                    </span>
                  ) : row.activationStatus === "revoked" ? (
                    <span className="text-red-700">
                      Revoked
                      {row.revokeReason ? (
                        <span className="block text-slate-400">{row.revokeReason}</span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-amber-700">Not activated</span>
                  )}
                </td>
                <td className="text-xs tnum">{row.usedThisMonth}</td>
                <td className="text-xs text-slate-600">{row.nextStep}</td>
                <td className="text-xs">
                  {row.activationStatus === "active" ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      disabled={busy || reason.trim().length < 10}
                      data-testid={`ai-revoke-${row.tenantCode}`}
                      onClick={() =>
                        run(
                          () =>
                            revokeAiInvestigation({
                              tenantId: row.tenantId,
                              reason,
                            }),
                          `Activation revoked for ${row.tenantName}. Access stops on the next request.`
                        )
                      }
                    >
                      {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                      Revoke
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-xs"
                      disabled={busy || !row.paymentCurrent || reason.trim().length < 10}
                      data-testid={`ai-activate-${row.tenantCode}`}
                      onClick={() =>
                        run(
                          () =>
                            activateAiInvestigation({
                              tenantId: row.tenantId,
                              reason,
                            }),
                          `Activation recorded for ${row.tenantName}.`
                        )
                      }
                    >
                      {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                      Activate
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {state.businesses.length === 0 ? (
              <tr>
                <td className="text-xs text-slate-500" colSpan={8}>
                  No business has a paid AI Investigation package yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="mt-3 flex items-start gap-2 text-[11px] text-slate-500">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden />
        Accepting an AI draft never changes a finding, a transaction or a balance. The
        feature can also be switched off for the whole deployment with one operator
        setting.
      </p>
    </section>
  );
}
