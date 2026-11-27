"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  ShieldCheck,
  Upload,
} from "lucide-react";
import Notice from "@/components/ui/Notice";
import { useToast } from "@/components/ui/Toast";
import {
  confirmImportBatch,
  createImportBatch,
  discardImportBatch,
  getImportErrorReport,
  getImportBatches,
  getImportPreview,
  resolveImportRows,
  validateImportBatch,
} from "@/lib/actions/susu-import.actions";
import { getOnboardingOptions } from "@/lib/actions/susu-onboarding.actions";
import { buildImportTemplateCsv } from "@/lib/susu/import-csv";
import {
  allowedResolutions,
  IMPORT_FIELDS,
  type ColumnMapping,
  type ImportClassification,
  type ImportResolution,
} from "@/lib/susu/import-validation";

interface BranchOption {
  id: string;
  name: string;
  code: string;
}

interface PreviewRow {
  rowNumber: number;
  customerName: string | null;
  phone: string | null;
  externalReference: string | null;
  accountNumber: string | null;
  dailyContribution: number | null;
  openingDate: string | null;
  branchLabel: string | null;
  classification: ImportClassification;
  classificationLabel: string;
  resolution: ImportResolution | null;
  resolutionLabel: string | null;
  issues: { code: string; message: string; severity: string }[];
  matchReasons: string[];
  matchedCustomerName: string | null;
  outcome: string | null;
  outcomeMessage: string | null;
}

interface Summary {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  newCustomerRows: number;
  existingCustomerRows: number;
  duplicateRows: number;
  reviewRows: number;
  importedCustomers: number;
  importedAccounts: number;
  linkedRows: number;
  skippedRows: number;
  failedRows: number;
}

interface Preview {
  batch: {
    id: string;
    name: string;
    fileName: string;
    status: string;
    branchMode: string;
    branchName: string | null;
    headers: string[];
    mapping: ColumnMapping;
    totalRows: number;
    validatedAt: string | null;
    failureReason: string | null;
  };
  planHash: string;
  ready: boolean;
  summary: Summary;
  rows: PreviewRow[];
  filteredTotal: number;
  limit: number;
}

interface BatchRow {
  id: string;
  name: string;
  fileName: string;
  status: string;
  totalRows: number;
  importedCustomers: number;
  importedAccounts: number;
  skippedRows: number;
  failedRows: number;
  reviewRows: number;
  createdAt: string;
  committedAt: string | null;
  failureReason: string | null;
}

const STATUS_TONE: Record<string, string> = {
  staged: "bg-slate-100 text-slate-700",
  validated: "bg-amber-100 text-amber-800",
  ready: "bg-emerald-100 text-emerald-800",
  committing: "bg-blue-100 text-blue-800",
  committed: "bg-emerald-600 text-white",
  partially_committed: "bg-amber-500 text-white",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-slate-200 text-slate-600",
};

