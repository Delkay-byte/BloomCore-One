"use client";

import Link from "next/link";
import { ArrowLeft, MessageSquareWarning, Printer, ShieldCheck } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import type { SusuReceipt } from "@/lib/susu-statements";

function fmt(value: string): string {
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Printable customer receipt built only from a recorded contribution or
 * withdrawal. The reference shown is the original transaction reference; no
 * separate receipt sequence is invented.
 */
export default function SusuReceiptDocument({
  receipt,
  backHref,
  disputeHref,
}: {
  receipt: SusuReceipt;
  backHref?: string;
  disputeHref?: string;
}) {
  const isContribution = receipt.kind === "contribution";
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {backHref && (
        <div className="print:hidden">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to statement
          </Link>
        </div>
      )}

      <article className="card overflow-hidden p-0">
        <header className="border-b border-slate-200 bg-slate-50 px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {receipt.businessName}
          </p>
          <div className="mt-1 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h1 className="text-xl font-bold text-slate-900">
                {isContribution ? "Contribution receipt" : "Withdrawal receipt"}
              </h1>
              <p className="mt-1 text-sm text-slate-600">
                Receipt number <strong>{receipt.reference}</strong>
              </p>
            </div>
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                receipt.isReversal || receipt.status === "reversed"
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : "border-emerald-200 bg-emerald-50 text-emerald-800"
              }`}
            >
              {receipt.isReversal
                ? "Reversal"
                : receipt.status === "reversed"
                  ? "Reversed"
                  : "Completed"}
            </span>
          </div>
        </header>

        <div className="px-6 py-5">
          {receipt.isReversal && (
            <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              This receipt records a reversal of an earlier transaction. It is not
              a new contribution or payout.
            </p>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-4 text-center">
            <p className="text-xs uppercase tracking-wide text-slate-500">
              {isContribution ? "Amount received" : "Net amount paid"}
            </p>
            <p className="mt-1 text-3xl font-bold text-slate-900">
              <CediAmount amount={receipt.netAmount} showSign />
            </p>
            {!isContribution && receipt.commissionAmount !== 0 && (
              <p className="mt-1 text-xs text-slate-500">
                Requested <CediAmount amount={receipt.amount} /> · commission{" "}
                <CediAmount amount={receipt.commissionAmount} />
              </p>
            )}
          </div>

          <dl className="mt-5 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Detail label="Customer" value={receipt.customer.fullName} />
            <Detail label="Customer number" value={receipt.customer.customerId} />
            <Detail label="Account" value={receipt.accountNumber} />
            <Detail label="Cycle" value={String(receipt.cycleNumber)} />
            <Detail label="Date and time" value={fmt(receipt.issuedAt)} />
            <Detail
              label="Channel"
              value={
                receipt.channel === "collector"
                  ? "Paid to collector"
                  : receipt.channel === "direct_office"
                    ? "Paid at office"
                    : receipt.channel === "reversal"
                      ? "Reversal"
                      : receipt.channel.replace(/_/g, " ")
              }
            />
            <Detail
              label={isContribution ? "Received by" : "Paid by"}
              value={receipt.receivedBy ?? "Office"}
            />
            {receipt.customer.phone && (
              <Detail label="Phone" value={receipt.customer.phone} />
            )}
          </dl>

          {receipt.notes && (
            <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
              <span className="font-semibold">Notes: </span>
              {receipt.notes}
            </div>
          )}

          <div className="mt-5 flex items-start gap-2 border-t border-slate-100 pt-4 text-[11px] text-slate-500">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden />
            <p>
              This receipt is generated from the transaction recorded in MaaCash.
              Keep the receipt number for any query. It matches the original
              recorded reference, and any change to the transaction remains
              separately visible in the audit trail.
            </p>
          </div>
        </div>
      </article>

      <div className="flex flex-wrap gap-2 print:hidden">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => window.print()}
        >
          <Printer className="h-4 w-4" aria-hidden /> Print or save as PDF
        </button>
        {disputeHref && (
          <Link href={disputeHref} className="btn btn-secondary">
            <MessageSquareWarning className="h-4 w-4" aria-hidden /> Dispute this record
          </Link>
        )}
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="break-words font-medium text-slate-900">{value}</dd>
    </div>
  );
}
