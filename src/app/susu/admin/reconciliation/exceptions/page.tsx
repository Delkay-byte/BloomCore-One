"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Plus, RefreshCw, Search } from "lucide-react";
import Notice from "@/components/ui/Notice";
import { SkeletonTable } from "@/components/ui/Skeletons";
import { formatCedi, formatDateTime } from "@/lib/utils";
import { getBranchesForScope } from "@/lib/actions/branch.actions";
import { getCollectors } from "@/lib/actions/susu-collector.actions";
import {
  listExceptionCases,
  openExceptionCase,
  type ExceptionCaseView,
} from "@/lib/actions/susu-exception-cases.actions";
import {
  CASE_CATEGORIES,
  CASE_CATEGORY_LABELS,
  CASE_STATUSES,
  CASE_STATUS_LABELS,
} from "@/lib/reconciliation-policy";

interface BranchOption { id: string; name: string }
interface CollectorOption { id: string; branchId: string | null; user: { fullName: string } }

const OPEN_STATUSES = [
  "open",
  "assigned",
  "under_review",
  "investigating",
  "awaiting_evidence",
  "escalated",
  "resolution_proposed",
  "reopened",
];

function severityTone(severity: string) {
  return severity === "high"
    ? "bg-red-100 text-red-800"
    : severity === "medium"
      ? "bg-amber-100 text-amber-800"
      : "bg-slate-100 text-slate-700";
}

