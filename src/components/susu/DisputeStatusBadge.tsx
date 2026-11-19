"use client";

import {
  DISPUTE_STATUS_LABELS,
  DISPUTE_STATUS_TONES,
  type DisputeStatus,
} from "@/lib/customer-disputes";

export default function DisputeStatusBadge({
  status,
  label,
}: {
  status: string;
  label?: string;
}) {
  const tone = DISPUTE_STATUS_TONES[status as DisputeStatus] ?? "neutral";
  const classes =
    tone === "positive"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : tone === "attention"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : tone === "critical"
          ? "border-red-200 bg-red-50 text-red-800"
          : tone === "info"
            ? "border-blue-200 bg-blue-50 text-blue-800"
            : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${classes}`}
    >
      {label ?? DISPUTE_STATUS_LABELS[status as DisputeStatus] ?? status}
    </span>
  );
}
