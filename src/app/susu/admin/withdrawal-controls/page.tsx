"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { RefreshCw, Save, ShieldCheck } from "lucide-react";
import Notice from "@/components/ui/Notice";
import CediAmount from "@/components/CediAmount";
import {
  getHighValueWithdrawalQueue,
  getWithdrawalPolicy,
  saveWithdrawalPolicy,
} from "@/lib/actions/withdrawal-control.actions";
import type { WithdrawalRequestView } from "@/lib/actions/withdrawal-request.actions";
import {
  EVIDENCE_FIELDS,
  MAX_APPROVALS,
  validateWithdrawalPolicy,
  type EvidenceField,
  type WithdrawalPolicyValues,
} from "@/lib/withdrawal-policy";

interface PolicyForm {
  active: boolean;
  minAmountPesewa: string;
  maxAmountPesewa: string;
  highValueThresholdPesewa: string;
  highValueRequiresApproval: boolean;
  requiredApprovals: string;
  separationOfDuties: boolean;
  requireStepUp: boolean;
  requirePaymentEvidence: boolean;
  requiredEvidenceFields: EvidenceField[];
}

type QueueRow = WithdrawalRequestView & {
  highValue?: boolean;
  approvalCount?: number;
  requiredApprovals?: number;
  paymentMethod?: string | null;
  paymentReference?: string | null;
  paidAt?: string | null;
};

const EVIDENCE_LABELS: Record<EvidenceField, string> = {
  paymentMethod: "Payment method",
  paymentReference: "Payment reference",
  evidenceAttachment: "Evidence reference",
  acknowledgedBy: "Acknowledged by",
};

const STATUS_BADGES: Record<string, string> = {
  requested: "badge-blue",
  needs_review: "badge-yellow",
  approved: "badge-yellow",
  awaiting_payment: "badge-yellow",
  paid: "badge-green",
  rejected: "badge-red",
  disputed: "badge-red",
  reversed: "badge-red",
  cancelled: "badge-gray",
};

function toForm(policy: WithdrawalPolicyValues): PolicyForm {
  return {
    active: policy.active,
    minAmountPesewa: String(policy.minAmountPesewa),
    maxAmountPesewa: String(policy.maxAmountPesewa),
    highValueThresholdPesewa:
      policy.highValueThresholdPesewa === null
        ? ""
        : String(policy.highValueThresholdPesewa),
    highValueRequiresApproval: policy.highValueRequiresApproval,
    requiredApprovals: String(policy.requiredApprovals),
    separationOfDuties: policy.separationOfDuties,
    requireStepUp: policy.requireStepUp,
    requirePaymentEvidence: policy.requirePaymentEvidence,
    requiredEvidenceFields: [...policy.requiredEvidenceFields],
  };
}

