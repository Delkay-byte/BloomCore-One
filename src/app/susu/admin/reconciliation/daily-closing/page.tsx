"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, RefreshCw } from "lucide-react";
import Notice from "@/components/ui/Notice";
import { SkeletonTable } from "@/components/ui/Skeletons";
import ConfirmDialog from "../_components/ConfirmDialog";
import { formatCedi, formatDateTime } from "@/lib/utils";
import { getBranchesForScope } from "@/lib/actions/branch.actions";
import { getCollectors } from "@/lib/actions/susu-collector.actions";
import {
  closeDailyClosing,
  declareDailyClosing,
  listDailyClosings,
  openDailyCollectorClosing,
  receiveDailyClosing,
  recordDailyClosingHandover,
  type DailyClosingView,
} from "@/lib/actions/susu-reconciliation.actions";

interface BranchOption { id: string; name: string }
interface CollectorOption { id: string; branchId: string | null; user: { fullName: string } }

const STATUS_TONE: Record<string, string> = {
  open: "bg-slate-100 text-slate-700",
  declared: "bg-sky-100 text-sky-800",
  handed_over: "bg-amber-100 text-amber-800",
  received: "bg-indigo-100 text-indigo-800",
  balanced: "bg-emerald-100 text-emerald-800",
  exception: "bg-red-100 text-red-800",
};