const CLASSIFICATION_TONE: Record<string, string> = {
  new_customer: "bg-emerald-100 text-emerald-800",
  new_account_existing_customer: "bg-blue-100 text-blue-800",
  exact_duplicate: "bg-slate-200 text-slate-700",
  possible_customer_duplicate: "bg-amber-100 text-amber-800",
  account_conflict: "bg-orange-100 text-orange-800",
  customer_conflict: "bg-orange-100 text-orange-800",
  invalid: "bg-red-100 text-red-800",
};

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function CustomerImportPage() {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [branchless, setBranchless] = useState(false);

  const [batchId, setBatchId] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [filter, setFilter] = useState<"all" | "review" | "invalid" | "duplicate">("all");
  const [confirmText, setConfirmText] = useState("");

  const [history, setHistory] = useState<BatchRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<{
    importedCustomers: number;
    importedAccounts: number;
    linkedRows: number;
    skippedRows: number;
    failedRows: number;
  } | null>(null);

  const loadHistory = useCallback(async () => {
    const response = await getImportBatches();
    if (response.success) {
      setHistory((response.data as { batches: BatchRow[] }).batches);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const [options, batches] = await Promise.all([
        getOnboardingOptions(),
        getImportBatches(),
      ]);
      if (options.success) {
        const data = options.data as { branches: BranchOption[]; branchless: boolean };
        setBranches(data.branches);
        setBranchless(data.branchless);
      }
      if (batches.success) {
        setHistory((batches.data as { batches: BatchRow[] }).batches);
      }
    })();
  }, []);

  const refreshPreview = useCallback(
    async (id: string, nextFilter: typeof filter = filter) => {
      const response = await getImportPreview({ batchId: id, filter: nextFilter, limit: 100 });
      if (!response.success) {
        setError(response.error ?? "The preview could not be loaded.");
        return;
      }
      const data = response.data as Preview;
      setPreview(data);
      setHeaders(data.batch.headers);
      setMapping(data.batch.mapping);
      setBatchId(data.batch.id);
    },
    [filter]
  );

  async function handleUpload(form: FormData) {
    setBusy("upload");
    setError("");
    setNotice("");
    try {
      const response = await createImportBatch(form);
      if (!response.success) {
        setError(response.error ?? "The file could not be read.");
        return;
      }
      const data = response.data as {
        batchId: string;
        resumed: boolean;
        message?: string;
        headers?: string[];
        mapping?: ColumnMapping;
        totalRows?: number;
      };
      setBatchId(data.batchId);
      if (data.headers) setHeaders(data.headers);
      if (data.mapping) setMapping(data.mapping);
      if (data.resumed) {
        setNotice(data.message ?? "Continuing the existing import for this file.");
      }
      await refreshPreview(data.batchId);
      void loadHistory();
    } finally {
      setBusy(null);
    }
  }

  async function handleValidate() {
    if (!batchId) return;
    setBusy("validate");
    setError("");
    try {
      const response = await validateImportBatch({ batchId, mapping });
      if (!response.success) {
        setError(response.error ?? "The file could not be validated.");
        return;
      }
      toast.push("success", "Every row has been checked.");
      await refreshPreview(batchId);
      void loadHistory();
    } finally {
      setBusy(null);
    }
  }

  async function handleDecision(rowNumber: number, resolution: ImportResolution) {
    if (!batchId) return;
    setBusy(`row-${rowNumber}`);
    setError("");
    try {
      const response = await resolveImportRows({
        batchId,
        resolutions: [{ rowNumber, resolution }],
      });
      if (!response.success) {
        setError(response.error ?? "That decision could not be saved.");
        return;
      }
      await refreshPreview(batchId);
    } finally {
      setBusy(null);
    }
  }

  async function handleCommit() {
    if (!batchId || !preview) return;
    setBusy("commit");
    setError("");
    try {
      const response = await confirmImportBatch({
        batchId,
        planHash: preview.planHash,
        confirmText,
      });
      if (!response.success) {
        setError(response.error ?? "The import did not run.");
        await refreshPreview(batchId);
        return;
      }
      if ((response.data as { alreadyCommitted?: boolean }).alreadyCommitted) {
        setNotice("This import was already completed. Nothing was imported twice.");
        setConfirmText("");
        await refreshPreview(batchId);
        return;
      }
      const data = response.data as {
        importedCustomers: number;
        importedAccounts: number;
        linkedRows: number;
        skippedRows: number;
        failedRows: number;
      };
      setResult(data);
      setConfirmText("");
      await refreshPreview(batchId);
      void loadHistory();
      toast.push("success", `Imported ${data.importedCustomers} customer(s).`);
    } finally {
      setBusy(null);
    }
  }

  async function handleErrorReport() {
    if (!batchId) return;
    const response = await getImportErrorReport({ batchId });
    if (!response.success) {
      setError(response.error ?? "The report could not be produced.");
      return;
    }
    const data = response.data as { fileName: string; csv: string; rowCount: number };
    if (data.rowCount === 0) {
      setNotice("No row in this import needs attention.");
      return;
    }
    download(data.fileName, data.csv);
  }

  async function handleDiscard() {
    if (!batchId) return;
    setBusy("discard");
    try {
      const response = await discardImportBatch({ batchId });
      if (!response.success) {
        setError(response.error ?? "This import could not be discarded.");
        return;
      }
      setPreview(null);
      setBatchId(null);
      setHeaders([]);
      setMapping({});
      setResult(null);
      setNotice("The import was discarded. Nothing was created.");
      void loadHistory();
    } finally {
      setBusy(null);
    }
  }

  function handleFilterChange(next: typeof filter) {
    setFilter(next);
    if (batchId) void refreshPreview(batchId, next);
  }

  const step = !preview
    ? headers.length
      ? "map"
      : "upload"
    : preview.batch.status === "committed" || preview.batch.status === "partially_committed"
      ? "done"
      : preview.batch.validatedAt
        ? "review"
        : "map";

  const summary = preview?.summary;
  const importable = useMemo(
    () => (summary ? summary.newCustomerRows + summary.existingCustomerRows : 0),
    [summary]
  );

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-brand-900">Customer import</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Move a paper register or another system into MaaCash in stages. Nothing is
            written until you review the plan and confirm it. A migration creates customer
            records and savings accounts only — it never invents a contribution, a
            withdrawal or a card fee.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => download("maacash-import-template.csv", buildImportTemplateCsv())}
          >
            <Download className="mr-1 h-4 w-4" aria-hidden /> Template
          </button>
          <Link href="/susu/admin/customers" className="btn btn-secondary btn-sm">
            <ArrowLeft className="mr-1 h-4 w-4" aria-hidden /> Customers
          </Link>
        </div>
      </header>

      <ol className="flex flex-wrap gap-2 text-xs font-medium">
        {[
          ["upload", "1. Upload"],
          ["map", "2. Match columns"],
          ["review", "3. Review"],
          ["done", "4. Done"],
        ].map(([key, label]) => (
          <li
            key={key}
            className={`rounded-full px-3 py-1 ${
              step === key
                ? "bg-brand-700 text-white"
                : "bg-slate-100 text-slate-600"
            }`}
          >
            {label}
          </li>
        ))}
      </ol>

      {error ? <Notice type="error">{error}</Notice> : null}
      {notice ? <Notice type="info">{notice}</Notice> : null}

      {step === "upload" ? (
        <form
          className="space-y-4 rounded-control border border-line bg-white p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void handleUpload(new FormData(event.currentTarget));
          }}
        >
          <h2 className="text-lg font-semibold">Choose the file</h2>
          <p className="text-sm text-ink-muted">
            A CSV file with one customer per row. Use the template if your register is on
            paper. Maximum 5,000 rows and 4 MB per file.
          </p>
          <label className="block text-sm">
            Name this import
            <input
              name="name"
              required
              minLength={3}
              defaultValue=""
              placeholder="e.g. Tema register, January 2026"
              className="form-input mt-1 w-full"
            />
          </label>
          {!branchless ? (
            <label className="block text-sm">
              Destination branch
              <select name="branchId" className="form-input mt-1 w-full" defaultValue="">
                <option value="">Use my branch / decide per row</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name} ({branch.code})
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-ink-muted">
                If your file names a branch on each row, that wins over this choice.
              </span>
            </label>
          ) : (
            <p className="text-sm text-ink-muted">
              This business has no branches, so accounts are recorded as unassigned.
            </p>
          )}
          <label className="block text-sm">
            CSV file
            <input
              ref={fileInput}
              name="file"
              type="file"
              accept=".csv,text/csv"
              required
              className="form-input mt-1 w-full"
            />
          </label>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy === "upload"}>
            {busy === "upload" ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Upload className="mr-1 h-4 w-4" aria-hidden />
            )}
            Read the file
          </button>
        </form>
      ) : null}

      {step === "map" && preview ? (
        <div className="space-y-4 rounded-control border border-line bg-white p-5">
          <h2 className="text-lg font-semibold">Match your columns</h2>
          <p className="text-sm text-ink-muted">
            MaaCash proposes a match from the column headings. Check it before continuing:
            a wrong column silently puts a phone number in the amount field.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {IMPORT_FIELDS.map((field) => (
              <label key={field.key} className="block text-sm">
                <span className="font-medium">
                  {field.label}
                  {field.required ? <span className="text-red-600"> *</span> : null}
                </span>
                <select
                  className="form-input mt-1 w-full"
                  value={mapping[field.key] ?? ""}
                  onChange={(event) =>
                    setMapping((current) => {
                      const next: ColumnMapping = { ...current };
                      if (event.target.value === "") delete next[field.key];
                      else next[field.key] = Number(event.target.value);
                      return next;
                    })
                  }
                >
                  <option value="">Not in my file</option>
                  {headers.map((header, index) => (
                    <option key={`${header}-${index}`} value={index}>
                      {header}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-ink-muted">{field.hint}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleValidate}
              disabled={busy === "validate"}
            >
              {busy === "validate" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <ShieldCheck className="mr-1 h-4 w-4" aria-hidden />
              )}
              Check every row
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setPreview(null);
                setBatchId(null);
                setHeaders([]);
                setMapping({});
              }}
            >
              Start again
            </button>
          </div>
        </div>
      ) : null}

      {preview ? (
        <div className="space-y-4">
          <div className="rounded-control border border-line bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{preview.batch.name}</h2>
                <p className="text-sm text-ink-muted">
                  {preview.batch.fileName} · {preview.batch.totalRows} row(s) ·{" "}
                  {preview.batch.branchMode === "row_column"
                    ? "branch named on each row"
                    : preview.batch.branchName
                      ? `branch: ${preview.batch.branchName}`
                      : "unassigned branch"}
                </p>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  STATUS_TONE[preview.batch.status] ?? "bg-slate-100 text-slate-700"
                }`}
              >
                {preview.batch.status.replace(/_/g, " ")}
              </span>
            </div>

            {summary ? (
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-ink-muted">New people</dt>
                  <dd className="text-lg font-semibold">{summary.newCustomerRows}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-ink-muted">
                    New accounts for existing people
                  </dt>
                  <dd className="text-lg font-semibold">{summary.existingCustomerRows}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-ink-muted">Duplicates</dt>
                  <dd className="text-lg font-semibold">{summary.duplicateRows}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-ink-muted">Need a decision</dt>
                  <dd className="text-lg font-semibold">{summary.reviewRows}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-ink-muted">Rows rejected</dt>
                  <dd className="text-lg font-semibold">{summary.invalidRows}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-ink-muted">Already imported</dt>
                  <dd className="text-lg font-semibold">
                    {summary.importedCustomers + summary.linkedRows}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-ink-muted">Skipped</dt>
                  <dd className="text-lg font-semibold">{summary.skippedRows}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-ink-muted">Failed</dt>
                  <dd className="text-lg font-semibold">{summary.failedRows}</dd>
                </div>
              </dl>
            ) : null}

            {preview.batch.failureReason ? (
              <p className="mt-3 rounded-control bg-amber-50 p-3 text-sm text-amber-900">
                {preview.batch.failureReason}
              </p>
            ) : null}
          </div>

          <div className="rounded-control border border-line bg-white">
            <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
              {(
                [
                  ["all", "All rows"],
                  ["review", "Needs a decision"],
                  ["duplicate", "Duplicates"],
                  ["invalid", "Rejected"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleFilterChange(key)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    filter === key ? "bg-brand-700 text-white" : "bg-slate-100 text-slate-700"
                  }`}
                >
                  {label}
                </button>
              ))}
              <span className="ml-auto text-xs text-ink-muted">
                Showing {preview.rows.length} of {preview.filteredTotal}
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleErrorReport}
              >
                <FileSpreadsheet className="mr-1 h-4 w-4" aria-hidden /> Error report
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-brand-50 text-ink">
                  <tr>
                    <th className="p-2">Row</th>
                    <th className="p-2">Customer</th>
                    <th className="p-2">Phone</th>
                    <th className="p-2">Daily</th>
                    <th className="p-2">Branch</th>
                    <th className="p-2">Result</th>
                    <th className="p-2">Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.rowNumber} className="border-t border-line align-top">
                      <td className="p-2 text-ink-muted">{row.rowNumber}</td>
                      <td className="p-2">
                        <div className="font-medium">{row.customerName ?? "—"}</div>
                        {row.externalReference ? (
                          <div className="text-xs text-ink-muted">
                            Ref: {row.externalReference}
                          </div>
                        ) : null}
                        {row.accountNumber ? (
                          <div className="text-xs text-ink-muted">
                            Account: {row.accountNumber}
                          </div>
                        ) : null}
                      </td>
                      <td className="p-2">{row.phone ?? "—"}</td>
                      <td className="p-2">
                        {row.dailyContribution === null
                          ? "—"
                          : `GH₵${row.dailyContribution.toFixed(2)}`}
                      </td>
                      <td className="p-2">{row.branchLabel ?? "—"}</td>
                      <td className="p-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            CLASSIFICATION_TONE[row.classification] ?? "bg-slate-100"
                          }`}
                        >
                          {row.classificationLabel}
                        </span>
                        {row.issues.length ? (
                          <ul className="mt-1 list-disc pl-4 text-xs text-red-700">
                            {row.issues.map((issue) => (
                              <li key={issue.code}>{issue.message}</li>
                            ))}
                          </ul>
                        ) : null}
                        {row.matchReasons.length ? (
                          <ul className="mt-1 list-disc pl-4 text-xs text-ink-muted">
                            {row.matchReasons.map((reason) => (
                              <li key={reason}>{reason}</li>
                            ))}
                          </ul>
                        ) : null}
                        {row.outcomeMessage ? (
                          <p className="mt-1 text-xs text-ink-muted">{row.outcomeMessage}</p>
                        ) : null}
                      </td>
                      <td className="p-2">
                        {row.outcome ? (
                          <span className="text-xs font-medium text-ink-muted">
                            {row.outcome}
                          </span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {allowedResolutions(row.classification).map((resolution) => (
                              <button
                                key={resolution}
                                type="button"
                                disabled={
                                  busy === `row-${row.rowNumber}` ||
                                  (resolution === "link_existing" && !row.matchedCustomerName)
                                }
                                onClick={() => handleDecision(row.rowNumber, resolution)}
                                className={`rounded px-2 py-1 text-xs font-medium ${
                                  row.resolution === resolution
                                    ? "bg-brand-700 text-white"
                                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                                } disabled:opacity-40`}
                                title={
                                  resolution === "link_existing"
                                    ? row.matchedCustomerName ?? "No existing customer matched"
                                    : undefined
                                }
                              >
                                {resolution === "create_new"
                                  ? "Create"
                                  : resolution === "link_existing"
                                    ? "Link"
                                    : "Exclude"}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {step === "review" ? (
            <div className="space-y-3 rounded-control border border-line bg-white p-5">
              <h2 className="text-lg font-semibold">Confirm the import</h2>
              {preview.ready ? (
                <>
                  <p className="text-sm text-ink-muted">
                    {importable} customer(s) will be created or linked, each with one savings
                    account and its first cycle. No money will be recorded. This cannot be
                    undone from the screen, so review the rows above first.
                  </p>
                  <div className="rounded-control bg-slate-50 p-3 font-mono text-xs text-slate-600">
                    plan {preview.planHash.slice(0, 16)}…
                  </div>
                  <label className="block text-sm">
                    Type <span className="font-semibold">IMPORT</span> to confirm
                    <input
                      className="form-input mt-1 w-full md:w-64"
                      value={confirmText}
                      onChange={(event) => setConfirmText(event.target.value)}
                      placeholder="IMPORT"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={handleCommit}
                      disabled={
                        busy === "commit" || confirmText.trim().toUpperCase() !== "IMPORT"
                      }
                    >
                      {busy === "commit" ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <CheckCircle2 className="mr-1 h-4 w-4" aria-hidden />
                      )}
                      Run the import
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={handleDiscard}
                      disabled={busy === "discard"}
                    >
                      Discard this import
                    </button>
                  </div>
                </>
              ) : (
                <p className="flex items-start gap-2 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {summary?.reviewRows} row(s) still need a decision. Choose Create, Link or
                  Exclude for each one before the import can run.
                </p>
              )}
            </div>
          ) : null}

          {result ? (
            <div className="space-y-2 rounded-control border border-emerald-200 bg-emerald-50 p-5">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-emerald-900">
                <CheckCircle2 className="h-5 w-5" aria-hidden /> Import finished
              </h2>
              <p className="text-sm text-emerald-900">
                {result.importedCustomers} customer(s) created, {result.linkedRows} existing
                customer(s) linked to a new account, {result.skippedRows} skipped and{" "}
                {result.failedRows} failed. Open the Customers screen to see them.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-control border border-line bg-white">
        <h2 className="border-b border-line p-4 text-lg font-semibold">Import history</h2>
        {history.length === 0 ? (
          <p className="p-4 text-sm text-ink-muted">No import has been run yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-brand-50 text-ink">
                <tr>
                  <th className="p-3">Import</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Rows</th>
                  <th className="p-3">Created</th>
                  <th className="p-3">Linked</th>
                  <th className="p-3">Skipped</th>
                  <th className="p-3">Failed</th>
                  <th className="p-3">Started</th>
                </tr>
              </thead>
              <tbody>
                {history.map((batch) => (
                  <tr
                    key={batch.id}
                    className="cursor-pointer border-t border-line hover:bg-brand-50"
                    onClick={() => {
                      setResult(null);
                      setError("");
                      setNotice("");
                      void refreshPreview(batch.id, "all").then(() => {
                        setFilter("all");
                      });
                    }}
                  >
                    <td className="p-3">
                      <div className="font-medium">{batch.name}</div>
                      <div className="text-xs text-ink-muted">{batch.fileName}</div>
                    </td>
                    <td className="p-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          STATUS_TONE[batch.status] ?? "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {batch.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="p-3">{batch.totalRows}</td>
                    <td className="p-3">{batch.importedCustomers}</td>
                    <td className="p-3">{batch.importedAccounts}</td>
                    <td className="p-3">{batch.skippedRows}</td>
                    <td className="p-3">{batch.failedRows}</td>
                    <td className="p-3 text-xs text-ink-muted">
                      {new Date(batch.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
