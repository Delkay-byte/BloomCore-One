"use client";

/**
 * Branch liquidity forecast panel.
 *
 * Shows the suggested opening float, the band it came from, the backtest that chose the
 * method, and the reasoning. Nothing here transfers or reserves anything: the panel's
 * only action is to look at the numbers and go and fund the branch yourself.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, TrendingUp } from "lucide-react";
import Notice from "@/components/ui/Notice";
import {
  getBranchLiquidityForecast,
  type BranchForecastResult,
} from "@/lib/actions/liquidity-forecast.actions";

function cedi(minor: number): string {
  return `GH₵${(minor / 100).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function LiquidityForecastPanel({ locationId }: { locationId: string }) {
  const [data, setData] = useState<BranchForecastResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!locationId) return;
    setBusy(true);
    setError("");
    try {
      const result = await getBranchLiquidityForecast({ locationId });
      if (result.success) setData(result.data);
      else setError(result.error);
    } finally {
      setBusy(false);
    }
  }, [locationId]);

  useEffect(() => {
    // Deferred by a tick so the first render is not immediately interrupted by a
    // synchronous setState from the fetch.
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  if (!locationId) return null;

  return (
    <section
      className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm"
      data-testid="liquidity-forecast"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <TrendingUp size={15} aria-hidden /> Float you will need
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-slate-600">
            Worked out from this branch&apos;s own past days, checked against them, and
            explained step by step. It suggests a figure; it never moves float.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-xs"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          Recalculate
        </button>
      </div>

      {error && <Notice type="error">{error}</Notice>}

      {data && (
        <div className="mt-3 space-y-3 text-xs" data-testid="liquidity-forecast-result">
          {data.empty ? (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-slate-700">
              This branch has no recorded days yet, so there is nothing to forecast from.
              Once a few days of transactions are recorded, this panel will suggest a
              float for the next day.
            </p>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-lg bg-slate-900 px-3 py-2 text-white">
                  <p className="text-[11px] uppercase tracking-wide text-slate-300">
                    Suggested opening float · {data.forecast.targetDate}
                  </p>
                  <p className="text-lg font-bold">
                    {cedi(data.forecast.suggestedOpeningFloatMinor)}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-100 px-3 py-2">
                  <p className="text-[11px] text-slate-500">Expected paid out</p>
                  <p className="text-sm font-semibold text-slate-900">
                    {cedi(data.forecast.expectedOutflowMinor)}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-100 px-3 py-2">
                  <p className="text-[11px] text-slate-500">Expected taken in</p>
                  <p className="text-sm font-semibold text-slate-900">
                    {cedi(data.forecast.expectedInflowMinor)}
                  </p>
                </div>
              </div>

              <p className="text-slate-600">
                {data.forecast.methodLabel} · {data.forecast.sampleSize} day
                {data.forecast.sampleSize === 1 ? "" : "s"} of history ·{" "}
                {Math.round(data.forecast.serviceLevel * 100)}% band
                {data.forecast.backtest
                  ? ` · ${Math.round(data.forecast.backtest.meanAbsolutePercentageError * 100)}% mean error, ${Math.round(data.forecast.backtest.bandCoverage * 100)}% of past days inside the band`
                  : " · not yet backtested"}
              </p>

              <ul className="list-disc space-y-1 pl-4 text-slate-600">
                {data.forecast.explanation.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}

          <p className="text-[11px] text-slate-500">
            A suggestion, not an instruction. MaaCash does not transfer, request or
            reserve float from this forecast.
          </p>
        </div>
      )}
    </section>
  );
}