function parseNumber(raw: string): number | null {
  if (!raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function toValues(form: PolicyForm): { values?: WithdrawalPolicyValues; error?: string } {
  const min = parseNumber(form.minAmountPesewa);
  const max = parseNumber(form.maxAmountPesewa);
  if (min === null) return { error: "Enter a minimum amount in pesewa." };
  if (max === null) return { error: "Enter a maximum amount in pesewa." };
  const threshold =
    form.highValueThresholdPesewa.trim() === ""
      ? null
      : parseNumber(form.highValueThresholdPesewa);
  if (threshold === null && form.highValueThresholdPesewa.trim() !== "") {
    return { error: "Enter a valid high-value threshold in pesewa." };
  }
  const approvals = parseNumber(form.requiredApprovals);
  if (approvals === null) return { error: "Choose how many approvals are required." };

  const values: WithdrawalPolicyValues = {
    active: form.active,
    minAmountPesewa: min,
    maxAmountPesewa: max,
    highValueThresholdPesewa: threshold,
    highValueRequiresApproval: form.highValueRequiresApproval,
    requiredApprovals: approvals,
    separationOfDuties: form.separationOfDuties,
    requireStepUp: form.requireStepUp,
    requirePaymentEvidence: form.requirePaymentEvidence,
    requiredEvidenceFields: form.requiredEvidenceFields,
  };
  const check = validateWithdrawalPolicy(values);
  if (!check.ok) return { error: check.error ?? "Check the policy and try again." };
  return { values };
}

/**
 * Company-wide withdrawal controls.
 *
 * The server action enforces company-wide admin access and writes the policy
 * with an audit snapshot. This page only prepares values and shows the exact
 * validation or authorisation error it receives.
 */
export default function WithdrawalControlsPage() {
  const [policy, setPolicy] = useState<WithdrawalPolicyValues | null>(null);
  const [form, setForm] = useState<PolicyForm | null>(null);
  const [changeNote, setChangeNote] = useState("");
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [queueLoading, setQueueLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const loadPolicy = useCallback(async () => {
    setPolicyLoading(true);
    try {
      const result = await getWithdrawalPolicy();
      if (!result.success || !result.data) {
        setError(result.error ?? "The withdrawal policy could not be loaded.");
        return;
      }
      setPolicy(result.data);
      setForm(toForm(result.data));
    } catch {
      setError("The withdrawal policy could not be loaded.");
    } finally {
      setPolicyLoading(false);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    try {
      const result = await getHighValueWithdrawalQueue();
      if (!result.success) {
        setError(result.error ?? "The high-value queue could not be loaded.");
        return;
      }
      setQueue((result.requests ?? []) as QueueRow[]);
    } catch {
      setError("The high-value queue could not be loaded.");
    } finally {
      setQueueLoading(false);
    }
  }, []);

  const reload = useCallback(async () => {
    setError("");
    setSuccess("");
    await Promise.all([loadPolicy(), loadQueue()]);
  }, [loadPolicy, loadQueue]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function patch<K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  function toggleEvidence(field: EvidenceField) {
    setForm((current) => {
      if (!current) return current;
      const selected = current.requiredEvidenceFields.includes(field);
      return {
        ...current,
        requiredEvidenceFields: selected
          ? current.requiredEvidenceFields.filter((item) => item !== field)
          : [...current.requiredEvidenceFields, field],
      };
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    const parsed = toValues(form);
    if (!parsed.values) {
      setError(parsed.error ?? "Check the policy and try again.");
      setSuccess("");
      return;
    }
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const result = await saveWithdrawalPolicy({
        ...parsed.values,
        ...(changeNote.trim() ? { changeNote: changeNote.trim() } : {}),
      });
      if (!result.success) {
        setError(result.error ?? "The policy could not be saved.");
        return;
      }
      setSuccess("Withdrawal policy saved. The change is in the audit trail.");
      setChangeNote("");
      await loadPolicy();
    } catch {
      setError("The policy could not be saved. Check the values and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Withdrawal controls</h1>
          <p className="mt-1 text-sm text-slate-600">
            Company-wide rules for customer withdrawals. Only company-wide administrators
            can save this policy; the server refuses other roles. Amounts are whole
            pesewa (100 pesewa = GH&#x20B5;1.00).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={policyLoading || queueLoading}
          className="btn btn-secondary btn-sm"
        >
          <RefreshCw size={14} aria-hidden />
          {policyLoading || queueLoading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Notice type="error" message={error}>{error}</Notice>
          <button type="button" onClick={() => void reload()} className="btn btn-secondary btn-sm">
            Retry
          </button>
        </div>
      )}
      {success && <Notice type="success">{success}</Notice>}

      {policyLoading && !form ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading withdrawal policy">
          <div className="skeleton h-64 rounded-xl" />
          <div className="skeleton h-32 rounded-xl" />
        </div>
      ) : form ? (
        <form onSubmit={(event) => void save(event)} className="card space-y-4 p-4" aria-busy={saving}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Policy</h2>
              <p className="mt-1 text-xs text-slate-600">
                Switching the policy off keeps the original single-step withdrawal path.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(event) => patch("active", event.target.checked)}
                className="h-4 w-4"
              />
              Policy active
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-xs font-medium text-slate-700">
              Minimum withdrawal (pesewa)
              <input
                type="number"
                min={0}
                step={1}
                value={form.minAmountPesewa}
                onChange={(event) => patch("minAmountPesewa", event.target.value)}
                className="input mt-1 block w-full"
              />
            </label>
            <label className="block text-xs font-medium text-slate-700">
              Maximum withdrawal (pesewa)
              <input
                type="number"
                min={1}
                step={1}
                value={form.maxAmountPesewa}
                onChange={(event) => patch("maxAmountPesewa", event.target.value)}
                className="input mt-1 block w-full"
              />
            </label>
            <label className="block text-xs font-medium text-slate-700">
              High-value threshold (pesewa, blank to disable)
              <input
                type="number"
                min={1}
                step={1}
                value={form.highValueThresholdPesewa}
                onChange={(event) => patch("highValueThresholdPesewa", event.target.value)}
                className="input mt-1 block w-full"
              />
            </label>
            <label className="block text-xs font-medium text-slate-700">
              Required approvals
              <select
                value={form.requiredApprovals}
                onChange={(event) => patch("requiredApprovals", event.target.value)}
                className="input mt-1 block w-full"
              >
                {Array.from({ length: MAX_APPROVALS + 1 }, (_, value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-slate-500">
                0 means no separate approval step. High-value requests can still need
                approval below.
              </span>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.highValueRequiresApproval}
                onChange={(event) => patch("highValueRequiresApproval", event.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              High-value requests need approval
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.separationOfDuties}
                onChange={(event) => patch("separationOfDuties", event.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              Approvers cannot pay the same request
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.requireStepUp}
                onChange={(event) => patch("requireStepUp", event.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              Require reauthentication for approval and payment
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.requirePaymentEvidence}
                onChange={(event) => patch("requirePaymentEvidence", event.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              Require payment evidence at payment time
            </label>
          </div>

          {form.requirePaymentEvidence && (
            <fieldset className="rounded-lg bg-slate-50 p-3">
              <legend className="text-xs font-medium text-slate-700">
                Evidence fields required before payment
              </legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {EVIDENCE_FIELDS.map((field) => (
                  <label key={field} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={form.requiredEvidenceFields.includes(field)}
                      onChange={() => toggleEvidence(field)}
                      className="h-4 w-4"
                    />
                    {EVIDENCE_LABELS[field]}
                  </label>
                ))}
              </div>
              {form.requiredEvidenceFields.length === 0 && (
                <p className="mt-2 text-xs text-amber-700">
                  Choose at least one evidence field, or turn off evidence requirements.
                </p>
              )}
            </fieldset>
          )}

          <label className="block text-xs font-medium text-slate-700">
            Why this change (optional, kept in the audit trail)
            <textarea
              value={changeNote}
              onChange={(event) => setChangeNote(event.target.value)}
              rows={3}
              maxLength={500}
              className="input mt-1 block w-full"
              placeholder="For example: branch managers now approve withdrawals above GH₵1,000."
            />
          </label>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500">
              Saving never changes an existing withdrawal or ledger entry.
            </p>
            <button
              type="submit"
              disabled={saving || policyLoading}
              className="btn btn-primary btn-sm"
              aria-busy={saving}
            >
              <Save size={14} aria-hidden /> {saving ? "Saving…" : "Save policy"}
            </button>
          </div>
        </form>
      ) : null}

      <section className="space-y-3">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900">High-value queue</h2>
            <p className="mt-1 text-xs text-slate-600">
              Requests at or above the threshold. Approvals and payments are recorded in
              the withdrawal requests queue.
            </p>
          </div>
          <a href="/susu/admin/withdrawal-requests" className="btn btn-secondary btn-sm">
            Open withdrawal requests
          </a>
        </header>

        {queueLoading && queue.length === 0 ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading high-value queue">
            <div className="skeleton h-10 rounded" />
            <div className="skeleton h-12 rounded" />
            <div className="skeleton h-12 rounded" />
          </div>
        ) : queue.length === 0 ? (
          <p className="card p-4 text-sm text-slate-500">
            No high-value requests are waiting.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-control border border-line bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-brand-50 text-ink">
                <tr>
                  <th className="p-3">Reference</th>
                  <th className="p-3">Account</th>
                  <th className="p-3">Amount</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Approvals</th>
                  <th className="p-3">Payment</th>
                </tr>
              </thead>
              <tbody aria-busy={queueLoading}>
                {queue.map((request) => {
                  const stage = String(request.status);
                  return (
                    <tr key={request.id} className="border-t border-line">
                      <td className="p-3 font-mono text-xs">{request.reference}</td>
                      <td className="p-3 text-xs">{request.accountReference}</td>
                      <td className="p-3">
                        <CediAmount amount={request.amountPesewa / 100} />
                      </td>
                      <td className="p-3">
                        <span className={`badge ${STATUS_BADGES[stage] ?? "badge-gray"}`}>
                          {stage.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="p-3 text-xs">
                        {request.approvalCount ?? 0} of {request.requiredApprovals ?? 0}
                      </td>
                      <td className="p-3 text-xs">
                        {request.paymentReference
                          ? `${request.paymentMethod ?? "recorded"} · ${request.paymentReference}`
                          : request.paidAt
                            ? new Date(request.paidAt).toLocaleString("en-GB")
                            : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-slate-500" aria-hidden />
        The threshold is stored on the server. A browser cannot change how a request is
        classified.
      </p>
    </div>
  );
}
