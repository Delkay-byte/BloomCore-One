"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ClipboardCheck, RefreshCw, Save, Send, Vault } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import LiquidityForecastPanel from "@/components/LiquidityForecastPanel";
import Notice from "@/components/ui/Notice";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import {
  getLiquidityBoard,
  reviewLiquiditySnapshot,
  saveLiquiditySnapshot,
  submitLiquiditySnapshot,
  type LiquidityBoard,
  type LiquidityLocationView,
} from "@/lib/actions/branch-liquidity.actions";
import {
  BRANCH_ASSET_DEFINITIONS,
  BRANCH_ASSET_TYPES,
  type BranchAssetType,
} from "@/lib/branch-transfers";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function cediInput(minor: number): string {
  return minor === 0 ? "" : (minor / 100).toFixed(2);
}

function parseCedi(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return Number.NaN;
  return Math.round(parsed * 100);
}

interface LineDraft {
  opening: string;
  counted: string;
  note: string;
}

type Drafts = Record<string, Partial<Record<BranchAssetType, LineDraft>>>;

const STATUS_TONE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  submitted: "bg-amber-100 text-amber-800",
  reviewed: "bg-emerald-100 text-emerald-800",
};

function initialDrafts(board: LiquidityBoard): Drafts {
  const next: Drafts = {};
  for (const location of board.locations) {
    const lines: Partial<Record<BranchAssetType, LineDraft>> = {};
    for (const asset of BRANCH_ASSET_TYPES) {
      const line = location.lines.find((entry) => entry.assetType === asset);
      if (line) {
        lines[asset] = {
          opening: cediInput(line.openingDeclaredMinor),
          counted: cediInput(line.countedCloseMinor),
          note: line.note ?? "",
        };
      } else {
        const prefill = location.declaredDefaults.find((entry) => entry.assetType === asset);
        lines[asset] = {
          opening: cediInput(prefill?.declaredMinor ?? 0),
          counted: "",
          note: "",
        };
      }
    }
    next[location.locationId] = lines;
  }
  return next;
}

