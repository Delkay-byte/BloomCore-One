"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { cancelZeliSubscriptionAction } from "@/lib/actions/zeli-billing.actions";
import { ConfirmDialog } from "@/components/ui/Modal";

export default function SubscriptionCard({
  summary,
}: {
  summary: {
    planName: string;
    status: string;
    periodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!summary) return null;

  async function cancel() {
    setConfirmOpen(false);
    setBusy(true);
    setError("");
    try {
      const result = await cancelZeliSubscriptionAction();
      if (!result.success) {
        setError(result.error ?? "Cancellation failed.");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card bg-white text-sm">
      <h2 className="font-semibold text-brand-900">Subscription</h2>
      <p className="mt-1 text-slate-700">{summary.planName}</p>
      <p className="text-xs text-slate-500">
        Status: {summary.status}
        {summary.periodEnd ? ` · renews/ends ${summary.periodEnd.slice(0, 10)}` : ""}
      </p>
      {summary.cancelAtPeriodEnd ? (
        <p className="mt-2 text-xs text-amber-700">Renewal is cancelled; access ends with the paid period.</p>
      ) : (
        <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={() => setConfirmOpen(true)} disabled={busy}>
          {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
          Cancel renewal
        </button>
      )}
      {error && <p className="mt-2 text-xs text-red-700" role="alert">{error}</p>}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => {
          if (!busy) setConfirmOpen(false);
        }}
        onConfirm={cancel}
        title="Cancel renewal?"
        description="Access remains until the paid period ends."
        confirmLabel="Cancel renewal"
        tone="danger"
        loading={busy}
      />
    </div>
  );
}
