"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import Notice from "@/components/ui/Notice";
import { contributeRiskSignal } from "@/lib/actions/risk-intelligence.actions";
import {
  listClosedRiskSignalSources,
  type RiskSignalSource,
} from "@/lib/actions/risk-source.actions";
import { RISK_CATEGORIES, RISK_CATEGORY_LABELS, RISK_SEVERITIES } from "@/lib/risk-intelligence/policy";

export default function RiskSignalContribution({
  subject,
  onContributed,
}: {
  subject: string;
  onContributed?: () => void;
}) {
  const [sources, setSources] = useState<RiskSignalSource[]>([]);
  const [employeeName, setEmployeeName] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [category, setCategory] = useState<string>("shortage");
  const [severity, setSeverity] = useState<string>("medium");
  const [note, setNote] = useState("");
  const [goodFaith, setGoodFaith] = useState(false);

  const load = useCallback(async (userId: string) => {
    if (!userId) {
      setSources([]);
      setEmployeeName("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await listClosedRiskSignalSources(userId);
      if (!result.success || !result.data) {
        setSources([]);
        setError(result.error ?? "Closed records could not be loaded.");
        return;
      }
      setSources(result.data.sources);
      setEmployeeName(result.data.employeeName);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(subject);
  }, [subject, load]);

  const selected = sources.find((row) => row.sourceId === selectedId) ?? null;

  function choose(source: RiskSignalSource) {
    setSelectedId(source.sourceId);
    setCategory(source.category);
    setSeverity(source.severity);
    setNotice("");
  }

  async function submit() {
    if (!selected || !subject) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await contributeRiskSignal({
        userId: subject,
        category,
        severity,
        sourceType: selected.sourceType,
        sourceId: selected.sourceId,
        note,
        observedFrom: selected.observedFrom,
        observedTo: selected.observedTo,
        goodFaith,
      });
      if (!result.success) {
        setError(result.error ?? "The signal could not be shared.");
        return;
      }
      setNotice("Signal shared. It expires automatically and can be withdrawn below.");
      setSelectedId("");
      setNote("");
      setGoodFaith(false);
      await load(subject);
      onContributed?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 px-3 py-3" data-testid="risk-contribution">
      <p className="font-semibold text-slate-900">Share a closed-record signal</p>
      <p className="mt-1 text-slate-600">
        A signal must come from one of this employee&apos;s own records that your business has already
        reviewed and closed. Names and phone numbers are never stored in the shared signal; the note
        must describe the operational category only.
      </p>
      {!subject && <p className="mt-2 text-amber-700">Choose an employee above to see their closed records.</p>}
      {subject && loading && (
        <p className="mt-2 flex items-center gap-2 text-slate-500">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading closed records…
        </p>
      )}
      {error && <Notice type="error">{error}</Notice>}
      {notice && <Notice type="success">{notice}</Notice>}
      {subject && !loading && sources.length === 0 && !error && (
        <p className="mt-2 text-slate-600">
          No reviewed, closed record for {employeeName || "this employee"} can support a signal yet.
          A record must be closed through its normal review first.
        </p>
      )}
      {sources.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Closed records for {employeeName}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {sources.map((source) => {
              const key = source.sourceType + ":" + source.sourceId;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={source.alreadyShared || busy}
                  onClick={() => choose(source)}
                  className={`rounded-lg border px-3 py-2 text-left text-xs ${
                    selectedId === source.sourceId
                      ? "border-brand-500 bg-brand-50"
                      : "border-slate-200 bg-white hover:border-slate-300"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  <span className="block font-semibold text-slate-900">{source.label}</span>
                  <span className="mt-0.5 block text-slate-600">{source.summary}</span>
                  <span className="mt-1 block text-slate-500">
                    {source.categoryLabel} · suggested {source.severity} severity
                    {source.alreadyShared ? " · already shared" : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {selected && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="text-xs font-medium text-slate-700">
            Category
            <select
              className="input mt-1 w-full text-sm"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              disabled={busy}
            >
              {RISK_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {RISK_CATEGORY_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-700">
            Severity
            <select
              className="input mt-1 w-full text-sm"
              value={severity}
              onChange={(event) => setSeverity(event.target.value)}
              disabled={busy}
            >
              {RISK_SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-700 sm:col-span-2">
            What the closed record shows (recorded internally, not disclosed)
            <textarea
              className="input mt-1 w-full text-sm"
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={busy}
              placeholder="Describe the operational facts. Do not include a name, phone number or another business."
            />
          </label>
          <p className="text-xs text-slate-500 sm:col-span-2">
            Observation period: {new Date(selected.observedFrom).toLocaleDateString()} to
            {" "}{new Date(selected.observedTo).toLocaleDateString()}. Expiry is calculated from this period.
          </p>
          <label className="flex items-start gap-2 text-xs text-slate-700 sm:col-span-2">
            <input
              type="checkbox"
              checked={goodFaith}
              onChange={(event) => setGoodFaith(event.target.checked)}
              disabled={busy}
              className="mt-0.5"
            />
            <span>
              I declare this signal is made in good faith, is accurate to the closed record, and is not
              a substitute for an employment decision. I understand a knowingly false report can lead to
              suspension from the programme.
            </span>
          </label>
          <button
            type="button"
            className="btn btn-primary btn-sm sm:col-span-2"
            disabled={busy || !goodFaith || note.trim().length < 20}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
            Share this signal
          </button>
        </div>
      )}
    </div>
  );
}