export default function BranchLiquidityPage() {
  const [businessDate, setBusinessDate] = useState(today());
  const [board, setBoard] = useState<LiquidityBoard | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [loading, setLoading] = useState(true);
  const [busyLocation, setBusyLocation] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [reviewNote, setReviewNote] = useState<Record<string, string>>({});
  const handleRedirect = useRedirectHandler();

  // True once the operator has typed something that the server does not have
  // yet. A board refresh that arrives after that must not overwrite their work.
  const edited = useRef(false);

  const load = useCallback(async (date: string) => {
    setLoading(true);
    setError("");
    try {
      const next = await getLiquidityBoard(date);
      setBoard(next);
      // A response that arrives after the operator started typing describes the
      // state before their work, so it must not overwrite the form.
      if (!edited.current) setDrafts(initialDrafts(next));
    } catch (err) {
      // Billing/role/branch redirects are destinations, not failed loads.
      handleRedirect(
        err,
        setError,
        "The liquidity board could not be loaded. Check your connection and try again."
      );
    } finally {
      setLoading(false);
    }
  }, [handleRedirect]);

  useEffect(() => {
    void load(businessDate);
  }, [businessDate, load]);

  const editable = useCallback((location: LiquidityLocationView) => location.status === "draft", []);

  function updateLine(
    locationId: string,
    asset: BranchAssetType,
    patch: Partial<LineDraft>
  ) {
    edited.current = true;
    setDrafts((current) => ({
      ...current,
      [locationId]: {
        ...current[locationId],
        [asset]: { ...current[locationId]?.[asset], ...patch } as LineDraft,
      },
    }));
  }

  async function save(location: LiquidityLocationView) {
    const lines = drafts[location.locationId] ?? {};
    // Only assets the operator actually worked on are sent. Sending an untouched
    // asset would record a declaration of zero, which is a real claim about the
    // branch rather than an absence of one.
    const payload = BRANCH_ASSET_TYPES.flatMap((asset) => {
      const draft = lines[asset];
      const opening = draft?.opening?.trim() ?? "";
      const counted = draft?.counted?.trim() ?? "";
      const note = draft?.note?.trim() ?? "";
      if (!opening && !counted && !note) return [];
      const openingMinor = parseCedi(opening);
      const countedMinor = parseCedi(counted);
      if (!Number.isFinite(openingMinor) || !Number.isFinite(countedMinor)) return [];
      return [
        {
          assetType: asset,
          openingDeclaredMinor: openingMinor,
          countedCloseMinor: countedMinor,
          note: note || undefined,
        },
      ];
    });

    if (payload.length === 0) {
      setError("Enter at least one opening or counted balance for this branch.");
      return;
    }

    setBusyLocation(location.locationId);
    setError("");
    setSuccess("");
    try {
      const result = await saveLiquiditySnapshot({
        locationId: location.locationId,
        businessDate,
        dailyAccountId: location.dailyAccountId ?? undefined,
        lines: payload,
      });
      if (!result.success) {
        setError(result.error ?? "The snapshot could not be saved.");
        return;
      }
      setSuccess(`Snapshot saved for ${location.locationName}.`);
      edited.current = false;
      await load(businessDate);
    } catch {
      setError("The snapshot could not be saved. Your figures stay on this page.");
    } finally {
      setBusyLocation(null);
    }
  }

  async function submit(location: LiquidityLocationView) {
    if (!location.snapshotId) {
      setError("Save the snapshot before submitting it.");
      return;
    }
    setBusyLocation(location.locationId);
    setError("");
    setSuccess("");
    try {
      const result = await submitLiquiditySnapshot(location.snapshotId);
      if (!result.success) {
        setError(result.error ?? "The snapshot could not be submitted.");
        return;
      }
      setSuccess(`Snapshot submitted for review at ${location.locationName}.`);
      edited.current = false;
      await load(businessDate);
    } finally {
      setBusyLocation(null);
    }
  }

  async function review(location: LiquidityLocationView) {
    if (!location.snapshotId) return;
    setBusyLocation(location.locationId);
    setError("");
    setSuccess("");
    try {
      const result = await reviewLiquiditySnapshot({
        id: location.snapshotId,
        note: reviewNote[location.locationId]?.trim() || undefined,
        openCase: location.totals.shortLines > 0,
      });
      if (!result.success) {
        setError(result.error ?? "The snapshot could not be reviewed.");
        return;
      }
      const caseId = (result.data as { caseId?: string | null } | undefined)?.caseId;
      setSuccess(
        caseId
          ? `Reviewed. A reconciliation case was opened for the shortfall.`
          : `Reviewed. ${location.locationName} is balanced.`
      );
      edited.current = false;
      await load(businessDate);
    } finally {
      setBusyLocation(null);
    }
  }

  const totals = board?.totals;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Branch Liquidity</h1>
          <p className="mt-1 text-sm text-slate-600">
            Declare the opening position, count the close, and compare the two against the
            transfers the system already recorded.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-xs font-medium text-slate-600">
            Business date
            <input
              type="date"
              value={businessDate}
              onChange={(event) => setBusinessDate(event.target.value)}
              className="input mt-1 block"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              edited.current = false;
              void load(businessDate);
            }}
            className="btn btn-secondary btn-sm"
            disabled={loading}
          >
            <RefreshCw size={14} aria-hidden />
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error && (
        <Notice type="error" message={error}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => void load(businessDate)}
              className="btn btn-secondary btn-sm"
            >
              Try again
            </button>
          </div>
        </Notice>
      )}
      {success && <Notice type="success" message={success}>{success}</Notice>}

      {board && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" role="note">
          {board.disclaimer}
        </p>
      )}

      {loading && !board && (
        <div className="space-y-3" aria-busy="true" aria-label="Loading liquidity board">
          <div className="skeleton h-28 rounded-xl" />
          <div className="skeleton h-28 rounded-xl" />
        </div>
      )}

      {board && board.locations.length === 0 && (
        <div className="card p-6 text-sm text-slate-600">
          No active branch has been created for this business yet.{" "}
          <Link href="/admin/locations" className="font-semibold text-brand-700 hover:underline">
            Add a branch
          </Link>{" "}
          to start declaring a daily position.
        </div>
      )}

      {board && board.locations.length > 0 && (
        <div className="flex flex-wrap gap-3">
          <SummaryTile label="Counted close (all branches)" minor={totals?.counted ?? 0} />
          <SummaryTile label="Expected close" minor={totals?.expected ?? 0} />
          <SummaryTile
            label="Variance"
            minor={totals?.variance ?? 0}
            tone={(totals?.variance ?? 0) < 0 ? "bad" : (totals?.variance ?? 0) > 0 ? "warn" : "good"}
          />
          <div className="card flex-1 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Branches short
            </p>
            <p className="mt-1 text-2xl font-bold tnum">
              {totals?.shortBranches ?? 0}
              <span className="ml-1 text-sm font-medium text-slate-500">
                of {board.locations.length}
              </span>
            </p>
          </div>
        </div>
      )}

      {board?.locations.map((location) => {
        const lines = drafts[location.locationId] ?? {};
        const isBusy = busyLocation === location.locationId;
        const canEdit = editable(location);
        return (
          <section key={location.locationId} className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="flex items-center gap-2">
                <Vault size={16} className="text-brand-700" aria-hidden />
                <div>
                  <h2 className="font-semibold text-slate-900">{location.locationName}</h2>
                  <p className="text-xs text-slate-500">{location.locationCode}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    STATUS_TONE[location.status] ?? "bg-slate-100 text-slate-700"
                  }`}
                >
                  {location.statusLabel}
                </span>
                {location.dailyAccountDifference !== null && (
                  <span className="text-xs text-slate-500">
                    Daily close difference:{" "}
                    <CediAmount amount={location.dailyAccountDifference} />
                  </span>
                )}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2">Asset</th>
                    <th className="px-3 py-2">Opening declared</th>
                    <th className="px-3 py-2">Transfers</th>
                    <th className="px-3 py-2">Expected close</th>
                    <th className="px-3 py-2">Counted close</th>
                    <th className="px-3 py-2">Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {BRANCH_ASSET_TYPES.map((asset) => {
                    const line = location.lines.find((entry) => entry.assetType === asset);
                    const draft = lines[asset];
                    const definition = BRANCH_ASSET_DEFINITIONS[asset];
                    return (
                      <tr key={asset} className="border-t border-slate-100 align-top">
                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-900">{definition.shortLabel}</p>
                          <p className="text-xs text-slate-500">
                            {definition.kind === "cash" ? "Cash" : `Float · ${definition.network}`}
                          </p>
                        </td>
                        <td className="px-3 py-3">
                          {canEdit ? (
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              inputMode="decimal"
                              aria-label={`${definition.shortLabel} opening declared`}
                              value={draft?.opening ?? ""}
                              onChange={(event) =>
                                updateLine(location.locationId, asset, { opening: event.target.value })
                              }
                              className="input w-28 text-right tnum"
                            />
                          ) : (
                            <CediAmount amount={(line?.openingDeclaredMinor ?? 0) / 100} className="tnum" />
                          )}
                        </td>
                        <td className="px-3 py-3 text-slate-600">
                          <CediAmount amount={(line?.transferAdjustmentMinor ?? 0) / 100} className="tnum" />
                        </td>
                        <td className="px-3 py-3 font-medium">
                          <CediAmount amount={(line?.expectedCloseMinor ?? 0) / 100} className="tnum" />
                        </td>
                        <td className="px-3 py-3">
                          {canEdit ? (
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              inputMode="decimal"
                              aria-label={`${definition.shortLabel} counted close`}
                              value={draft?.counted ?? ""}
                              onChange={(event) =>
                                updateLine(location.locationId, asset, { counted: event.target.value })
                              }
                              className="input w-28 text-right tnum"
                            />
                          ) : (
                            <CediAmount amount={(line?.countedCloseMinor ?? 0) / 100} className="tnum" />
                          )}
                        </td>
                        <td className="px-3 py-3">
                          {line ? (
                            <span
                              className={`inline-flex items-center gap-1 font-semibold tnum ${
                                line.state === "short"
                                  ? "text-red-700"
                                  : line.state === "over"
                                    ? "text-amber-700"
                                    : "text-emerald-700"
                              }`}
                            >
                              {line.state === "short" && <AlertTriangle size={13} aria-hidden />}
                              <CediAmount amount={line.varianceMinor / 100} />
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">Not declared</span>
                          )}
                          {canEdit && (
                            <input
                              type="text"
                              maxLength={300}
                              placeholder={
                                line?.state === "short"
                                  ? "Explain this shortfall (required)"
                                  : "Note (optional)"
                              }
                              aria-label={`${definition.shortLabel} explanation`}
                              value={draft?.note ?? ""}
                              onChange={(event) =>
                                updateLine(location.locationId, asset, { note: event.target.value })
                              }
                              className="input mt-2 w-full text-xs"
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
              <div className="text-xs text-slate-600">
                <span className="font-semibold text-slate-800">Snapshot totals: </span>
                counted <CediAmount amount={location.totals.countedTotalMinor / 100} /> · expected{" "}
                <CediAmount amount={location.totals.expectedTotalMinor / 100} /> · variance{" "}
                <CediAmount amount={location.totals.varianceTotalMinor / 100} />
                {location.totals.shortLines > 0 && (
                  <span className="ml-2 font-semibold text-red-700">
                    {location.totals.shortLines} short line
                    {location.totals.shortLines === 1 ? "" : "s"} need an explanation
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canEdit && (
                  <>
                    <button
                      type="button"
                      onClick={() => void save(location)}
                      className="btn btn-secondary btn-sm"
                      disabled={isBusy}
                      aria-busy={isBusy}
                    >
                      <Save size={14} aria-hidden />
                      {isBusy ? "Saving…" : "Save snapshot"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void submit(location)}
                      className="btn btn-primary btn-sm"
                      disabled={isBusy || !location.snapshotId}
                    >
                      <Send size={14} aria-hidden />
                      Submit for review
                    </button>
                  </>
                )}
                {location.status === "submitted" && (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Review note (optional)"
                      value={reviewNote[location.locationId] ?? ""}
                      onChange={(event) =>
                        setReviewNote((current) => ({
                          ...current,
                          [location.locationId]: event.target.value,
                        }))
                      }
                      className="input w-56 text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => void review(location)}
                      className="btn btn-primary btn-sm"
                      disabled={isBusy}
                    >
                      <ClipboardCheck size={14} aria-hidden />
                      {isBusy ? "Reviewing…" : "Review"}
                    </button>
                  </div>
                )}
                {location.status === "reviewed" && (
                  <span className="text-xs font-medium text-emerald-800">
                    Final for this date. Record any difference as an exception case.
                  </span>
                )}
              </div>
            </div>
            {location.reviewNote && (
              <p className="border-t border-slate-200 px-4 py-2 text-xs text-slate-600">
                Review note: {location.reviewNote}
              </p>
            )}
            <div className="border-t border-slate-200 p-3">
              <LiquidityForecastPanel locationId={location.locationId} />
            </div>
          </section>
        );
      })}

      <p className="text-xs text-slate-500">
        Need to chase a difference?{" "}
        <Link href="/admin/reconciliation/exceptions" className="font-semibold text-brand-700 hover:underline">
          Open the reconciliation cases
        </Link>
        .
      </p>
    </div>
  );
}

function SummaryTile({
  label,
  minor,
  tone = "neutral",
}: {
  label: string;
  minor: number;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const colour =
    tone === "bad"
      ? "text-red-700"
      : tone === "warn"
        ? "text-amber-700"
        : tone === "good"
          ? "text-emerald-700"
          : "text-slate-900";
  return (
    <div className="card flex-1 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold tnum ${colour}`}>
        <CediAmount amount={minor / 100} />
      </p>
    </div>
  );
}
