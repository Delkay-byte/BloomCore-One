"use client";

import {
  TRANSFER_STATUS_LABELS,
  TRANSFER_STATUS_TONES,
  type BranchTransferStatus,
} from "@/lib/branch-transfers";

/** Shared status pill for the branch-transfer lifecycle. */
export default function TransferStatusBadge({
  status,
  label,
}: {
  status: BranchTransferStatus;
  label?: string;
}) {
  const tone = TRANSFER_STATUS_TONES[status] ?? "neutral";
  const classes =
    tone === "positive"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : tone === "attention"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : tone === "critical"
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${classes}`}>
      {label ?? TRANSFER_STATUS_LABELS[status] ?? status}
    </span>
  );
}
