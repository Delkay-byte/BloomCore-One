"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, RotateCcw, ShieldCheck } from "lucide-react";
import {
  resolveZeliPaymentExceptionAction,
  retryZeliRefundAction,
  type PlatformPaymentExceptionRow,
} from "@/lib/actions/zeli-commerce.actions";

/**
 * Payments that need a human decision. A duplicate settlement is never
 * silently lost, and a refund is never shown as successful before Paystack
 * confirms it.
 */
export default function PaymentExceptionsPanel({
  exceptions,
}: {
  exceptions: PlatformPaymentExceptionRow[];
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const open = exceptions.filter((row) => row.status === "open");

  async function retry(row: PlatformPaymentExceptionRow) {
    if (!row.subscriptionId) {
      setError("This exception has no subscription to refund. Resolve it after manual reconciliation.");
      return;
    }
    if (reason.trim().length < 10) {
      setError("Enter a reason of at least 10 characters.");
      return;
    }
    setBusy(row.id);
    setError("");
    setNotice("");
    const result = await retryZeliRefundAction(row.subscriptionId, reason);
    if (!result.success) {
      setError(result.error ?? "The refund retry failed.");
    } else {
      setNotice(`Refund request result: ${result.data?.decision ?? "requested"}.`);
      setReason("");
      router.refresh();
    }
    setBusy(null);
  }

  async function resolve(row: PlatformPaymentExceptionRow) {
    if (reason.trim().length < 10) {
      setError("Enter a resolution note of at least 10 characters.");
      return;
    }
    setBusy(row.id);
    setError("");
    setNotice("");
    const result = await resolveZeliPaymentExceptionAction(row.id, reason);
    if (!result.success) {
      setError(result.error ?? "The exception could not be resolved.");
    } else {
      setNotice("Exception resolved and audited.");
      setReason("");
      router.refresh();
    }
    setBusy(null);
  }

  if (exceptions.length === 0) return null;

  return (
    <section className="card" aria-label="Payment exceptions">
      <div className="flex items-start gap-2">
        <AlertTriangle size={18} className="mt-0.5 text-amber-600" aria-hidden />
        <div>
          <h2 className="text-lg font-bold text-slate-900">Payment exceptions</h2>
          <p className="mt-1 text-sm text-slate-600">
            {open.length} open. A duplicate settlement is recorded here until it is refunded or
            reconciled. A refund is only marked processed after Paystack confirms it.
          </p>
        </div>
      </div>
      <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="exception-reason">
        Reason / resolution note
      </label>
      <input
        id="exception-reason"
        className="mt-1 w-full"
        value={reason}
        maxLength={500}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Explain the reconciliation decision (10 characters minimum)"
      />
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-2 flex items-center gap-1 text-sm text-emerald-700">
          <ShieldCheck size={14} aria-hidden /> {notice}
        </p>
      ) : null}
      <ul className="mt-4 space-y-3">
        {exceptions.map((row) => (
          <li key={row.id} className="rounded border border-slate-200 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-semibold text-slate-900">
                  {row.kind} · {row.status}
                </p>
                <p className="text-slate-600">
                  {row.tenantCode ?? "unknown tenant"} · {row.reference ?? "no reference"}
                  {row.amount != null ? ` · ${row.currency ?? ""} ${row.amount}` : ""}
                </p>
                <p className="mt-1 text-slate-600">{row.detail}</p>
              </div>
              {row.status === "open" ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy === row.id}
                    onClick={() => retry(row)}
                  >
                    {busy === row.id ? (
                      <Loader2 size={13} className="animate-spin" aria-hidden />
                    ) : (
                      <RotateCcw size={13} aria-hidden />
                    )}{" "}
                    Retry refund
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy === row.id}
                    onClick={() => resolve(row)}
                  >
                    Mark reconciled
                  </button>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
