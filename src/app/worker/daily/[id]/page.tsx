"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  CheckCircle2,
  ChevronDown,
  Landmark,
  Receipt,
  Save,
  Send,
  Smartphone,
  Wallet,
  X,
} from "lucide-react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { isRedirectError } from "@/lib/errors";

import { useEffect, useMemo, useState } from "react";
import { useObjectDraft } from "@/hooks/useObjectDraft";
import DraftIndicator from "@/components/DraftIndicator";
import Modal from "@/components/ui/Modal";
import { useParams, useRouter } from "next/navigation";
import {
  getDailyAccountById,
  saveDailyAccount,
  submitDailyAccount,
} from "@/lib/actions/daily-account.actions";
import { formatDate } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";
import {
  calculateReconciliation,
  resolveStoredDifference,
} from "@/lib/momo-reconciliation";
import { SuccessTick } from "@/components/ui/SuccessTick";

interface Expense {
  description: string;
  amount: number;
}
interface AccountDetail {
  id: string;
  businessDate: Date;
  status: string;
  updatedAt?: string | Date;
  openingMomoFloat: number;
  openingCash: number;
  debtsCollected: number;
  commission: number;
  closingMomoFloat: number;
  closingCash: number;
  totalExpenses: number;
  calculatedDifference: number;
  differenceStatus: string;
  reconciliationNote: string | null;
  location: { name: string; code: string };
  expenses: Array<{ id: string; description: string; amount: number }>;
}

