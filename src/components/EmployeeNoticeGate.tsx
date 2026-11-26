"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import Notice from "@/components/ui/Notice";
import { acknowledgeOnboardingNotice } from "@/lib/actions/onboarding-notice.actions";
import type { OnboardingNoticeView } from "@/lib/actions/onboarding-notice.actions";

/** First-login notice gate. The password form is never rendered before acknowledgement. */
export default function EmployeeNoticeGate({
  notice,
  children,
}: {
  notice: OnboardingNoticeView | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!notice || notice.acknowledged) return <>{children}</>;

  async function acknowledge() {
    setBusy(true);
    setError("");
    try {
      const result = await acknowledgeOnboardingNotice({
        version: notice!.version,
        confirmed,
      });
      if (!result.success) {
        setError(result.error ?? "Acknowledgement failed.");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm" data-testid="employee-notice-gate">
      <h1 className="text-base font-bold text-slate-900">{notice.title}</h1>
      {notice.provisional && (
        <Notice type="warning" popup={false}>
          Provisional statutory notice: your employer has not yet published its controlled
          notice. This acknowledgement is recorded, but it does not satisfy the contribution
          gate.
        </Notice>
      )}
      <p className="mt-1 text-xs text-slate-600">
        Version {notice.version} · SHA-256 {notice.documentHash.slice(0, 16)}… · policy {notice.policyVersion}
      </p>
      {error && <Notice type="error">{error}</Notice>}
      <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-xs text-slate-700" data-testid="employee-notice-text">
        {notice.documentText}
      </pre>
      <p className="mt-3 text-xs text-slate-600">{notice.statement}</p>
      <label className="mt-4 flex items-start gap-2 text-xs font-medium text-slate-700">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          data-testid="employee-notice-confirm"
        />
        <span>I have read this notice and I acknowledge receiving it.</span>
      </label>
      <button
        type="button"
        className="btn btn-primary btn-sm mt-3"
        disabled={busy || !confirmed}
        onClick={() => void acknowledge()}
        data-testid="employee-notice-acknowledge"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
        Acknowledge and continue
      </button>
    </section>
  );
}
