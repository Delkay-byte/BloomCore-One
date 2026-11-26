"use client";

import {
  SHIFT_STATUS_LABELS,
  SHIFT_STATUS_TONES,
  type ShiftStatus,
} from "@/lib/shifts";

/** Shared status pill for the shift lifecycle. */
export default function ShiftStatusBadge({
  status,
  label,
}: {
  status: string;
  label?: string;
}) {
  const tone = SHIFT_STATUS_TONES[status as ShiftStatus] ?? "neutral";
  const classes =
    tone === "positive"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : tone === "attention"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : tone === "critical"
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${classes}`}
    >
      {label ?? SHIFT_STATUS_LABELS[status as ShiftStatus] ?? status}
    </span>
  );
}
