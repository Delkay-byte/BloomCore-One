"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  grantRiskPrivacyAccess,
  revokeRiskPrivacyAccess,
} from "@/lib/actions/risk-organisation.actions";

export interface PrivacyCandidate {
  id: string;
  fullName: string;
  email: string;
  tenantName: string;
}

export interface ActivePrivacyGrant {
  userId: string;
  fullName: string;
  email: string;
  role: string;
  reason: string;
}

/**
 * Platform-owner grant of the least-privilege privacy console. This is not a
 * DPO appointment and is not a condition of business or agent onboarding.
 */
export default function PrivacyAccessPanel({
  candidates,
  grants,
}: {
  candidates: PrivacyCandidate[];
  grants: ActivePrivacyGrant[];
}) {
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"privacy_admin" | "privacy_reviewer">("privacy_reviewer");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function grant() {
    setPending(true);
    setMessage("");
    setError("");
    try {
      const result = await grantRiskPrivacyAccess({ userId, role, reason });
      if (!result.success) {
        setError(result.error ?? "The grant could not be recorded.");
        return;
      }
      setMessage("Privacy access granted. It can be revoked at any time.");
      setUserId("");
      setReason("");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function revoke(target: string) {
    setPending(true);
    setMessage("");
    setError("");
    try {
      const result = await revokeRiskPrivacyAccess({ userId: target, reason });
      if (!result.success) {
        setError(result.error ?? "The revocation could not be recorded.");
        return;
      }
      setMessage("Privacy access revoked.");
      setReason("");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-xl border border-line bg-white p-5" data-testid="privacy-access-panel">
      <h2 className="text-base font-semibold text-ink-deep">Privacy access</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Optional least-privilege access for an existing active business administrator. This does not
        appoint a DPO, create an account, or block business, agent or risk-intelligence onboarding.
      </p>
      {message && <p className="mt-2 text-sm text-emerald-700">{message}</p>}
      {error && <p className="mt-2 text-sm text-red-700" role="alert">{error}</p>}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-ink">
          Existing administrator
          <select className="input mt-1 w-full" value={userId} onChange={(event) => setUserId(event.target.value)}>
            <option value="">Choose an active administrator</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.fullName} · {candidate.email} · {candidate.tenantName}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-ink">
          Role
          <select className="input mt-1 w-full" value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
            <option value="privacy_reviewer">Privacy reviewer</option>
            <option value="privacy_admin">Privacy administrator</option>
          </select>
        </label>
        <label className="text-xs font-medium text-ink sm:col-span-2">
          Reason
          <input className="input mt-1 w-full" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="At least 20 characters" />
        </label>
      </div>
      <button
        type="button"
        className="btn btn-primary btn-sm mt-3"
        disabled={pending || !userId || reason.trim().length < 20}
        onClick={() => void grant()}
      >
        {pending ? "Saving…" : "Grant privacy access"}
      </button>

      <div className="mt-5 border-t border-line pt-3">
        <h3 className="text-sm font-semibold text-ink-deep">Active grants</h3>
        {grants.length === 0 ? (
          <p className="mt-2 text-xs text-ink-muted">No grant recorded. No onboarding step waits for one.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {grants.map((grant) => (
              <li key={grant.userId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-xs">
                <span>
                  <strong>{grant.fullName}</strong> · {grant.email} · {grant.role === "privacy_admin" ? "Privacy administrator" : grant.role === "dpo" ? "Legacy (inactive)" : "Privacy reviewer"}
                  <span className="block text-ink-muted">{grant.reason}</span>
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  disabled={pending || reason.trim().length < 10}
                  onClick={() => void revoke(grant.userId)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-ink-muted">Revocation uses the same reason above (minimum 10 characters).</p>
      </div>
    </section>
  );
}