export default function DailyAccountFormPage() {
  const handleRedirect = useRedirectHandler();
  const params = useParams();
  const router = useRouter();
  const [account, setAccount] = useState<AccountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [serverSavedAt, setServerSavedAt] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [showExpenseDetails, setShowExpenseDetails] = useState(false);

  const [openingCash, setOpeningCash] = useState(0);
  const [openingMomoFloat, setOpeningMomoFloat] = useState(0);
  const [closingCash, setClosingCash] = useState(0);
  const [closingMomoFloat, setClosingMomoFloat] = useState(0);
  const [expensesTotal, setExpensesTotal] = useState(0);
  const [commission, setCommission] = useState(0);
  const [debtsCollected, setDebtsCollected] = useState(0);
  const [reconciliationNote, setReconciliationNote] = useState("");
  const [expenses, setExpenses] = useState<Expense[]>([]);

  // Unfinished daily accounts survive refresh and accidental navigation. The
  // draft is only applied when it is newer than the server record.
  const dailyDraft = useObjectDraft({
    draftKey: `worker-daily:${params.id}`,
    workflow: "worker.daily_account",
    enabled: Boolean(account && account.status === "draft"),
    serverUpdatedAt: account?.updatedAt ?? null,
    value: {
      openingCash,
      openingMomoFloat,
      closingCash,
      closingMomoFloat,
      expensesTotal,
      commission,
      debtsCollected,
      reconciliationNote,
      expenses,
    },
    restore: (draft) => {
      const value = draft as {
        openingCash?: number;
        openingMomoFloat?: number;
        closingCash?: number;
        closingMomoFloat?: number;
        expensesTotal?: number;
        commission?: number;
        debtsCollected?: number;
        reconciliationNote?: string;
        expenses?: Expense[];
      };
      // Only apply keys the draft actually contains. A missing property must
      // never zero a value that came from the server record.
      if (value.openingCash !== undefined) setOpeningCash(Number(value.openingCash));
      if (value.openingMomoFloat !== undefined) setOpeningMomoFloat(Number(value.openingMomoFloat));
      if (value.closingCash !== undefined) setClosingCash(Number(value.closingCash));
      if (value.closingMomoFloat !== undefined) setClosingMomoFloat(Number(value.closingMomoFloat));
      if (value.expensesTotal !== undefined) setExpensesTotal(Number(value.expensesTotal));
      if (value.commission !== undefined) setCommission(Number(value.commission));
      if (value.debtsCollected !== undefined) setDebtsCollected(Number(value.debtsCollected));
      if (value.reconciliationNote !== undefined) setReconciliationNote(String(value.reconciliationNote));
      if (Array.isArray(value.expenses)) {
        setExpenses(
          value.expenses.map((expense) => ({
            description: String(expense?.description ?? ""),
            amount: Number(expense?.amount ?? 0),
          }))
        );
      }
    },
  });

  const draftReady = !account || account.status !== "draft" || dailyDraft.ready;

  async function loadAccount() {
    try {
      const data = await getDailyAccountById(params.id as string);
      if (!data) {
        setError("Account not found or you don't have access");
        return;
      }
      const detail = data as unknown as AccountDetail;
      setAccount(detail);
      setOpeningCash(Number(detail.openingCash));
      setOpeningMomoFloat(Number(detail.openingMomoFloat));
      setClosingCash(Number(detail.closingCash));
      setClosingMomoFloat(Number(detail.closingMomoFloat));
      setCommission(Number(detail.commission));
      setDebtsCollected(Number(detail.debtsCollected));
      setExpensesTotal(Number(detail.totalExpenses));
      setReconciliationNote(detail.reconciliationNote ?? "");
      setExpenses(
        (detail.expenses ?? []).map((expense) => ({
          description: expense.description,
          amount: Number(expense.amount),
        }))
      );
      setServerSavedAt(detail.updatedAt ? new Date(detail.updatedAt).toISOString() : null);
    } catch (err) {
      if (handleRedirect(err, setError, "Failed to load account")) return;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  function addExpense() {
    setShowExpenseDetails(true);
    setExpenses([...expenses, { description: "", amount: 0 }]);
  }
  function removeExpense(index: number) {
    setExpenses(expenses.filter((_, i) => i !== index));
  }
  function updateExpense(index: number, field: keyof Expense, value: string | number) {
    const updated = [...expenses];
    updated[index] = { ...updated[index], [field]: value };
    setExpenses(updated);
  }

  const itemisedExpenseTotal = useMemo(
    () => expenses.reduce((sum, expense) => sum + (Number(expense.amount) || 0), 0),
    [expenses]
  );

  const result = calculateReconciliation({
    openingCash,
    openingMomoFloat,
    debtsCollected,
    commission,
    totalExpenses: expensesTotal,
    closingCash,
    closingMomoFloat,
  });
  const isShortage = result.status === "shortage";
  const isPositive = result.status === "positive";
  const isBalanced = result.status === "balanced";
  const statusClass = isShortage ? "text-red-700" : "text-emerald-700";
  const statusBg = isShortage
    ? "border-red-200 bg-red-50"
    : "border-emerald-200 bg-emerald-50";
  const explanationRequired = isShortage;

  async function buildFormData(): Promise<FormData> {
    const formData = new FormData();
    formData.set("openingCash", String(openingCash));
    formData.set("openingMomoFloat", String(openingMomoFloat));
    formData.set("closingCash", String(closingCash));
    formData.set("closingMomoFloat", String(closingMomoFloat));
    formData.set("totalExpenses", String(expensesTotal));
    formData.set("commission", String(commission));
    formData.set("debtsCollected", String(debtsCollected));
    formData.set("reconciliationNote", reconciliationNote.trim());
    formData.set(
      "expenses",
      JSON.stringify(
        expenses
          .filter((expense) => expense.description.trim() && expense.amount > 0)
          .map((expense) => ({
            description: expense.description.trim(),
            amount: expense.amount,
          }))
      )
    );
    return formData;
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError("");
    setSuccess("");
    setSaveFailed(false);
    setSaveError("");
    try {
      const formData = await buildFormData();
      const saved = await withTimeout(
        saveDailyAccount(params.id as string, formData),
        20_000
      );
      if (saved.success) {
        const savedAt = new Date();
        setServerSavedAt(savedAt.toISOString());
        setSuccess(
          `Draft saved successfully. Last saved at ${savedAt.toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
          })}.`
        );
        dailyDraft.acknowledgeRestored?.();
      } else {
        setSaveFailed(true);
        setSaveError(saved.error || "");
      }
    } catch (err) {
      if (isRedirectError(err)) {
        handleRedirect(err, setError, "");
        return;
      }
      setSaveFailed(true);
      setSaveError("");
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      if (explanationRequired && !reconciliationNote.trim()) {
        setError(
          "This account has a shortage. Explain the shortage before submitting. Your figures stay unchanged."
        );
        setConfirmOpen(false);
        return;
      }
      const formData = await buildFormData();
      const saveResult = await withTimeout(
        saveDailyAccount(params.id as string, formData),
        20_000
      );
      if (!saveResult.success) {
        setError(saveResult.error || "Failed to save");
        setConfirmOpen(false);
        return;
      }
      const submitResult = await withTimeout(
        submitDailyAccount(params.id as string),
        20_000
      );
      if (submitResult.success) {
        setSubmitted(true);
        await dailyDraft.clearDraft();
        window.setTimeout(() => router.push("/worker/dashboard"), 900);
      } else {
        setError(submitResult.error || "Failed to submit");
      }
    } catch (err) {
      if (handleRedirect(err, setError, "An unexpected error occurred")) return;
    } finally {
      setSubmitting(false);
      setConfirmOpen(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 py-4" role="status" aria-label="Loading daily account">
        <div className="skeleton h-24 rounded-xl" />
        <div className="skeleton h-64 rounded-xl" />
        <div className="skeleton h-40 rounded-xl" />
      </div>
    );
  }
  if (!draftReady) {
    return (
      <div className="space-y-4 py-4" role="status" aria-live="polite" aria-busy="true">
        <p className="text-sm font-medium text-slate-700">Restoring your draft…</p>
        <div className="skeleton h-24 rounded-xl" />
        <div className="skeleton h-64 rounded-xl" />
        <div className="skeleton h-40 rounded-xl" />
      </div>
    );
  }
  if (!account) {
    return (
      <div className="text-center py-20">
        <p className="text-slate-500">Account not found</p>
        <button onClick={() => router.push("/worker/dashboard")} className="btn btn-primary mt-4">
          Back to Dashboard
        </button>
      </div>
    );
  }

  if (account.status !== "draft") {
    // Historical and newly submitted records both use the stored difference.
    // Historical rows are never recalculated with the simplified formula.
    const stored = resolveStoredDifference(account);
    const actualClosing =
      Number(account.closingCash) + Number(account.closingMomoFloat);
    const expectedClosing = actualClosing - stored.difference;
    const savedShortage = stored.status === "shortage";
    return (
      <div className="space-y-4">
        <button
          onClick={() => router.push("/worker/dashboard")}
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
        >
          <ArrowLeft size={15} aria-hidden /> Back to dashboard
        </button>
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[var(--shadow-card)]">
          <div className="bg-brand-900 px-5 py-5 text-white sm:px-7">
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-gold-300">
              Daily account
            </p>
            <h1 className="mt-1 text-xl font-bold sm:text-2xl">
              {formatDate(account.businessDate)}
            </h1>
            <p className="mt-1 text-sm text-brand-200">
              {account.location.name} · {account.status}
            </p>
          </div>
          <div className="grid gap-4 p-5 sm:grid-cols-2 sm:p-7">
            <SummaryTile label="Total Physical Cash at close" amount={Number(account.closingCash)} icon={<Banknote />} />
            <SummaryTile label="Total E-cash at close" amount={Number(account.closingMomoFloat)} icon={<Smartphone />} />
            <SummaryTile label="Debts collected" amount={Number(account.debtsCollected)} icon={<Wallet />} />
            <SummaryTile label="Commission" amount={Number(account.commission)} icon={<Receipt />} />
            <SummaryTile label="Expenses" amount={Number(account.totalExpenses)} icon={<Receipt />} />
            <SummaryTile label="Actual closing accountability" amount={actualClosing} icon={<Landmark />} />
          </div>
          <div className={`m-5 mt-0 rounded-xl border p-4 sm:m-7 sm:mt-0 ${savedShortage ? "border-red-200 bg-red-50" : "border-emerald-200 bg-emerald-50"}`}>
            <div className="flex items-start gap-3">
              {savedShortage ? (
                <AlertTriangle className="mt-0.5 text-red-700" size={22} aria-hidden />
              ) : (
                <SuccessTick size={30} label={stored.status === "balanced" ? "Balanced" : "Positive difference"} />
              )}
              <div>
                <p className={`font-semibold ${savedShortage ? "text-red-900" : "text-emerald-900"}`}>
                  {savedShortage
                    ? "SHORTAGE — INVESTIGATION REQUIRED"
                    : stored.status === "balanced"
                      ? "BALANCED"
                      : "POSITIVE DIFFERENCE"}
                </p>
                <p className="mt-1 text-sm text-slate-700">
                  Expected <CediAmount amount={expectedClosing} /> · Actual{" "}
                  <CediAmount amount={actualClosing} /> · Difference{" "}
                  <CediAmount amount={stored.difference} showSign className="font-semibold" />
                </p>
                {account.reconciliationNote && (
                  <p className="mt-2 text-sm text-slate-600">
                    Explanation: {account.reconciliationNote}
                  </p>
                )}
              </div>
            </div>
          </div>
          <p className="border-t border-slate-100 px-5 py-4 text-sm text-slate-500 sm:px-7">
            This report is read-only. Ask an administrator to correct a submitted figure.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-28">
      <button
        onClick={() => router.push("/worker/dashboard")}
        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft size={15} aria-hidden /> Back to dashboard
      </button>

      <header className="overflow-hidden rounded-2xl bg-brand-900 text-white shadow-[var(--shadow-raised)]">
        <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-end sm:justify-between sm:px-7">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-gold-300">
              MoMo daily closing
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight">
              {formatDate(account.businessDate)}
            </h1>
            <p className="mt-1 text-sm text-brand-200">{account.location.name}</p>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2 text-sm">
            <CheckCircle2 size={16} className="text-gold-300" aria-hidden />
            <span>Cash and E-cash are the two pockets of the same business money.</span>
          </div>
        </div>
      </header>

      {error && (
        <div role="alert" className="banner banner-error text-sm">
          {error}
        </div>
      )}
      {success && (
        <div role="status" className="banner banner-success text-sm">
          {success}
        </div>
      )}
      {saveFailed && (
        <div role="alert" className="banner banner-error flex flex-wrap items-center gap-3 text-sm">
          <span>
            We couldn&apos;t save your draft. Your changes are still on this page.
            Please try again.
            {saveError && saveError !== "Failed to save" ? ` ${saveError}` : ""}
          </span>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="btn btn-secondary btn-sm"
          >
            {saving ? "Retrying…" : "Retry save"}
          </button>
        </div>
      )}
      <DraftIndicator
        status={dailyDraft.status}
        lastSavedAt={dailyDraft.lastSavedAt}
        onDiscard={dailyDraft.clearDraft}
        onAcknowledge={dailyDraft.acknowledgeRestored}
        onRetry={dailyDraft.retry}
      />
      {serverSavedAt && !saving && !success && (
        <p className="text-xs text-slate-500" role="status">
          Last saved to the server at{" "}
          {new Date(serverSavedAt).toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
          })}
          .
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="space-y-4">
          {/* START OF DAY — blue/indigo */}
          <section className="overflow-hidden rounded-2xl border border-indigo-200 bg-white shadow-[var(--shadow-card)]">
            <div className="flex items-start gap-3 bg-indigo-50 px-4 py-3.5 sm:px-5">
              <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-indigo-600 text-white" aria-hidden>
                <Landmark size={17} />
              </div>
              <div>
                <p className="text-[11px] font-bold tracking-[0.14em] text-indigo-700">START OF DAY</p>
                <h2 className="text-base font-bold text-slate-900">Opening balances</h2>
                <p className="mt-0.5 text-sm text-slate-600">
                  All the business money available to you when operations begin.
                </p>
              </div>
            </div>
            <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
              <MoneyField
                id="opening-cash"
                label="Total Physical Cash"
                value={openingCash}
                onChange={setOpeningCash}
                hint="All physical business cash at the start of the day."
                tone="indigo"
              />
              <MoneyField
                id="opening-float"
                label="Total E-cash"
                value={openingMomoFloat}
                onChange={setOpeningMomoFloat}
                hint="All electronic MoMo float at the start of the day."
                tone="indigo"
              />
            </div>
            <div className="mx-4 mb-4 flex items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50/70 px-3.5 py-3 sm:mx-5 sm:mb-5">
              <span className="text-sm font-semibold text-indigo-900">Combined opening money</span>
              <span className="text-lg font-bold tnum text-indigo-950">
                <CediAmount amount={result.openingTotal} />
              </span>
            </div>
          </section>

          {/* END OF DAY — green/teal */}
          <section className="overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-[var(--shadow-card)]">
            <div className="flex items-start gap-3 bg-emerald-50 px-4 py-3.5 sm:px-5">
              <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-emerald-600 text-white" aria-hidden>
                <Wallet size={17} />
              </div>
              <div>
                <p className="text-[11px] font-bold tracking-[0.14em] text-emerald-700">END OF DAY</p>
                <h2 className="text-base font-bold text-slate-900">Closing balances and accountability</h2>
                <p className="mt-0.5 text-sm text-slate-600">
                  Enter what you actually have, plus today&apos;s expenses, commission and debts collected.
                </p>
              </div>
            </div>
            <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
              <MoneyField
                id="closing-cash"
                label="Total Physical Cash"
                value={closingCash}
                onChange={setClosingCash}
                hint="The physical cash you actually counted at closing."
                tone="emerald"
              />
              <MoneyField
                id="closing-float"
                label="Total E-cash"
                value={closingMomoFloat}
                onChange={setClosingMomoFloat}
                hint="The MoMo E-cash balance you actually see at closing."
                tone="emerald"
              />
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3">
                <MoneyField
                  id="expenses"
                  label="Expenses"
                  value={expensesTotal}
                  onChange={setExpensesTotal}
                  hint="Food, transport, data and other legitimate business costs."
                  tone="emerald"
                  nested
                />
                <button
                  type="button"
                  onClick={() => setShowExpenseDetails((open) => !open)}
                  className="mt-2 text-xs font-semibold text-emerald-800 underline underline-offset-2"
                  aria-expanded={showExpenseDetails}
                >
                  {showExpenseDetails ? "Hide expense details" : "Add expense details (optional)"}
                </button>
              </div>
              <MoneyField
                id="commission"
                label="Commission"
                value={commission}
                onChange={setCommission}
                hint="Enter the total commission earned for today from your MoMo provider statement."
                tone="emerald"
              />
              <div className="sm:col-span-2">
                <MoneyField
                  id="debts-collected"
                  label="Debts Collected"
                  value={debtsCollected}
                  onChange={setDebtsCollected}
                  hint="Money collected from people who previously owed you. Count it once."
                  tone="emerald"
                />
              </div>
            </div>

            {showExpenseDetails && (
              <div className="mx-4 mb-4 space-y-2 rounded-xl border border-emerald-200 bg-white p-3 sm:mx-5 sm:mb-5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">Expense details</p>
                    <p className="text-xs text-slate-500">
                      Optional. These descriptions support the audit trail; the Expenses total above is the amount used.
                    </p>
                  </div>
                  <button type="button" onClick={addExpense} className="btn btn-secondary btn-sm">
                    + Add line
                  </button>
                </div>
                {expenses.length === 0 && (
                  <p className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-sm text-slate-500">
                    No expense lines yet. You can still enter one Expenses total above.
                  </p>
                )}
                {expenses.map((expense, index) => (
                  <div key={index} className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-start">
                    <div className="flex-1">
                      <label htmlFor={`expense-desc-${index}`} className="sr-only">
                        Expense description {index + 1}
                      </label>
                      <input
                        id={`expense-desc-${index}`}
                        type="text"
                        placeholder="Description (for example Transport)"
                        value={expense.description}
                        onChange={(event) => updateExpense(index, "description", event.target.value)}
                      />
                    </div>
                    <div className="sm:w-40">
                      <label htmlFor={`expense-amount-${index}`} className="sr-only">
                        Expense amount {index + 1}
                      </label>
                      <input
                        id={`expense-amount-${index}`}
                        type="number"
                        autoComplete="off"
                        inputMode="decimal"
                        step="0.01"
                        min="0"
                        placeholder="Amount"
                        value={expense.amount || ""}
                        onChange={(event) =>
                          updateExpense(index, "amount", Number.parseFloat(event.target.value) || 0)
                        }
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeExpense(index)}
                      className="self-end rounded-lg p-2 text-red-600 hover:bg-red-50 sm:self-auto"
                      aria-label={`Remove expense ${index + 1}`}
                    >
                      <X size={16} aria-hidden />
                    </button>
                  </div>
                ))}
                {expenses.length > 0 && (
                  <p className="text-xs text-slate-500">
                    Detail lines total <CediAmount amount={itemisedExpenseTotal} />.
                    {Math.abs(itemisedExpenseTotal - expensesTotal) > 0.004 && (
                      <span className="ml-1 font-medium text-amber-800">
                        The Expenses total above is what will be used.
                      </span>
                    )}
                  </p>
                )}
              </div>
            )}
          </section>

          {/* Reconciliation result */}
          <section className={`rounded-2xl border p-4 shadow-[var(--shadow-card)] sm:p-5 ${statusBg}`}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-start gap-3">
                {isShortage ? (
                  <AlertTriangle size={28} className="mt-0.5 flex-none text-red-700" aria-hidden />
                ) : (
                  <SuccessTick
                    size={36}
                    label={isBalanced ? "Balanced" : "Positive difference"}
                  />
                )}
                <div>
                  <p className={`text-lg font-bold ${statusClass}`}>
                    {isBalanced
                      ? "BALANCED"
                      : isPositive
                        ? "POSITIVE DIFFERENCE"
                        : "SHORTAGE — INVESTIGATION REQUIRED"}
                  </p>
                  <p className="mt-1 max-w-md text-sm text-slate-600">
                    {isBalanced
                      ? "Actual closing accountability matches expected closing accountability."
                      : isPositive
                        ? "Actual money is higher than expected. This is not a shortage. Add a short explanation so the administrator can review it."
                        : "Actual money is below expected. Explain the shortage before you submit. Do not change the counted figures to force a balance."}
                  </p>
                </div>
              </div>
              <p className={`text-2xl font-bold tnum sm:text-right ${statusClass}`}>
                <CediAmount amount={result.difference} showSign />
              </p>
            </div>

            <div className="mt-4 space-y-2 border-t border-white/60 pt-4 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-slate-600">Opening total</span>
                <CediAmount amount={result.openingTotal} className="font-semibold" />
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-slate-600">Debts collected</span>
                <CediAmount amount={debtsCollected} className="font-semibold" />
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-slate-600">Commission</span>
                <CediAmount amount={commission} className="font-semibold" />
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-slate-600">Expenses</span>
                <CediAmount amount={expensesTotal} className="font-semibold" />
              </div>
              <div className="flex justify-between gap-3 border-t border-white/70 pt-2">
                <span className="font-semibold text-slate-700">Expected closing accountability</span>
                <CediAmount amount={result.expectedClosing} className="font-bold" />
              </div>
              <div className="flex justify-between gap-3">
                <span className="font-semibold text-slate-700">Actual closing accountability</span>
                <CediAmount amount={result.actualClosing} className="font-bold" />
              </div>
            </div>

            <div className="mt-4">
              <label htmlFor="reconciliation-note" className="form-label">
                {isShortage
                  ? "Shortage explanation (required)"
                  : isPositive
                    ? "Difference explanation (recommended)"
                    : "Note (optional)"}
              </label>
              <textarea
                id="reconciliation-note"
                rows={3}
                maxLength={500}
                value={reconciliationNote}
                onChange={(event) => setReconciliationNote(event.target.value)}
                placeholder={
                  isShortage
                    ? "Explain what happened to the missing money. For example: unrecorded cash removal."
                    : isPositive
                      ? "Explain the extra money. For example: commission paid in cash was higher than the statement."
                      : "Anything the administrator should know about today's account."
                }
              />
              <p className="form-hint">
                This explanation is saved with the reconciliation and shown to the administrator.
              </p>
            </div>
          </section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-4" aria-label="Live accountability summary">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[var(--shadow-card)]">
            <div className="border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-bold text-slate-900">Live accountability</h2>
              <p className="text-xs text-slate-500">Updates as you type.</p>
            </div>
            <div className="space-y-2.5 p-4 text-sm">
              <SummaryRow label="Opening total" amount={result.openingTotal} />
              <SummaryRow label="Debts collected" amount={debtsCollected} tone="positive" />
              <SummaryRow label="Commission" amount={commission} tone="positive" />
              <SummaryRow label="Expenses" amount={-expensesTotal} tone="negative" />
              <div className="border-t border-slate-100 pt-2.5">
                <SummaryRow label="Expected closing" amount={result.expectedClosing} strong />
              </div>
              <SummaryRow label="Actual closing" amount={result.actualClosing} strong />
              <div className={`mt-2 rounded-xl border p-3 ${statusBg}`}>
                <p className="text-xs font-medium text-slate-500">Difference</p>
                <p className={`mt-1 text-xl font-bold tnum ${statusClass}`}>
                  <CediAmount amount={result.difference} showSign />
                </p>
                <p className={`mt-1 text-xs font-semibold ${statusClass}`}>
                  {isBalanced ? "BALANCED" : isPositive ? "POSITIVE DIFFERENCE" : "SHORTAGE — INVESTIGATION REQUIRED"}
                </p>
              </div>
            </div>
            <div className="border-t border-slate-100 p-4">
              <div className="mb-3 grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-emerald-50 p-2.5">
                  <p className="text-[11px] font-medium text-emerald-800">Physical cash</p>
                  <p className="mt-0.5 text-sm font-bold tnum text-emerald-950">
                    <CediAmount amount={closingCash} />
                  </p>
                </div>
                <div className="rounded-lg bg-teal-50 p-2.5">
                  <p className="text-[11px] font-medium text-teal-800">E-cash</p>
                  <p className="mt-0.5 text-sm font-bold tnum text-teal-950">
                    <CediAmount amount={closingMomoFloat} />
                  </p>
                </div>
              </div>
              <button
                onClick={handleSave}
                className="btn btn-secondary w-full"
                disabled={saving || submitting}
                aria-busy={saving}
              >
                <Save size={15} aria-hidden />
                {saving ? "Saving…" : "Save as Draft"}
              </button>
              <button
                onClick={() => setConfirmOpen(true)}
                className="btn btn-primary mt-2 w-full"
                disabled={submitting}
              >
                <Send size={15} aria-hidden />
                Review and submit
              </button>
            </div>
          </div>
          <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between font-semibold text-slate-800">
              How the day is calculated
              <ChevronDown size={16} aria-hidden />
            </summary>
            <div className="mt-3 space-y-2 text-xs text-slate-600">
              <p>
                Expected = opening physical cash + opening E-cash + debts collected + commission − expenses.
              </p>
              <p>
                Customer deposits, withdrawals and airtime move money between cash and E-cash. They do not change the combined total, so they are not entered here.
              </p>
            </div>
          </details>
        </aside>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => {
          if (!submitting) setConfirmOpen(false);
        }}
        title="Submit today's account?"
        description="The account becomes read-only after submission. Check the figures before you continue."
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="btn btn-secondary"
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              className="btn btn-primary"
              disabled={submitting || (explanationRequired && !reconciliationNote.trim())}
              aria-busy={submitting}
            >
              {submitting ? "Submitting…" : "Submit account"}
            </button>
          </>
        }
      >
        <dl className="space-y-2 rounded-xl bg-slate-50 p-3 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Expected closing</dt>
            <dd className="font-semibold tnum"><CediAmount amount={result.expectedClosing} /></dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Actual closing</dt>
            <dd className="font-semibold tnum"><CediAmount amount={result.actualClosing} /></dd>
          </div>
          <div className="flex justify-between gap-3 border-t border-slate-200 pt-2">
            <dt className="font-medium text-slate-700">Difference</dt>
            <dd className={`font-bold tnum ${statusClass}`}><CediAmount amount={result.difference} showSign /></dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Status</dt>
            <dd className={`font-semibold ${statusClass}`}>
              {isBalanced ? "BALANCED" : isPositive ? "POSITIVE DIFFERENCE" : "SHORTAGE — INVESTIGATION REQUIRED"}
            </dd>
          </div>
        </dl>
        {isShortage && !reconciliationNote.trim() && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
            Explain the shortage in the reconciliation section before submitting.
          </p>
        )}
        {isShortage && (
          <p className="mt-3 text-xs text-slate-500">
            The counted cash and E-cash stay exactly as entered. Only an administrator can correct a submitted figure.
          </p>
        )}
      </Modal>

      <Modal
        open={submitted}
        onClose={() => {}}
        title="Account submitted"
        description="The reconciliation is saved. Returning to your dashboard."
        size="sm"
      >
        <div className="flex justify-center py-2">
          <SuccessTick size={56} label="Account submitted successfully" />
        </div>
      </Modal>
    </div>
  );
}