function dayInput(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export default function DailyClosingPage() {
  const [closings, setClosings] = useState<DailyClosingView[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [collectors, setCollectors] = useState<CollectorOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [branchId, setBranchId] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [openCollector, setOpenCollector] = useState("");
  const [openDay, setOpenDay] = useState(dayInput());
  const [cashAmount, setCashAmount] = useState("");
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");
  const [confirmReceive, setConfirmReceive] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [result, branchRows, collectorRows] = await Promise.all([
        listDailyClosings({ branchId: branchId || null, status: status || null, limit: 60 }),
        getBranchesForScope(),
        getCollectors(),
      ]);
      if (!result.success) {
        setError(result.error ?? "Daily closings could not be loaded.");
        return;
      }
      const rows = result.data?.closings ?? [];
      setClosings(rows);
      setBranches((branchRows as BranchOption[]) ?? []);
      setCollectors((collectorRows as unknown as CollectorOption[]) ?? []);
      setSelectedId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null);
    } catch {
      setError("Daily closings could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }, [branchId, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => closings.find((row) => row.id === selectedId) ?? null,
    [closings, selectedId]
  );
  const scopedCollectors = useMemo(
    () => (branchId ? collectors.filter((c) => c.branchId === branchId) : collectors),
    [collectors, branchId]
  );

  useEffect(() => {
    setCashAmount(
      selected
        ? String(
            selected.status === "open"
              ? selected.expectedCash
              : selected.status === "declared"
                ? selected.declaredCash ?? selected.expectedCash
                : selected.status === "handed_over"
                  ? selected.handoverAmount ?? selected.expectedCash
                  : selected.receivedAmount ?? selected.expectedCash
          )
        : ""
    );
    setEvidence("");
    setNote("");
  }, [selected]);

  async function openClosing() {
    setError("");
    setSuccess("");
    if (!openCollector) {
      setError("Choose the collector whose day you are closing.");
      return;
    }
    if (!openDay) {
      setError("Choose the business day.");
      return;
    }
    setBusy(true);
    try {
      const result = await openDailyCollectorClosing({ collectorId: openCollector, closingDate: openDay });
      if (!result.success || !result.data) {
        setError(result.error ?? "The daily closing could not be opened.");
        return;
      }
      setSuccess("Daily closing opened. Expected cash comes from recorded contributions only.");
      setSelectedId(result.data.id);
      setOpenCollector("");
      await load();
    } catch {
      setError("The daily closing could not be opened. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function runStep(step: "declare" | "handover" | "receive" | "close") {
    if (!selected) return;
    setError("");
    setSuccess("");
    const value = Number(cashAmount);
    if (step !== "close" && (!Number.isFinite(value) || value < 0)) {
      setError("Enter a valid cash amount.");
      return;
    }
    if (step === "receive" || step === "close") {
      if (step === "receive") setConfirmReceive(true);
      else setConfirmClose(true);
      return;
    }
    void submitStep(step, value);
  }

  async function submitStep(step: "declare" | "handover" | "receive" | "close", value: number) {
    if (!selected) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result =
        step === "declare"
          ? await declareDailyClosing({
              closingId: selected.id,
              declaredCash: value,
              note: note.trim() || undefined,
              evidenceRef: evidence.trim() || undefined,
            })
          : step === "handover"
            ? await recordDailyClosingHandover({
                closingId: selected.id,
                handoverAmount: value,
                note: note.trim() || undefined,
                evidenceRef: evidence.trim() || undefined,
              })
            : step === "receive"
              ? await receiveDailyClosing({
                  closingId: selected.id,
                  receivedAmount: value,
                  note: note.trim() || undefined,
                  evidenceRef: evidence.trim() || undefined,
                })
              : await closeDailyClosing({ closingId: selected.id, note: note.trim() || undefined });
      if (!result.success) {
        setError(result.error ?? "The daily closing could not be updated.");
        return;
      }
      setSuccess(
        step === "close"
          ? "Day closed. A difference has been raised as a linked exception case."
          : "Daily closing updated. The next person in the handover chain must act."
      );
      setConfirmReceive(false);
      setConfirmClose(false);
      setEvidence("");
      setNote("");
      await load();
    } catch {
      setError("The daily closing could not be updated. No money record was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <CalendarDays size={22} aria-hidden /> Daily collector closing
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Expected cash is calculated from server-recorded contributions. The collector
            declares, hands over, the office receives, and only the office closes. This is not a
            formal money-handed-in record.
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} aria-hidden /> {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error ? <Notice type="error" message={error}>{error}</Notice> : null}
      {success ? <Notice type="success" message={success}>{success}</Notice> : null}

      <section className="card grid gap-4 md:grid-cols-4" aria-label="Open a daily closing">
        <div className="form-group md:col-span-2">
          <label className="form-label" htmlFor="close-collector">Collector *</label>
          <select
            id="close-collector"
            value={openCollector}
            onChange={(event) => {
              setOpenCollector(event.target.value);
              const found = collectors.find((c) => c.id === event.target.value);
              if (found?.branchId) setBranchId(found.branchId);
            }}
          >
            <option value="">Choose a collector</option>
            {scopedCollectors.map((collector) => (
              <option key={collector.id} value={collector.id}>{collector.user.fullName}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="closing-day">Business day *</label>
          <input id="closing-day" type="date" value={openDay} max={dayInput()} onChange={(event) => setOpenDay(event.target.value)} />
        </div>
        <div className="flex items-end">
          <button type="button" className="btn btn-primary w-full" onClick={() => void openClosing()} disabled={busy}>
            {busy ? "Opening…" : "Open closing"}
          </button>
        </div>
      </section>

      <div className="grid gap-2 sm:grid-cols-3">
        <div className="form-group">
          <label className="form-label" htmlFor="closing-branch">Branch filter</label>
          <select id="closing-branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
            <option value="">All branches in scope</option>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="closing-status">Status</label>
          <select id="closing-status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All statuses</option>
            {["open", "declared", "handed_over", "received", "balanced", "exception"].map((value) => (
              <option key={value} value={value}>{value.replaceAll("_", " ")}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <section className="card overflow-hidden !p-0">
          <h2 className="border-b border-line px-4 py-3 font-semibold">Closings ({closings.length})</h2>
          {loading && !closings.length ? (
            <div className="p-4"><SkeletonTable rows={5} columns={2} showHeader={false} /></div>
          ) : !closings.length ? (
            <p className="p-4 text-sm text-muted">No daily closing exists for this filter. Open one above.</p>
          ) : (
            <ul className="divide-y divide-line">
              {closings.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(row.id)}
                    aria-current={row.id === selectedId ? "true" : undefined}
                    className={`w-full px-4 py-3 text-left hover:bg-surface-sunken ${row.id === selectedId ? "bg-surface-sunken" : ""}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold">{row.collectorName ?? "Collector"}</p>
                      <span className={`badge ${STATUS_TONE[row.status] ?? ""}`}>{row.status.replaceAll("_", " ")}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted">{row.closingDay} · {row.branchName ?? "No branch"}</p>
                    <p className="mt-1 text-xs tabular-nums">
                      Expected {formatCedi(row.expectedCash)} · Received {row.receivedAmount === null ? "—" : formatCedi(row.receivedAmount)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          {!selected ? (
            <p className="text-sm text-muted">Select a closing to see the handover trail.</p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold">{selected.collectorName ?? "Collector"}</h2>
                  <p className="text-sm text-muted">{selected.closingDay} · {selected.branchName ?? "No branch"}</p>
                </div>
                <span className={`badge ${STATUS_TONE[selected.status] ?? ""}`}>{selected.status.replaceAll("_", " ")}</span>
              </div>

              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-control bg-surface-sunken p-3"><dt className="text-xs text-muted">Expected from records</dt><dd className="font-semibold tabular-nums">{formatCedi(selected.expectedCash)}</dd></div>
                <div className="rounded-control bg-surface-sunken p-3"><dt className="text-xs text-muted">Declared by collector</dt><dd className="font-semibold tabular-nums">{selected.declaredCash === null ? "—" : formatCedi(selected.declaredCash)}</dd></div>
                <div className="rounded-control bg-surface-sunken p-3"><dt className="text-xs text-muted">Handed over</dt><dd className="font-semibold tabular-nums">{selected.handoverAmount === null ? "—" : formatCedi(selected.handoverAmount)}</dd></div>
                <div className="rounded-control bg-surface-sunken p-3"><dt className="text-xs text-muted">Received by office</dt><dd className="font-semibold tabular-nums">{selected.receivedAmount === null ? "—" : formatCedi(selected.receivedAmount)}</dd></div>
                <div className="rounded-control bg-surface-sunken p-3"><dt className="text-xs text-muted">Pending sync</dt><dd className="font-semibold tabular-nums">{selected.pendingSyncCount} · {formatCedi(selected.contributionsPending)}</dd></div>
                <div className="rounded-control bg-surface-sunken p-3"><dt className="text-xs text-muted">Outstanding</dt><dd className={`font-semibold tabular-nums ${selected.outstandingAmount ? "text-red-700" : ""}`}>{formatCedi(selected.outstandingAmount)}</dd></div>
              </dl>

              {selected.declarationNote || selected.receiptNote || selected.handoverEvidenceRef || selected.declarationEvidenceRef ? (
                <div className="rounded-control border border-line p-3 text-xs text-muted">
                  {selected.declarationNote ? <p>Declaration: {selected.declarationNote}</p> : null}
                  {selected.declarationEvidenceRef ? <p>Declaration evidence: {selected.declarationEvidenceRef}</p> : null}
                  {selected.handoverEvidenceRef ? <p>Handover evidence: {selected.handoverEvidenceRef}</p> : null}
                  {selected.receiptNote ? <p>Receipt: {selected.receiptNote}</p> : null}
                  {selected.receiptEvidenceRef ? <p>Receipt evidence: {selected.receiptEvidenceRef}</p> : null}
                </div>
              ) : null}

              {["open", "declared", "handed_over", "received"].includes(selected.status) ? (
                <div className="space-y-3 border-t border-line pt-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="form-group">
                      <label className="form-label" htmlFor="cash-amount">
                        {selected.status === "open" ? "Declared cash" : selected.status === "declared" ? "Cash handed over" : selected.status === "handed_over" ? "Cash received" : "Cash amount"}
                      </label>
                      <input id="cash-amount" type="number" min="0" step="0.01" value={cashAmount} onChange={(event) => setCashAmount(event.target.value)} />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cash-evidence">Evidence reference</label>
                      <input id="cash-evidence" value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="Required when the amount differs" />
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="cash-note">Note</label>
                    <textarea id="cash-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional context for the handover chain" />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selected.status === "open" ? <button type="button" className="btn btn-primary" onClick={() => runStep("declare")} disabled={busy}>Declare cash</button> : null}
                    {selected.status === "declared" ? <button type="button" className="btn btn-primary" onClick={() => runStep("handover")} disabled={busy}>Record handover</button> : null}
                    {selected.status === "handed_over" ? <button type="button" className="btn btn-primary" onClick={() => runStep("receive")} disabled={busy}>Receive cash</button> : null}
                    {selected.status === "received" ? <button type="button" className="btn btn-primary" onClick={() => runStep("close")} disabled={busy}>Close day</button> : null}
                  </div>
                  <p className="text-xs text-muted">
                    The declarer cannot receive the same cash. A difference requires an evidence reference.
                  </p>
                </div>
              ) : null}

              {selected.exceptionCaseId ? (
                <p className="text-sm">
                  Difference case:{" "}
                  <Link href={`/susu/admin/reconciliation/exceptions/${selected.exceptionCaseId}`} className="font-semibold text-brand-700 hover:underline">
                    open the linked exception
                  </Link>
                </p>
              ) : null}
              {selected.sessionId ? (
                <p className="text-sm">
                  Linked review:{" "}
                  <Link href={`/susu/admin/reconciliation/sessions/${selected.sessionId}`} className="font-semibold text-brand-700 hover:underline">
                    open reconciliation session
                  </Link>
                </p>
              ) : null}
              <p className="text-xs text-muted">Updated {formatDateTime(selected.updatedAt)}</p>
            </div>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={confirmReceive}
        title="Receive this cash?"
        description="This records the office count and cannot be silently undone. It will raise a linked case when the count differs from the records."
        confirmLabel="Receive cash"
        busy={busy}
        onConfirm={() => void submitStep("receive", Number(cashAmount))}
        onClose={() => setConfirmReceive(false)}
      >
        <p className="tabular-nums">{formatCedi(Number(cashAmount))} received for {selected?.closingDay}.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmClose}
        title="Close this business day?"
        description="A balanced day closes. Any difference or pending sync creates one linked exception case."
        confirmLabel="Close day"
        busy={busy}
        onConfirm={() => void submitStep("close", Number(cashAmount))}
        onClose={() => setConfirmClose(false)}
      />
    </div>
  );
}
