"use client";

export default function ZeliThinkingIndicator() {
  return (
    <div
      className="inline-flex max-w-full items-center gap-3 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-700"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="flex items-center gap-1" aria-hidden="true">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="h-1.5 w-1.5 rounded-full bg-slate-500 motion-safe:animate-bounce"
            style={{ animationDelay: `${dot * 150}ms`, animationDuration: "900ms" }}
          />
        ))}
      </span>
      <span>Zeli is reading your records…</span>
      <span className="sr-only">Please wait. This can take a moment.</span>
    </div>
  );
}