function QueueInner() {
  const router = useRouter();
  const search = useSearchParams();
  const [cases, setCases] = useState<ExceptionCaseView[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [collectors, setCollectors] = useState<CollectorOption[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [branchId, setBranchId] = useState(search.get("branchId") ?? "");
  const [status, setStatus] = useState(search.get("status") ?? "");
  const [category, setCategory] = useState(search.get("category") ?? "");
  const [severity, setSeverity] = useState(search.get("severity") ?? "");
  const [query, setQuery] = useState(search.get("search") ?? "");
  const [unassigned, setUnassigned] = useState(search.get("unassigned") === "1");
  const [overdue, setOverdue] = useState(search.get("overdue") === "1");
  const [escalated, setEscalated] = useState(search.get("escalated") === "1");
  const [showOpen, setShowOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [openCategory, setOpenCategory] = useState("other");
  const [openSeverity, setOpenSeverity] = useState("medium");
  const [openBranch, setOpenBranch] = useState(branchId);
  const [openCollector, setOpenCollector] = useState("");
  const [amount, setAmount] = useState("");
  const [dueAt, setDueAt] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [result, branchRows, collectorRows] = await Promise.all([
        listExceptionCases({
          branchId: branchId || null,
          status: status || null,
          category: category || null,
          severity: severity || null,
          search: query || null,
          unassigned: unassigned || undefined,
          overdue: overdue || undefined,
          escalated: escalated || undefined,
          limit: 100,
        }),
        getBranchesForScope(),
        getCollectors(),
      ]);
      if (!result.success) {
        setError(result.error ?? "The exception queue could not be loaded.");
        return;
      }
      setCases(result.data?.cases ?? []);
      setTotal(result.data?.total ?? 0);
      setBranches((branchRows as BranchOption[]) ?? []);
      setCollectors((collectorRows as unknown as CollectorOption[]) ?? []);
    } catch {
      setError("The exception queue could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }, [branchId, status, category, severity, query, unassigned, overdue, escalated]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCount = useMemo(
    () => cases.filter((entry) => OPEN_STATUSES.includes(entry.status)).length,
    [cases]
  );
  const scopedCollectors = useMemo(
    () => (openBranch ? collectors.filter((c) => c.branchId === openBranch) : collectors),
    [collectors, openBranch]
  );

  async function createCase() {
    setError("");
    setSuccess("");
    if (title.trim().length < 3) {
      setError("Give the case a title of at least 3 characters.");
      return;
    }
    if (amount && (!Number.isFinite(Number(amount)) || Number(amount) < 0)) {
      setError("Enter a valid amount at stake.");
      return;
    }
    setBusy(true);
    try {
      const result = await openExceptionCase({
        category: openCategory,
        severity: openSeverity,
        title: title.trim(),
        description: description.trim() || undefined,
        amountAtStake: amount ? Number(amount) : 0,
        branchId: openBranch || null,
        collectorId: openCollector || null,
        dueAt: dueAt ? new Date(`${dueAt}T23:59:59.999Z`).toISOString() : undefined,
      });
      if (!result.success || !result.data) {
        setError(result.error ?? "The case could not be opened.");
        return;
      }
      router.push(`/susu/admin/reconciliation/exceptions/${result.data.id}`);
    } catch {
      setError("The case could not be opened. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <AlertTriangle size={22} aria-hidden /> Exception queue
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            {total} case{total === 1 ? "" : "s"} in this view · {openCount} open on this page.
            Cases carry an owner, due date, evidence and a complete transition history.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={13} aria-hidden /> {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowOpen((value) => !value)}>
            <Plus size={13} aria-hidden /> {showOpen ? "Cancel" : "Raise case"}
          </button>
        </div>
      </header>

      {error ? <Notice type="error" message={error}>{error}</Notice> : null}
      {success ? <Notice type="success" message={success}>{success}</Notice> : null}

      {showOpen ? (
        <section className="card space-y-4" aria-label="Raise an exception case">
          <div>
            <h2 className="text-lg font-semibold">Raise an exception case</h2>
            <p className="text-sm text-muted">
              Use this for a difference that is not already captured by a reconciliation run.
              A financial case needs evidence before it can be resolved.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <div className="form-group lg:col-span-2">
              <label className="form-label" htmlFor="case-title">Title *</label>
              <input id="case-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What is the difference?" />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="case-category">Category</label>
              <select id="case-category" value={openCategory} onChange={(event) => setOpenCategory(event.target.value)}>
                {CASE_CATEGORIES.map((value) => <option key={value} value={value}>{CASE_CATEGORY_LABELS[value] ?? value}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="case-severity">Severity</label>
              <select id="case-severity" value={openSeverity} onChange={(event) => setOpenSeverity(event.target.value)}>
                <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="case-branch">Branch</label>
              <select id="case-branch" value={openBranch} onChange={(event) => { setOpenBranch(event.target.value); setOpenCollector(""); }}>
                <option value="">Unassigned branch</option>
                {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="case-collector">Collector</label>
              <select id="case-collector" value={openCollector} onChange={(event) => setOpenCollector(event.target.value)}>
                <option value="">Not collector-specific</option>
                {scopedCollectors.map((collector) => <option key={collector.id} value={collector.id}>{collector.user.fullName}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="case-amount">Amount at stake</label>
              <input id="case-amount" type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="case-due">Due date</label>
              <input id="case-due" type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
            </div>
            <div className="form-group md:col-span-2 lg:col-span-3">
              <label className="form-label" htmlFor="case-description">Description</label>
              <textarea id="case-description" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What was observed, and what evidence is needed?" />
            </div>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => void createCase()} disabled={busy}>
            {busy ? "Opening…" : "Open case"}
          </button>
        </section>
      ) : null}

      <section className="card space-y-3">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div className="form-group">
            <label className="form-label" htmlFor="queue-search">Search</label>
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
              <input id="queue-search" className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Case number, title or reason" />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="queue-branch">Branch</label>
            <select id="queue-branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
              <option value="">All branches in scope</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="queue-status">Status</label>
            <select id="queue-status" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">Any status</option>
              {CASE_STATUSES.map((value) => <option key={value} value={value}>{CASE_STATUS_LABELS[value] ?? value}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="queue-category">Category</label>
            <select id="queue-category" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">Any category</option>
              {CASE_CATEGORIES.map((value) => <option key={value} value={value}>{CASE_CATEGORY_LABELS[value] ?? value}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="queue-severity">Severity</label>
            <select id="queue-severity" value={severity} onChange={(event) => setSeverity(event.target.value)}>
              <option value="">Any severity</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 md:col-span-2 lg:col-span-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={unassigned} onChange={(event) => setUnassigned(event.target.checked)} /> Unassigned</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={overdue} onChange={(event) => setOverdue(event.target.checked)} /> Overdue</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={escalated} onChange={(event) => setEscalated(event.target.checked)} /> Escalated</label>
            {(unassigned || overdue || escalated || status || category || severity || query) ? (
              <button type="button" className="text-xs font-semibold text-brand-700 hover:underline" onClick={() => { setUnassigned(false); setOverdue(false); setEscalated(false); setStatus(""); setCategory(""); setSeverity(""); setQuery(""); }}>
                Clear filters
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <section className="card overflow-hidden !p-0">
        {loading && !cases.length ? (
          <div className="p-4"><SkeletonTable rows={7} columns={7} /></div>
        ) : !cases.length ? (
          <div className="p-6 text-center">
            <p className="text-sm font-semibold">No cases in this view.</p>
            <p className="mt-1 text-xs text-muted">A shortfall opens a case automatically. You can also raise one above.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr><th>Case</th><th>Category</th><th>Severity</th><th>Branch / collector</th><th>Owner</th><th>At stake</th><th>Due</th><th>Status</th></tr>
              </thead>
              <tbody>
                {cases.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <Link href={`/susu/admin/reconciliation/exceptions/${entry.id}`} className="font-semibold text-brand-700 hover:underline">{entry.caseNumber}</Link>
                      <p className="max-w-[20rem] text-xs text-muted">{entry.title}</p>
                    </td>
                    <td className="text-xs">{CASE_CATEGORY_LABELS[entry.category] ?? entry.category}</td>
                    <td><span className={`badge ${severityTone(entry.severity)}`}>{entry.severity}</span></td>
                    <td className="text-xs">{entry.branchName ?? "—"}<br /><span className="text-muted">{entry.collectorName ?? "No collector"}</span></td>
                    <td className="text-xs">{entry.ownerName ?? <span className="font-semibold text-amber-700">Unassigned</span>}</td>
                    <td className="tabular-nums">{formatCedi(entry.amountAtStake ?? 0)}</td>
                    <td className={`whitespace-nowrap text-xs ${entry.overdue ? "font-semibold text-red-700" : ""}`}>
                      {entry.dueAt ? formatDateTime(entry.dueAt) : "—"}
                      {entry.overdue ? <span className="block">Overdue</span> : null}
                    </td>
                    <td><span className="badge">{CASE_STATUS_LABELS[entry.status] ?? entry.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default function ExceptionQueuePage() {
  return (
    <Suspense fallback={<div className="card"><p className="text-sm text-muted">Loading the exception queue…</p></div>}>
      <QueueInner />
    </Suspense>
  );
}
