"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/Modal";
import {
  issueAccountRecoveryCode,
  resetAccountMfa,
} from "@/lib/actions/account-recovery.actions";

/**
 * Administrator-assisted account recovery.
 *
 * The one-time code is rendered once and never fetched again. Administrators
 * must deliver it through an independently verified channel.
 */
export default function AdminRecoveryPanel() {
  const [targetType, setTargetType] = useState<"user" | "customer">("user");
  const [identifier, setIdentifier] = useState("");
  const [reason, setReason] = useState("");
  const [stepUpCode, setStepUpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    code: string;
    expiresAt: string;
    requestId: string;
  } | null>(null);
  const [message, setMessage] = useState("");
  const [mfaConfirmOpen, setMfaConfirmOpen] = useState(false);

  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    setResult(null);
    const response = await issueAccountRecoveryCode({
      targetType,
      targetIdentifier: identifier,
      reason,
      stepUpCode: stepUpCode || undefined,
    });
    setBusy(false);
    if (!response.success || !response.code || !response.expiresAt) {
      setError(response.error || "Could not issue a recovery code.");
      return;
    }
    setResult({
      code: response.code,
      expiresAt: response.expiresAt,
      requestId: response.requestId || "",
    });
    setStepUpCode("");
  }

  function resetMfa(e: React.FormEvent) {
    e.preventDefault();
    setMfaConfirmOpen(true);
  }

  async function performResetMfa() {
    setMfaConfirmOpen(false);
    setBusy(true);
    setError("");
    setMessage("");
    setResult(null);
    const response = await resetAccountMfa({
      targetType,
      targetIdentifier: identifier,
      reason,
      stepUpCode: stepUpCode || undefined,
    });
    setBusy(false);
    if (!response.success) {
      setError(response.error || "Could not reset MFA.");
      return;
    }
    setMessage("MFA was reset. Existing sessions were revoked; the user must enrol again.");
    setStepUpCode("");
  }

  return (
    <div className="space-y-5">
      <form onSubmit={issue} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="form-group">
            <label className="form-label" htmlFor="targetType">Account type</label>
            <select
              id="targetType"
              value={targetType}
              onChange={(e) => setTargetType(e.target.value as "user" | "customer")}
            >
              <option value="user">Staff / administrator</option>
              <option value="customer">Customer portal account</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="identifier">Account email or ID</label>
            <input
              id="identifier"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
              autoComplete="off"
            />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="reason">Reason (recorded in the audit trail)</label>
          <textarea
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={10}
            maxLength={500}
            rows={3}
            placeholder="Identity verified by phone call; user requested a reset."
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="stepUp">Your authenticator code (required if MFA is enabled)</label>
          <input
            id="stepUp"
            value={stepUpCode}
            onChange={(e) => setStepUpCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={20}
          />
        </div>

        <div className="flex flex-wrap gap-3">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Working..." : "Issue one-time recovery code"}
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={resetMfa}>
            Reset account MFA
          </button>
        </div>
      </form>

      {error && <div role="alert" className="banner banner-error text-sm">{error}</div>}
      {message && <div role="status" className="banner banner-success text-sm">{message}</div>}

      {result && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">
            This code is shown once. Deliver it through a verified channel.
          </p>
          <p className="mt-3 font-mono text-xl tracking-widest text-amber-950">
            {result.code}
          </p>
          <p className="mt-2 text-xs text-amber-800">
            Expires {new Date(result.expiresAt).toLocaleString()}. The user opens
            <strong> /recover-account</strong>, enters the code and chooses a new
            password. Existing sessions are revoked on completion.
          </p>
          {result.requestId && (
            <p className="mt-1 text-xs text-amber-700">
              Recovery request ID: {result.requestId}
            </p>
          )}
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
        <p className="font-semibold text-slate-800">Permission boundaries</p>
        <p className="mt-1">
          Tenant administrators can recover workers, agents, collectors and
          customer portal accounts in their own business. Business owners and
          tenant administrators are recovered by the BloomCore platform
          operator. Platform operators may assist any account as an escalation.
        </p>
        <p className="mt-2">
          Do not share the code in the same channel used to sign in. Verify the
          person&apos;s identity first (established phone number or in person).
        </p>
      </div>

      <ConfirmDialog
        open={mfaConfirmOpen}
        onClose={() => {
          if (!busy) setMfaConfirmOpen(false);
        }}
        onConfirm={performResetMfa}
        title="Reset account MFA?"
        description="The user will enrol a new authenticator at the next sign-in. Existing sessions are revoked."
        confirmLabel="Reset MFA"
        tone="danger"
        loading={busy}
      />
    </div>
  );
}
