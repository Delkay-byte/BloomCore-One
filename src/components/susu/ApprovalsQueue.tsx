"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ShieldCheck, XCircle } from "lucide-react";
import PasswordInput from "@/components/PasswordInput";
import { verifyPasswordAction } from "@/lib/actions/auth.actions";
import {
  approveFinancialApproval,
  rejectFinancialApproval,
} from "@/lib/actions/financial-approval.actions";
import type { ApprovalRow } from "@/lib/security/dual-control";
import type { StepUpPurpose } from "@/lib/security/step-up";
import CediAmount from "@/components/CediAmount";

const LABELS: Record<string, string> = {
  "susu.withdrawal.reverse": "Withdrawal reversal",
  "susu.contribution.reverse": "Contribution reversal",
  "susu.remittance.reverse": "Money handed-in reversal",
};

/**
 * Residual E: the maker-checker queue. A different administrator reviews the
 * recorded reason, confirms their own password (which creates a purpose-bound
 * step-up grant) and applies the correction. Nothing is posted until then.
 */
export default function ApprovalsQueue({ initial }: { initial: ApprovalRow[] }) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function approve(row: ApprovalRow) {
    setBusy(true);
    setError("");
    try {
      const stepUp = await verifyPasswordAction(password, {
        module: "admin",
        purpose: row.action as StepUpPurpose,
        targetType: row.targetType,
        targetId: row.targetId,
      });
      if (!stepUp.success) {
        setError(stepUp.error || "Could not confirm your password.");
        return;
      }
      const token = (stepUp.data as { stepUpToken?: string } | undefined)?.stepUpToken;
      const result = await approveFinancialApproval(row.id, token);
      if (!result.success) {
        setError(result.error || "The correction could not be posted.");
        return;
      }
      setPassword("");
      setOpenId(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function reject(row: ApprovalRow) {
    setBusy(true);
    setError("");
    try {
      const result = await rejectFinancialApproval(row.id, note);
      if (!result.success) {
        setError(result.error || "The request could not be rejected.");
        return;
      }
      setNote("");
      setOpenId(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (initial.length === 0) {
    return (
      <div className="card text-center text-sm text-slate-500">
        <ShieldCheck className="mx-auto mb-2 text-emerald-600" size={22} aria-hidden />
        No financial corrections are waiting for a second administrator.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div role="alert" className="banner banner-error">
          {error}
        </div>
      )}
      {initial.map((row) => (
        <article key={row.id} className="card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                {LABELS[row.action] ?? row.action}
              </h2>
              <p className="mt-1 text-sm text-slate-600">{row.reason}</p>
              <p className="mt-2 text-xs text-slate-500">
                Requested by {row.requestedByEmail} on{" "}
                {new Date(row.createdAt).toLocaleString()} · expires{" "}
                {new Date(row.expiresAt).toLocaleString()}
              </p>
            </div>
            {typeof row.amountMinor === "number" && (
              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-slate-400">Amount</p>
                <p className="text-lg font-semibold text-slate-900">
                  <CediAmount amount={row.amountMinor / 100} />
                </p>
              </div>
            )}
          </div>

          {openId === row.id ? (
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor={`password-${row.id}`}>
                  Your password
                </label>
                <PasswordInput
                  id={`password-${row.id}`}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor={`note-${row.id}`}>
                  Rejection note (only needed to reject)
                </label>
                <input
                  id={`note-${row.id}`}
                  className="input"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={300}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || password.length === 0}
                  onClick={() => approve(row)}
                >
                  <CheckCircle2 size={16} aria-hidden /> Approve and post
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || note.trim().length < 3}
                  onClick={() => reject(row)}
                >
                  <XCircle size={16} aria-hidden /> Reject
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => {
                    setOpenId(null);
                    setError("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-secondary mt-4"
              onClick={() => {
                setOpenId(row.id);
                setError("");
                setPassword("");
                setNote("");
              }}
            >
              Review and confirm
            </button>
          )}
        </article>
      ))}
    </div>
  );
}
