"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileSpreadsheet, Link2, RefreshCw, ShieldAlert, Unlink, Upload } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import {
  getStatementImportDetail,
  getStatementImports,
  getStatementRowCandidates,
  importProviderStatement,
  manuallyMatchStatementRow,
  unmatchStatementRow,
  type StatementCandidateView,
  type StatementImportDetailView,
  type StatementImportSummaryView,
} from "@/lib/actions/provider-statement.actions";
import {
  STATEMENT_PROVIDER_LABELS,
  STATEMENT_PROVIDERS,
  type StatementProvider,
} from "@/lib/provider-statement-labels";

const ROW_STATUS_TONE: Record<string, string> = {
  matched: "bg-emerald-100 text-emerald-800",
  unmatched: "bg-amber-100 text-amber-800",
  duplicate: "bg-slate-100 text-slate-700",
  invalid: "bg-red-100 text-red-800",
  valid: "bg-sky-100 text-sky-800",
};

export default function ReconciliationPage() {
  const [imports, setImports] = useState<StatementImportSummaryView[]>([]);
  const [detail, setDetail] = useState<StatementImportDetailView | null>(null);
  const [candidates, setCandidates] = useState<Record<string, StatementCandidateView[]>>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState<StatementProvider>("mtn");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const loadImports = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setImports(await getStatementImports());
    } catch {
      setError("The import history could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadImports();
  }, [loadImports]);

  async function openDetail(importId: string) {
    setBusy(true);
    setError("");
    try {
      const next = await getStatementImportDetail(importId);
      setDetail(next);
      setCandidates({});
      setSelected({});
      if (!next) setError("That import could not be found.");
    } finally {
      setBusy(false);
    }
  }

  async function upload(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) {
      setError("Choose the statement file exported from the provider.");
      return;
    }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const csv = await file.text();
      const result = await importProviderStatement({
        provider,
        fileName: file.name,
        csv,
        note: note.trim() || undefined,
      });
      if (!result.success) {
        setError(result.error ?? "The statement could not be imported.");
        return;
      }
      const data = result.data as
        | { importId: string; matchedRows: number; unmatchedRows: number; duplicateRows: number }
        | undefined;
      setSuccess(
        `Imported ${file.name}: ${data?.matchedRows ?? 0} automatically matched, ${
          data?.unmatchedRows ?? 0
        } unmatched, ${data?.duplicateRows ?? 0} duplicate lines. Nothing was posted to the ledger.`
      );
      setNote("");
      if (fileInput.current) fileInput.current.value = "";
      await loadImports();
      if (data?.importId) await openDetail(data.importId);
    } catch {
      setError("The statement could not be imported. Check the file and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function showCandidates(rowId: string) {
    setError("");
    try {
      const rows = await getStatementRowCandidates(rowId);
      setCandidates((current) => ({ ...current, [rowId]: rows }));
      if (rows.length > 0) {
        setSelected((current) => ({ ...current, [rowId]: rows[0].id }));
      }
    } catch {
      setError("Internal records for that line could not be loaded.");
    }
  }

  async function match(rowId: string) {
    const momoTransactionId = selected[rowId];
    if (!momoTransactionId) {
      setError("Choose the internal record that matches this line.");
      return;
    }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await manuallyMatchStatementRow({ rowId, momoTransactionId });
      if (!result.success) {
        setError(result.error ?? "The line could not be matched.");
        return;
      }
      setSuccess("Line matched. The internal record was not changed and is still unconfirmed.");
      if (detail) await openDetail(detail.id);
    } finally {
      setBusy(false);
    }
  }

  async function unmatch(rowId: string) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await unmatchStatementRow(rowId);
      if (!result.success) {
        setError(result.error ?? "The match could not be removed.");
        return;
      }
      setSuccess("Manual match removed.");
      if (detail) await openDetail(detail.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Provider Statement Reconciliation</h1>
          <p className="mt-1 text-sm text-slate-600">
            Import the statement a network sent you and compare it line by line with the records in
            this business. Importing never posts, edits or confirms money.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/admin/liquidity" className="btn btn-secondary btn-sm">
            Branch liquidity
          </Link>
          <Link href="/admin/reconciliation/exceptions" className="btn btn-secondary btn-sm">
            <ShieldAlert size={14} aria-hidden />
            Exception cases
          </Link>
        </div>
      </header>

      {error && <Notice type="error" message={error}>{error}</Notice>}
      {success && <Notice type="success" message={success}>{success}</Notice>}

      <form onSubmit={upload} className="card space-y-3 p-4">
        <h2 className="flex items-center gap-2 font-semibold text-slate-900">
          <Upload size={16} className="text-brand-700" aria-hidden />
          Import a statement
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-medium text-slate-600">
            Network
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value as StatementProvider)}
              className="input mt-1 block w-full"
            >
              {STATEMENT_PROVIDERS.map((option) => (
                <option key={option} value={option}>
                  {STATEMENT_PROVIDER_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            Statement file (CSV)
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="input mt-1 block w-full file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Note (optional)
            <input
              type="text"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={200}
              placeholder="Why this statement was imported"
              className="input mt-1 block w-full"
            />
          </label>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            Recognised columns: date, time, reference, direction, amount, fee, balance. The file is
            hashed, so the same statement cannot be imported twice.
          </p>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy} aria-busy={busy}>
            {busy ? "Importing…" : "Import statement"}
          </button>
        </div>
      </form>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <h2 className="font-semibold text-slate-900">Import history</h2>
            <button
              type="button"
              onClick={() => void loadImports()}
              className="btn btn-secondary btn-sm"
              disabled={loading}
            >
              <RefreshCw size={13} aria-hidden />
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {loading && imports.length === 0 && (
            <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading imports">
              <div className="skeleton h-12 rounded" />
              <div className="skeleton h-12 rounded" />
            </div>
          )}
          {!loading && imports.length === 0 && (
            <p className="p-4 text-sm text-slate-600">
              No statement has been imported yet. Import one above to start a reconciliation.
            </p>
          )}
          <ul className="divide-y divide-slate-100">
            {imports.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => void openDetail(entry.id)}
                  className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 ${
                    detail?.id === entry.id ? "bg-slate-50" : ""
                  }`}
                >
                  <FileSpreadsheet size={16} className="mt-0.5 shrink-0 text-brand-700" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900">
                      {entry.fileName}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500">
                      {entry.providerLabel} · {entry.rowCount} lines ·{" "}
                      {new Date(entry.importedAt).toLocaleString("en-GB")}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-semibold text-emerald-800">
                        {entry.matchedRows} matched
                      </span>
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800">
                        {entry.unmatchedRows} unmatched
                      </span>
                      {entry.duplicateRows > 0 && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-700">
                          {entry.duplicateRows} duplicate
                        </span>
                      )}
                      {entry.invalidRows > 0 && (
                        <span className="rounded bg-red-100 px-1.5 py-0.5 font-semibold text-red-800">
                          {entry.invalidRows} invalid
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="card overflow-hidden">
          {!detail && (
            <p className="p-6 text-sm text-slate-600">
              Select an import to review its lines. Each line keeps its own verdict, so an invalid or
              duplicate row is never hidden by a tidy summary.
            </p>
          )}
          {detail && (
            <>
              <div className="border-b border-slate-200 px-4 py-3">
                <h2 className="font-semibold text-slate-900">{detail.fileName}</h2>
                <p className="text-xs text-slate-500">
                  {detail.providerLabel} · imported {new Date(detail.importedAt).toLocaleString("en-GB")}
                  {detail.importedByName ? ` by ${detail.importedByName}` : ""}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <Figure label="Matched in" minor={detail.totals.matchedIn} />
                  <Figure label="Matched out" minor={detail.totals.matchedOut} />
                  <Figure label="Unmatched in" minor={detail.totals.unmatchedIn} tone="warn" />
                  <Figure label="Unmatched out" minor={detail.totals.unmatchedOut} tone="warn" />
                </div>
                <p className="mt-2 text-xs text-slate-600">
                  Net unmatched: <CediAmount amount={detail.totals.netUnmatched} /> — this is the
                  value of provider lines with no counterpart in this business.
                </p>
              </div>
              <div className="max-h-[32rem] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">#</th>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Reference</th>
                      <th className="px-3 py-2">Dir</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2">Verdict</th>
                      <th className="px-3 py-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.rows.map((row) => (
                      <tr key={row.id} className="border-t border-slate-100 align-top">
                        <td className="px-3 py-2 text-xs text-slate-500">{row.rowNumber}</td>
                        <td className="px-3 py-2 text-xs text-slate-600">
                          {row.transactionAt
                            ? new Date(row.transactionAt).toLocaleString("en-GB")
                            : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-700">
                          {row.externalReference ?? "—"}
                          {row.matchedReference && (
                            <span className="mt-0.5 block text-[11px] text-emerald-700">
                              → {row.matchedReference}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs uppercase text-slate-600">
                          {row.direction ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-xs tnum">
                          {row.amount === null ? "—" : <CediAmount amount={row.amount} />}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                              ROW_STATUS_TONE[row.status] ?? "bg-slate-100 text-slate-700"
                            }`}
                          >
                            {row.status}
                          </span>
                          {row.matchType && (
                            <span className="mt-0.5 block text-[11px] text-slate-500">
                              {row.matchType === "auto" ? "automatic" : row.matchType}
                            </span>
                          )}
                          {row.validationError && (
                            <span className="mt-0.5 block text-[11px] text-red-700">
                              {row.validationError}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {row.status === "unmatched" || row.matchType === "manual" ? (
                            <div className="space-y-1.5">
                              {row.matchType === "manual" ? (
                                <button
                                  type="button"
                                  onClick={() => void unmatch(row.id)}
                                  className="btn btn-secondary btn-xs"
                                  disabled={busy}
                                >
                                  <Unlink size={12} aria-hidden />
                                  Remove match
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => void showCandidates(row.id)}
                                    className="btn btn-secondary btn-xs"
                                    disabled={busy}
                                  >
                                    Find record
                                  </button>
                                  {candidates[row.id] && (
                                    <div className="space-y-1">
                                      {candidates[row.id].length === 0 && (
                                        <p className="text-[11px] text-slate-500">
                                          No internal record near this time on the same network.
                                        </p>
                                      )}
                                      {candidates[row.id].length > 0 && (
                                        <>
                                          <select
                                            value={selected[row.id] ?? ""}
                                            onChange={(event) =>
                                              setSelected((current) => ({
                                                ...current,
                                                [row.id]: event.target.value,
                                              }))
                                            }
                                            aria-label={`Internal record for line ${row.rowNumber}`}
                                            className="input w-full text-[11px]"
                                          >
                                            {candidates[row.id].map((candidate) => (
                                              <option key={candidate.id} value={candidate.id}>
                                                {new Date(candidate.transactionAt).toLocaleString(
                                                  "en-GB"
                                                )}{" "}
                                                · {candidate.reference} ·{" "}
                                                {candidate.amount.toFixed(2)}
                                              </option>
                                            ))}
                                          </select>
                                          <button
                                            type="button"
                                            onClick={() => void match(row.id)}
                                            className="btn btn-primary btn-xs"
                                            disabled={busy}
                                          >
                                            <Link2 size={12} aria-hidden />
                                            Match
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          ) : (
                            <span className="text-[11px] text-slate-500">
                              {row.status === "duplicate"
                                ? "Stays unlinked"
                                : row.status === "invalid"
                                  ? "Fix at source"
                                  : "Automatic"}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="border-t border-slate-200 px-4 py-2 text-[11px] text-slate-500">
                A manual match records that a person paired two records. It never marks the internal
                transaction as provider-confirmed, because only the provider can do that.
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Figure({
  label,
  minor,
  tone = "neutral",
}: {
  label: string;
  minor: number;
  tone?: "neutral" | "warn";
}) {
  return (
    <div className="rounded-lg bg-slate-50 px-2 py-1.5">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={`text-sm font-semibold tnum ${
          tone === "warn" ? "text-amber-800" : "text-slate-900"
        }`}
      >
        <CediAmount amount={minor} />
      </p>
    </div>
  );
}
