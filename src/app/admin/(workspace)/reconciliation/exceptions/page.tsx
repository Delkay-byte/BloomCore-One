"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Link2, RefreshCw, ShieldAlert } from "lucide-react";
import Notice from "@/components/ui/Notice";
import {
  getExceptionCases,
  getExceptionOwnerOptions,
  linkCaseRecord,
  updateExceptionCase,
  type ExceptionCaseView,
} from "@/lib/actions/provider-statement.actions";
import {
  STATEMENT_CASE_CATEGORY_LABELS,
  STATEMENT_CASE_STATUSES,
  STATEMENT_CASE_STATUS_LABELS,
  canTransitionCase,
} from "@/lib/provider-statement-labels";

const SEVERITY_TONE: Record<string, string> = {
  high: "bg-red-100 text-red-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-100 text-slate-700",
};

const STATUS_TONE: Record<string, string> = {
  open: "bg-red-50 text-red-800",
  investigating: "bg-sky-100 text-sky-800",
  awaiting_evidence: "bg-amber-100 text-amber-800",
  resolved: "bg-emerald-100 text-emerald-800",
  dismissed: "bg-slate-100 text-slate-700",
};

export default function ExceptionCasesPage() {
  const [cases, setCases] = useState<ExceptionCaseView[]>([]);
  const [owners, setOwners] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [resolutionType, setResolutionType] = useState("explained");
  const [linkEntityType, setLinkEntityType] = useState("momoTransaction");
  const [linkEntityId, setLinkEntityId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextCases, nextOwners] = await Promise.all([
        getExceptionCases(),
        getExceptionOwnerOptions(),
      ]);
      setCases(nextCases);
      setOwners(nextOwners);
      setSelectedId((current) => current ?? nextCases[0]?.id ?? null);
    } catch {
      setError("The exception cases could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => cases.find((entry) => entry.id === selectedId) ?? null,
    [cases, selectedId]
  );

  useEffect(() => {
    if (!selected) return;
    setNote("");
    setEvidence(selected.evidence ?? "");
    setResolutionNote(selected.resolutionNote ?? "");
    setResolutionType(selected.resolutionType ?? "explained");
  }, [selected]);

  const visible = useMemo(() => {
    if (statusFilter === "all") return cases;
    if (statusFilter === "closed") {
      return cases.filter((entry) => entry.status === "resolved" || entry.status === "dismissed");
    }
    return cases.filter((entry) => entry.status === statusFilter);
  }, [cases, statusFilter]);

  const nextStatuses = useMemo(() => {
    if (!selected) return [] as string[];
    return STATEMENT_CASE_STATUSES.filter((status) => canTransitionCase(selected.status, status));
  }, [selected]);

  async function apply(patch: Parameters<typeof updateExceptionCase>[0]) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await updateExceptionCase(patch);
      if (!result.success) {
        setError(result.error ?? "The case could not be updated.");
        return;
      }
      setSuccess("Case updated.");
      setNote("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function linkRecord() {
    if (!selected) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await linkCaseRecord({
        caseId: selected.id,
        entityType: linkEntityType.trim(),
        entityId: linkEntityId.trim(),
      });
      if (!result.success) {
        setError(result.error ?? "The record could not be linked.");
        return;
      }
      setSuccess("Record linked to the case.");
      setLinkEntityId("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reconciliation Cases</h1>
          <p className="mt-1 text-sm text-slate-600">
            One queue for every difference: provider statements, branch liquidity, transfers,
            remittances, shifts and daily closes. Each case keeps an owner, an age and a full
            timeline.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/admin/reconciliation" className="btn btn-secondary btn-sm">
            Statements
          </Link>
          <Link href="/admin/liquidity" className="btn btn-secondary btn-sm">
            Liquidity
          </Link>
          <button
            type="button"
            onClick={() => void load()}
            className="btn btn-secondary btn-sm"
            disabled={loading}
          >
            <RefreshCw size={13} aria-hidden />
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error && <Notice type="error" message={error}>{error}</Notice>}
      {success && <Notice type="success" message={success}>{success}</Notice>}

      <div className="flex flex-wrap gap-1.5">
        {[
          { value: "open", label: "Open" },
          { value: "investigating", label: "Investigating" },
          { value: "awaiting_evidence", label: "Awaiting evidence" },
          { value: "closed", label: "Closed" },
          { value: "all", label: "All" },
        ].map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setStatusFilter(option.value)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              statusFilter === option.value
                ? "bg-brand-700 text-white"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section className="card overflow-hidden">
          <h2 className="border-b border-slate-200 px-4 py-3 font-semibold text-slate-900">
            Cases ({visible.length})
          </h2>
          {loading && cases.length === 0 && (
            <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading cases">
              <div className="skeleton h-14 rounded" />
              <div className="skeleton h-14 rounded" />
            </div>
          )}
          {!loading && visible.length === 0 && (
            <p className="p-4 text-sm text-slate-600">
              Nothing in this view. A shortfall review opens a case automatically; you can also raise
              one from a statement line.
            </p>
          )}
          <ul className="divide-y divide-slate-100">
            {visible.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(entry.id)}
                  className={`w-full px-4 py-3 text-left hover:bg-slate-50 ${
                    selectedId === entry.id ? "bg-slate-50" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-500">{entry.caseNumber}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                        SEVERITY_TONE[entry.severity] ?? "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {entry.severity}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm font-medium text-slate-900">{entry.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {STATEMENT_CASE_CATEGORY_LABELS[entry.category] ?? entry.category} ·{" "}
                    {STATEMENT_CASE_STATUS_LABELS[entry.status] ?? entry.status} · {entry.ageDays}d old
                    {entry.overdue ? " · overdue" : ""}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {entry.ownerName ? `Owner: ${entry.ownerName}` : "Unassigned"} ·{" "}
                    {entry.linkCount} linked record{entry.linkCount === 1 ? "" : "s"}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="card overflow-hidden">
          {!selected && (
            <p className="p-6 text-sm text-slate-600">Select a case to work on it.</p>
          )}
          {selected && (
            <>
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 px-4 py-3">
                <div>
                  <p className="text-xs font-semibold text-slate-500">{selected.caseNumber}</p>
                  <h2 className="text-lg font-semibold text-slate-900">{selected.title}</h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Opened {new Date(selected.openedAt).toLocaleString("en-GB")} ·{" "}
                    {selected.ageDays} days old
                    {selected.dueAt
                      ? ` · due ${new Date(selected.dueAt).toLocaleDateString("en-GB")}`
                      : ""}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    STATUS_TONE[selected.status] ?? "bg-slate-100 text-slate-700"
                  }`}
                >
                  {STATEMENT_CASE_STATUS_LABELS[selected.status] ?? selected.status}
                </span>
              </div>

              {selected.description && (
                <p className="border-b border-slate-100 px-4 py-3 text-sm text-slate-700">
                  {selected.description}
                </p>
              )}

              <div className="grid gap-3 border-b border-slate-100 px-4 py-3 sm:grid-cols-2">
                <label className="text-xs font-medium text-slate-600">
                  Owner
                  <select
                    value={selected.ownerId ?? ""}
                    onChange={(event) =>
                      void apply({
                        id: selected.id,
                        ownerId: event.target.value || null,
                        note: event.target.value ? "Case assigned." : "Case unassigned.",
                      })
                    }
                    className="input mt-1 block w-full"
                    disabled={busy}
                  >
                    <option value="">Unassigned</option>
                    {owners.map((owner) => (
                      <option key={owner.id} value={owner.id}>
                        {owner.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs font-medium text-slate-600">
                  Move to
                  <select
                    value=""
                    onChange={(event) => {
                      const status = event.target.value;
                      if (!status) return;
                      // Closing is handled by the resolution panel below, which
                      // requires an outcome and a note before it will submit.
                      void apply({ id: selected.id, status, note: note.trim() || undefined });
                    }}
                    className="input mt-1 block w-full"
                    disabled={busy || nextStatuses.length === 0}
                  >
                    <option value="">Choose…</option>
                    {nextStatuses
                      .filter((status) => status !== "resolved" && status !== "dismissed")
                      .map((status) => (
                        <option key={status} value={status}>
                          {STATEMENT_CASE_STATUS_LABELS[status] ?? status}
                        </option>
                      ))}
                  </select>
                </label>
              </div>

              <div className="space-y-2 border-b border-slate-100 px-4 py-3">
                <label className="block text-xs font-medium text-slate-600">
                  Add a note
                  <textarea
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    rows={2}
                    maxLength={1000}
                    className="input mt-1 block w-full text-sm"
                    placeholder="What you checked, who you spoke to, what you found"
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void apply({ id: selected.id, note })}
                    className="btn btn-secondary btn-sm"
                    disabled={busy || note.trim().length === 0}
                  >
                    Save note
                  </button>
                  <label className="text-xs font-medium text-slate-600">
                    Evidence
                    <input
                      type="text"
                      value={evidence}
                      onChange={(event) => setEvidence(event.target.value)}
                      maxLength={2000}
                      placeholder="Reference to the receipt, call log or statement page"
                      className="input ml-2 inline-block w-64 text-xs"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void apply({ id: selected.id, evidence })}
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                  >
                    Save evidence
                  </button>
                </div>
              </div>

              <div className="space-y-2 border-b border-slate-100 px-4 py-3">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                  <Link2 size={14} aria-hidden />
                  Linked records
                </h3>
                {selected.links.length === 0 && (
                  <p className="text-xs text-slate-500">No record is linked to this case yet.</p>
                )}
                <ul className="space-y-1">
                  {selected.links.map((link) => (
                    <li key={`${link.entityType}:${link.entityId}`} className="text-xs text-slate-600">
                      <span className="font-mono text-[11px]">{link.entityType}</span> ·{" "}
                      <span className="font-mono text-[11px]">{link.entityId}</span>
                      {link.note ? ` — ${link.note}` : ""}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="text-xs font-medium text-slate-600">
                    Record type
                    <input
                      type="text"
                      value={linkEntityType}
                      onChange={(event) => setLinkEntityType(event.target.value)}
                      maxLength={60}
                      className="input mt-1 block w-40 text-xs"
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-600">
                    Record ID
                    <input
                      type="text"
                      value={linkEntityId}
                      onChange={(event) => setLinkEntityId(event.target.value)}
                      maxLength={60}
                      className="input mt-1 block w-56 text-xs"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void linkRecord()}
                    className="btn btn-secondary btn-sm"
                    disabled={busy || !linkEntityId.trim() || !linkEntityType.trim()}
                  >
                    Link
                  </button>
                </div>
              </div>

              {(selected.status === "resolved" || selected.status === "dismissed") && (
                <div className="border-b border-slate-100 bg-slate-50 px-4 py-3 text-xs text-slate-700">
                  <p className="font-semibold">Resolution</p>
                  <p className="mt-0.5">
                    {selected.resolutionType ? `${selected.resolutionType}: ` : ""}
                    {selected.resolutionNote ?? "Not recorded"}
                  </p>
                  <p className="mt-1">
                    Reopening a closed case keeps its history; nothing is deleted.
                  </p>
                </div>
              )}

              <div className="space-y-2 px-4 py-3">
                <h3 className="text-sm font-semibold text-slate-900">Close the case</h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs font-medium text-slate-600">
                    Outcome
                    <select
                      value={resolutionType}
                      onChange={(event) => setResolutionType(event.target.value)}
                      className="input mt-1 block w-full text-xs"
                    >
                      <option value="explained">Explained — no money missing</option>
                      <option value="recovered">Money recovered</option>
                      <option value="written_off">Written off</option>
                      <option value="provider_error">Provider error</option>
                      <option value="system_error">System error</option>
                      <option value="duplicate">Duplicate record</option>
                    </select>
                  </label>
                  <label className="text-xs font-medium text-slate-600">
                    Resolution note (required)
                    <input
                      type="text"
                      value={resolutionNote}
                      onChange={(event) => setResolutionNote(event.target.value)}
                      maxLength={1000}
                      className="input mt-1 block w-full text-xs"
                      placeholder="What was decided and by whom"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      void apply({
                        id: selected.id,
                        status: "resolved",
                        resolutionType,
                        resolutionNote,
                      })
                    }
                    className="btn btn-primary btn-sm"
                    disabled={busy || resolutionNote.trim().length === 0}
                  >
                    Resolve
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void apply({
                        id: selected.id,
                        status: "dismissed",
                        resolutionType: "duplicate",
                        resolutionNote,
                      })
                    }
                    className="btn btn-secondary btn-sm"
                    disabled={busy || resolutionNote.trim().length === 0}
                  >
                    Dismiss as false positive
                  </button>
                </div>
                <p className="flex items-start gap-1.5 rounded bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
                  Closing a case records a decision. It never edits, reverses or deletes a financial
                  record — that still needs its own authorised correction.
                </p>
              </div>

              <div className="border-t border-slate-100 px-4 py-3">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                  <ShieldAlert size={14} aria-hidden />
                  Timeline
                </h3>
                <ol className="mt-2 space-y-2">
                  {selected.events.map((event) => (
                    <li key={event.id} className="border-l-2 border-slate-200 pl-3">
                      <p className="text-xs font-semibold text-slate-800">
                        {event.type.replace(/_/g, " ")}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {new Date(event.createdAt).toLocaleString("en-GB")}
                        {event.actorName ? ` · ${event.actorName}` : ""}
                      </p>
                      {event.note && (
                        <p className="mt-0.5 text-xs text-slate-700">{event.note}</p>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
