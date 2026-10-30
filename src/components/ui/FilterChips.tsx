"use client";

import { X } from "lucide-react";

/**
 * Active-filter chips for history/filter pages: the current filter state is
 * always visible, each chip can be removed individually, and the whole set
 * can be reset. The parent owns the filter state — chips are a pure view.
 */
export default function FilterChips({
  chips,
  onRemove,
  onReset,
  resetLabel = "Reset filters",
}: {
  chips: { key: string; label: string; value: string }[];
  onRemove: (key: string) => void;
  onReset?: () => void;
  resetLabel?: string;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">Active filters:</span>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1.5 bg-brand-50 border border-brand-200 text-brand-800 rounded-full pl-2.5 pr-1.5 py-1 text-xs font-medium"
        >
          <span className="text-brand-500">{chip.label}:</span> {chip.value}
          <button
            type="button"
            onClick={() => onRemove(chip.key)}
            className="rounded-full hover:bg-brand-200 p-0.5 transition-colors"
            aria-label={`Remove filter ${chip.label}: ${chip.value}`}
          >
            <X size={12} aria-hidden />
          </button>
        </span>
      ))}
      {onReset && chips.length > 1 && (
        <button
          type="button"
          onClick={onReset}
          className="text-xs text-slate-500 underline underline-offset-2 hover:text-slate-700 ml-1"
        >
          {resetLabel}
        </button>
      )}
    </div>
  );
}
