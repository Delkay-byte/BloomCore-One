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
  Sparkles,
  Wallet,
  X,
} from "lucide-react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { isRedirectError } from "@/lib/errors";

import { useEffect, useState } from "react";
import { useObjectDraft } from "@/hooks/useObjectDraft";
import DraftIndicator from "@/components/DraftIndicator";
import { useParams, useRouter } from "next/navigation";
import { getDailyAccountById, saveDailyAccount, submitDailyAccount } from "@/lib/actions/daily-account.actions";
import { formatDate } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";
import { calculateReconciliation } from "@/lib/momo-reconciliation";
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
  additionalCashReceived: number;
  additionalMomoFloat: number;
  totalCashIn: number;
  totalCashOut: number;
  totalAirtimeSold: number;
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

  const [openingCash, setOpeningCash] = useState(0);
  const [openingMomoFloat, setOpeningMomoFloat] = useState(0);
  const [additionalCashReceived, setAdditionalCashReceived] = useState(0);
  const [additionalMomoFloat, setAdditionalMomoFloat] = useState(0);
  const [customerDeposit, setCustomerDeposit] = useState(0);
  const [cashOut, setCashOut] = useState(0);
  const [airtimeSold, setAirtimeSold] = useState(0);
  const [commission, setCommission] = useState(0);
  const [closingCash, setClosingCash] = useState(0);
  const [closingMomoFloat, setClosingMomoFloat] = useState(0);
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
      additionalCashReceived,
      additionalMomoFloat,
      customerDeposit,
      cashOut,
      airtimeSold,
      commission,
      closingCash,
      closingMomoFloat,
      reconciliationNote,
      expenses,
    },
    restore: (draft) => {
      const value = draft as {
        openingCash?: number;
        openingMomoFloat?: number;
        additionalCashReceived?: number;
        additionalMomoFloat?: number;
        customerDeposit?: number;
        cashOut?: number;
        airtimeSold?: number;
        commission?: number;
        closingCash?: number;
        closingMomoFloat?: number;
        reconciliationNote?: string;
        expenses?: Expense[];
      };
      // Only apply keys the draft actually contains. A missing property must
      // never zero a value that came from the server record.
      if (value.openingCash !== undefined) setOpeningCash(Number(value.openingCash));
      if (value.openingMomoFloat !== undefined) setOpeningMomoFloat(Number(value.openingMomoFloat));
      if (value.additionalCashReceived !== undefined) setAdditionalCashReceived(Number(value.additionalCashReceived));
      if (value.additionalMomoFloat !== undefined) setAdditionalMomoFloat(Number(value.additionalMomoFloat));
      if (value.customerDeposit !== undefined) setCustomerDeposit(Number(value.customerDeposit));
      if (value.cashOut !== undefined) setCashOut(Number(value.cashOut));
      if (value.airtimeSold !== undefined) setAirtimeSold(Number(value.airtimeSold));
      if (value.commission !== undefined) setCommission(Number(value.commission));
      if (value.closingCash !== undefined) setClosingCash(Number(value.closingCash));
      if (value.closingMomoFloat !== undefined) setClosingMomoFloat(Number(value.closingMomoFloat));
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
      setAdditionalCashReceived(Number(detail.additionalCashReceived));
      setAdditionalMomoFloat(Number(detail.additionalMomoFloat));
      setCustomerDeposit(Number(detail.totalCashIn));
      setCashOut(Number(detail.totalCashOut));
      setAirtimeSold(Number(detail.totalAirtimeSold));
      setCommission(Number(detail.commission));
      setClosingCash(Number(detail.closingCash));
      setClosingMomoFloat(Number(detail.closingMomoFloat));
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
  const totalExpenses = expenses.reduce(
    (sum, expense) => sum + (Number(expense.amount) || 0),
    0
  );
  const result = calculateReconciliation({
    openingCash,
    openingMomoFloat,
    additionalCashReceived,
    additionalMomoFloat,
    customerDeposit,
    cashOut,
    airtimeSold,
    commission,
    totalExpenses,
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

  async function buildFormData(): Promise<FormData> {
    const formData = new FormData();
    formData.set("openingCash", String(openingCash));
    formData.set("openingMomoFloat", String(openingMomoFloat));
    formData.set("additionalCashReceived", String(additionalCashReceived));
    formData.set("additionalMomoFloat", String(additionalMomoFloat));
    formData.set("totalCashIn", String(customerDeposit));
    formData.set("totalCashOut", String(cashOut));
    formData.set("totalAirtimeSold", String(airtimeSold));
    formData.set("commission", String(commission));
    formData.set("closingCash", String(closingCash));
    formData.set("closingMomoFloat", String(closingMomoFloat));
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
        // Keep the server reason as a short detail. The banner supplies the
        // sentence, so the user never reads the same warning twice.
        setSaveFailed(true);
        setSaveError(saved.error || "");
      }
    } catch (err) {
      if (isRedirectError(err)) {
        handleRedirect(err, setError, "");
        return;
      }
      // The draft banner already says what happened. Do not also raise the
      // generic page error, which produced two stacked alerts.
      setSaveFailed(true);
      setSaveError("");
    } finally {
      // The button must always leave the saving state, even when the action
      // rejects or never resolves.
      setSaving(false);
    }
  }

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      if (isShortage && !reconciliationNote.trim()) {
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
    const saved = calculateReconciliation({
      openingCash: Number(account.openingCash),
      openingMomoFloat: Number(account.openingMomoFloat),
      additionalCashReceived: Number(account.additionalCashReceived),
      additionalMomoFloat: Number(account.additionalMomoFloat),
      customerDeposit: Number(account.totalCashIn),
      cashOut: Number(account.totalCashOut),
      airtimeSold: Number(account.totalAirtimeSold),
      commission: Number(account.commission),
      totalExpenses: Number(account.totalExpenses),
      closingCash: Number(account.closingCash),
      closingMomoFloat: Number(account.closingMomoFloat),
    });
    const savedShortage = saved.status === "shortage";
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
            <SummaryTile label="Physical cash at close" amount={Number(account.closingCash)} icon={<Banknote />} />
            <SummaryTile label="MoMo float at close" amount={Number(account.closingMomoFloat)} icon={<Smartphone />} />
            <SummaryTile label="Expected closing accountability" amount={saved.expectedClosing} icon={<Landmark />} />
            <SummaryTile label="Actual closing accountability" amount={saved.actualClosing} icon={<Wallet />} />
          </div>
          <div className={`m-5 mt-0 rounded-xl border p-4 sm:m-7 sm:mt-0 ${savedShortage ? "border-red-200 bg-red-50" : "border-emerald-200 bg-emerald-50"}`}>
            <div className="flex items-start gap-3">
              {savedShortage ? (
                <AlertTriangle className="mt-0.5 text-red-700" size={22} aria-hidden />
              ) : (
                <SuccessTick size={30} label={saved.status === "balanced" ? "Balanced" : "Positive difference"} />
              )}
              <div>
                <p className={`font-semibold ${savedShortage ? "text-red-900" : "text-emerald-900"}`}>
                  {savedShortage
                    ? "Shortage — Investigation Required"
                    : saved.status === "balanced"
                      ? "Balanced"
                      : "Positive difference"}
                </p>
                <p className="mt-1 text-sm text-slate-700">
                  Difference: <CediAmount amount={saved.difference} showSign className="font-semibold" />
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
            <span>Cash and float move between two pockets. Combined money stays accountable.</span>
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
          <SectionCard
            step="01"
            title="Opening balances"
            hint="What you started the business day with."
            icon={<Landmark size={17} />}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <MoneyField
                id="opening-cash"
                label="Opening physical cash"
                value={openingCash}
                onChange={setOpeningCash}
                hint="Cash counted in the drawer at the start."
              />
              <MoneyField
                id="opening-float"
                label="Opening MoMo float"
                value={openingMomoFloat}
                onChange={setOpeningMomoFloat}
                hint="MoMo balance at the start of the day."
              />
            </div>
          </SectionCard>

          <SectionCard
            step="02"
            title="Additional money received"
            hint="Extra operating money from the boss or owner. Record each amount once."
            icon={<Sparkles size={17} />}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <MoneyField
                id="additional-cash"
                label="Additional cash received"
                value={additionalCashReceived}
                onChange={setAdditionalCashReceived}
                hint="Extra physical cash brought in today."
              />
              <MoneyField
                id="additional-float"
                label="Additional MoMo float received"
                value={additionalMomoFloat}
                onChange={setAdditionalMomoFloat}
                hint="Extra float sent to the business today."
              />
            </div>
          </SectionCard>

          <SectionCard
            step="03"
            title="Today's MoMo activities"
            hint="Enter daily totals, not each customer. These move money between cash and float, so they do not change combined business money."
            icon={<Smartphone size={17} />}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <MoneyField
                id="customer-deposit"
                label="Customer deposit (Cash in)"
                value={customerDeposit}
                onChange={setCustomerDeposit}
                hint="Cash received from customers. Cash up, float down."
              />
              <MoneyField
                id="cash-out"
                label="Cash out"
                value={cashOut}
                onChange={setCashOut}
                hint="Cash paid to customers. Cash down, float up."
              />
              <MoneyField
                id="airtime-sold"
                label="Airtime sold"
                value={airtimeSold}
                onChange={setAirtimeSold}
                hint="Total airtime sold today. Cash up, float down."
              />
            </div>
          </SectionCard>

          <SectionCard
            step="04"
            title="Commission and expenses"
            hint="Commission comes from your provider statement. Expenses reduce closing accountability."
            icon={<Receipt size={17} />}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <MoneyField
                id="commission"
                label="Commission earned"
                value={commission}
                onChange={setCommission}
                hint="Enter the total shown on your MoMo provider statement."
              />
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-medium text-slate-500">Total business expenses</p>
                <p className="mt-1 text-xl font-bold tnum text-slate-900">
                  <CediAmount amount={totalExpenses} />
                </p>
                <p className="mt-1 text-xs text-slate-500">Calculated from the expense items below.</p>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-800">Itemised expenses</p>
                <button type="button" onClick={addExpense} className="btn btn-secondary btn-sm">
                  + Add expense
                </button>
              </div>
              {expenses.length === 0 && (
                <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-sm text-slate-500">
                  No expenses today. Add food, transport, data, shop costs or other legitimate business expenses.
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
                      type="number" autoComplete="off"
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
            </div>
          </SectionCard>

          <SectionCard
            step="05"
            title="Closing balances"
            hint="Count the cash in the drawer and check the MoMo balance. Enter what you actually have."
            icon={<Wallet size={17} />}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <MoneyField
                id="closing-cash"
                label="Actual closing physical cash"
                value={closingCash}
                onChange={setClosingCash}
                hint="The cash you actually counted."
              />
              <MoneyField
                id="closing-float"
                label="Actual closing MoMo float"
                value={closingMomoFloat}
                onChange={setClosingMomoFloat}
                hint="The MoMo balance you actually see."
              />
            </div>
          </SectionCard>

          <SectionCard
            step="06"
            title="Reconciliation result"
            hint="The system compares expected closing accountability with the cash and float you actually have."
            icon={<CheckCircle2 size={17} />}
          >
            <div className={`rounded-2xl border p-4 sm:p-5 ${statusBg}`}>
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
                        ? "Balanced"
                        : isPositive
                          ? "Positive difference"
                          : "Shortage — Investigation Required"}
                    </p>
                    <p className="mt-1 max-w-md text-sm text-slate-600">
                      {isBalanced
                        ? "Actual closing accountability matches expected closing accountability."
                        : isPositive
                          ? "Actual money is higher than expected. Add an explanation so the administrator can review it."
                          : "Actual money is below expected. Explain the shortage before you submit. Do not change the counted figures to force a balance."}
                    </p>
                  </div>
                </div>
                <p className={`text-2xl font-bold tnum sm:text-right ${statusClass}`}>
                  <CediAmount amount={result.difference} showSign />
                </p>
              </div>

              <div className="mt-4 grid gap-2 border-t border-white/60 pt-4 text-sm sm:grid-cols-2">
                <div className="flex justify-between gap-3">
                  <span className="text-slate-600">Expected closing accountability</span>
                  <CediAmount amount={result.expectedClosing} className="font-semibold" />
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-slate-600">Actual closing accountability</span>
                  <CediAmount amount={result.actualClosing} className="font-semibold" />
                </div>
              </div>

              <div className="mt-4">
                <label htmlFor="reconciliation-note" className="form-label">
                  {isShortage ? "Shortage explanation (required)" : "Difference explanation (optional)"}
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
                      : "For example: additional commission shown on the provider statement."
                  }
                />
                <p className="form-hint">
                  This explanation is saved with the reconciliation and shown to the administrator.
                </p>
              </div>

              {!isShortage && !isBalanced && result.difference > 0 && (
                <p className="mt-3 text-xs text-emerald-800">
                  A positive difference is not a shortage. Add the reason if you know it.
                </p>
              )}
            </div>
          </SectionCard>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-4" aria-label="Live accountability summary">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[var(--shadow-card)]">
            <div className="border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-bold text-slate-900">Live accountability</h2>
              <p className="text-xs text-slate-500">Updates as you type.</p>
            </div>
            <div className="space-y-2.5 p-4 text-sm">
              <SummaryRow label="Opening money" amount={result.openingTotal} />
              <SummaryRow label="Additional funding" amount={result.additionalFunding} />
              <SummaryRow label="Commission" amount={commission} tone="positive" />
              <SummaryRow label="Expenses" amount={totalExpenses} tone="negative" />
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
                  {isBalanced ? "Balanced" : isPositive ? "Positive difference" : "Shortage"}
                </p>
              </div>
            </div>
            <div className="border-t border-slate-100 p-4">
              <div className="mb-3 grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-amber-50 p-2.5">
                  <p className="text-[11px] font-medium text-amber-800">Physical cash</p>
                  <p className="mt-0.5 text-sm font-bold tnum text-amber-950">
                    <CediAmount amount={closingCash} />
                  </p>
                </div>
                <div className="rounded-lg bg-sky-50 p-2.5">
                  <p className="text-[11px] font-medium text-sky-800">MoMo float</p>
                  <p className="mt-0.5 text-sm font-bold tnum text-sky-950">
                    <CediAmount amount={closingMomoFloat} />
                  </p>
                </div>
              </div>
              <button
                onClick={handleSave}
                className="btn btn-secondary w-full"
                disabled={saving}
                aria-busy={saving}
              >
                <Save size={15} aria-hidden />
                {saving ? "Saving draft…" : "Save draft"}
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
                Expected = opening cash + opening float + additional funding + commission − expenses.
              </p>
              <p>
                Deposits, cash out and airtime only move money between cash and float. They do not change the combined total.
              </p>
            </div>
          </details>
        </aside>
      </div>

      {confirmOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-slate-950/60 px-4 py-6 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="submit-title"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-[var(--shadow-overlay)] sm:p-6">
            <div className="flex items-start gap-3">
              <div className={`rounded-xl p-2 ${isShortage ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>
                {isShortage ? <AlertTriangle size={20} aria-hidden /> : <CheckCircle2 size={20} aria-hidden />}
              </div>
              <div>
                <h2 id="submit-title" className="text-lg font-bold text-slate-900">
                  Submit today&apos;s account?
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  The account becomes read-only after submission. Check the figures before you continue.
                </p>
              </div>
            </div>
            <dl className="mt-4 space-y-2 rounded-xl bg-slate-50 p-3 text-sm">
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
                  {isBalanced ? "Balanced" : isPositive ? "Positive difference" : "Shortage"}
                </dd>
              </div>
            </dl>
            {isShortage && !reconciliationNote.trim() && (
              <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                Explain the shortage in section 06 before submitting.
              </p>
            )}
            {isShortage && (
              <p className="mt-3 text-xs text-slate-500">
                The counted cash and float stay exactly as entered. Only an administrator can correct a submitted figure.
              </p>
            )}
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="btn btn-secondary flex-1"
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                className="btn btn-primary flex-1"
                disabled={submitting || (isShortage && !reconciliationNote.trim())}
              >
                {submitting ? "Submitting…" : "Submit account"}
              </button>
            </div>
          </div>
        </div>
      )}

      {submitted && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/60 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="submitted-title"
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-[var(--shadow-overlay)]">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50">
              <SuccessTick size={48} label="Account submitted" />
            </div>
            <h2 id="submitted-title" className="mt-4 text-lg font-bold text-slate-900">
              Account submitted
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              The reconciliation is saved. Returning to your dashboard.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionCard({
  step,
  title,
  hint,
  icon,
  children,
}: {
  step: string;
  title: string;
  hint: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[var(--shadow-card)] sm:p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-brand-50 text-brand-700" aria-hidden>
          {icon}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold tracking-[0.12em] text-brand-600">{step}</span>
            <h2 className="text-base font-bold text-slate-900">{title}</h2>
          </div>
          <p className="mt-0.5 text-sm text-slate-500">{hint}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function MoneyField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  hint: string;
}) {
  return (
    <label htmlFor={id} className="block rounded-xl border border-slate-200 bg-slate-50/60 p-3 focus-within:border-brand-400 focus-within:bg-white">
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