function MoneyField({
  id,
  label,
  value,
  onChange,
  hint,
  tone = "indigo",
  nested = false,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  hint: string;
  tone?: "indigo" | "emerald";
  nested?: boolean;
}) {
  const toneClasses =
    tone === "indigo"
      ? "border-indigo-200 bg-indigo-50/40 focus-within:border-indigo-400 focus-within:bg-white"
      : "border-emerald-200 bg-emerald-50/40 focus-within:border-emerald-400 focus-within:bg-white";
  return (
    <label
      htmlFor={id}
      className={`block rounded-xl border p-3 ${nested ? "border-transparent bg-transparent p-0 focus-within:bg-transparent" : toneClasses}`}
    >
      <span className="text-sm font-semibold text-slate-800">{label}</span>
      <span className="mt-1 flex items-center rounded-lg border border-slate-200 bg-white px-2.5 focus-within:border-brand-500">
        <span className="text-sm font-semibold text-slate-500" aria-hidden>
          GH₵
        </span>
        <input
          id={id}
          type="number" autoComplete="off"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={value || ""}
          onChange={(event) => onChange(Number.parseFloat(event.target.value) || 0)}
          placeholder="0.00"
          className="!border-0 !bg-transparent !px-2 !py-2 !shadow-none"
        />
      </span>
      <span className="mt-1.5 block text-xs leading-relaxed text-slate-500">{hint}</span>
    </label>
  );
}

function SummaryRow({
  label,
  amount,
  tone,
  strong,
}: {
  label: string;
  amount: number;
  tone?: "positive" | "negative";
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={strong ? "font-semibold text-slate-800" : "text-slate-500"}>{label}</span>
      <span
        className={`tnum ${
          strong ? "font-bold text-slate-900" : "font-medium text-slate-700"
        } ${tone === "positive" ? "text-emerald-700" : tone === "negative" ? "text-red-700" : ""}`}
      >
        <CediAmount amount={amount} showSign={tone != null} />
      </span>
    </div>
  );
}

function SummaryTile({
  label,
  amount,
  icon,
}: {
  label: string;
  amount: number;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-center gap-2 text-slate-500">
        <span className="[&>svg]:h-4 [&>svg]:w-4" aria-hidden>
          {icon}
        </span>
        <p className="text-xs font-medium">{label}</p>
      </div>
      <p className="mt-1.5 text-xl font-bold tnum text-slate-900">
        <CediAmount amount={amount} />
      </p>
    </div>
  );
}

/**
 * A server action that never settles must not pin the UI in a saving state.
 * The caller shows a retryable error instead of waiting indefinitely.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("The save took too long. Please try again."));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
