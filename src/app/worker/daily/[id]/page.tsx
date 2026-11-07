"use client";
import { X } from "lucide-react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";

import { useEffect, useState } from "react";
import { useObjectDraft } from "@/hooks/useObjectDraft";
import DraftIndicator from "@/components/DraftIndicator";
import { useParams, useRouter } from "next/navigation";
import { getDailyAccountById, saveDailyAccount, submitDailyAccount } from "@/lib/actions/daily-account.actions";
import { formatDate } from "@/lib/utils";
import InfoTooltip from "@/components/InfoTooltip";
import CediAmount from "@/components/CediAmount";

interface Expense { description: string; amount: number; }
interface AccountDetail {
  id: string; businessDate: Date; status: string; updatedAt?: string | Date;
  openingMomoFloat: number; openingCash: number;
  totalCashIn: number; totalCashOut: number;
  totalCashReceived: number; totalCashPaid: number;
  commission: number; otherIncome: number;
  closingMomoFloat: number; closingCash: number;
  totalExpenses: number;
  calculatedMomoVariance: number; calculatedCashVariance: number;
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
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [step, setStep] = useState(1);

  const [openingMomoFloat, setOpeningMomoFloat] = useState(0);
  const [openingCash, setOpeningCash] = useState(0);
  const [totalCashIn, setTotalCashIn] = useState(0);
  const [totalCashOut, setTotalCashOut] = useState(0);
  const [totalCashReceived, setTotalCashReceived] = useState(0);
  const [commission, setCommission] = useState(0);
  const [otherIncome, setOtherIncome] = useState(0);
  const [closingMomoFloat, setClosingMomoFloat] = useState(0);
  const [closingCash, setClosingCash] = useState(0);
  const [expenses, setExpenses] = useState<Expense[]>([]);

  // Unfinished daily accounts survive refresh and accidental navigation. The
  // draft is only applied when it is newer than the server record.
  const dailyDraft = useObjectDraft({
    draftKey: `worker-daily:${params.id}`,
    workflow: "worker.daily_account",
    enabled: Boolean(account && account.status === "draft"),
    serverUpdatedAt: account?.updatedAt ?? null,
    value: {
      step,
      openingMomoFloat, openingCash, totalCashIn, totalCashOut,
      totalCashReceived, commission, otherIncome,
      closingMomoFloat, closingCash, expenses,
    },
    restore: (draft) => {
      const value = draft as {
        step?: number;
        openingMomoFloat?: number; openingCash?: number; totalCashIn?: number; totalCashOut?: number;
        totalCashReceived?: number; commission?: number; otherIncome?: number;
        closingMomoFloat?: number; closingCash?: number;
        expenses?: Expense[];
      };
      if (typeof value.step === "number") setStep(value.step);
      setOpeningMomoFloat(Number(value.openingMomoFloat ?? 0));
      setOpeningCash(Number(value.openingCash ?? 0));
      setTotalCashIn(Number(value.totalCashIn ?? 0));
      setTotalCashOut(Number(value.totalCashOut ?? 0));
      setTotalCashReceived(Number(value.totalCashReceived ?? 0));
      setCommission(Number(value.commission ?? 0));
      setOtherIncome(Number(value.otherIncome ?? 0));
      setClosingMomoFloat(Number(value.closingMomoFloat ?? 0));
      setClosingCash(Number(value.closingCash ?? 0));
      setExpenses(Array.isArray(value.expenses) ? value.expenses : []);
    },
  });

  async function loadAccount() {
    try {
      const data = await getDailyAccountById(params.id as string);
      if (!data) { setError("Account not found or you don't have access"); return; }
      setAccount(data as unknown as AccountDetail);
      setOpeningMomoFloat(Number(data.openingMomoFloat));
      setOpeningCash(Number(data.openingCash));
      setTotalCashIn(Number(data.totalCashIn));
      setTotalCashOut(Number(data.totalCashOut));
      setTotalCashReceived(Number(data.totalCashReceived));
      setCommission(Number(data.commission));
      setOtherIncome(Number(data.otherIncome));
      setClosingMomoFloat(Number(data.closingMomoFloat));
      setClosingCash(Number(data.closingCash));
      if (data.expenses && data.expenses.length > 0) {
        setExpenses(data.expenses.map((e) => ({ description: e.description, amount: Number(e.amount) })));
      }
    } catch (err) { if (handleRedirect(err, setError, "Failed to load account")) return; } finally { setLoading(false); }
  }

  useEffect(() => { loadAccount(); }, [params.id]);

  function addExpense() { setExpenses([...expenses, { description: "", amount: 0 }]); }
  function removeExpense(index: number) { setExpenses(expenses.filter((_, i) => i !== index)); }
  function updateExpense(index: number, field: keyof Expense, value: string | number) {
    const updated = [...expenses]; updated[index] = { ...updated[index], [field]: value }; setExpenses(updated);
  }
  function getTotalExpenses() { return expenses.reduce((sum, e) => sum + (e.amount || 0), 0); }
  function calculateMomoVariance() { return closingMomoFloat - (openingMomoFloat + totalCashIn - totalCashOut); }
  // Cash out is counted once: it reduced the MoMo float and it left the
  // cash drawer. The retired "Cash paid out" field is not used.
  function calculateCashVariance() { return closingCash - (openingCash + totalCashReceived + commission + otherIncome - totalCashOut - getTotalExpenses()); }

  async function buildFormData(): Promise<FormData> {
    const formData = new FormData();
    formData.set("openingMomoFloat", String(openingMomoFloat));
    formData.set("openingCash", String(openingCash));
    formData.set("totalCashIn", String(totalCashIn));
    formData.set("totalCashOut", String(totalCashOut));
    formData.set("totalCashReceived", String(totalCashReceived));
    formData.set("commission", String(commission));
    formData.set("otherIncome", String(otherIncome));
    formData.set("closingMomoFloat", String(closingMomoFloat));
    formData.set("closingCash", String(closingCash));
    formData.set("expenses", JSON.stringify(expenses.filter((e) => e.description && e.amount > 0)));
    return formData;
  }

  async function handleSave() {
    setSaving(true); setError(""); setSuccess("");
    try {
      const formData = await buildFormData();
      const result = await saveDailyAccount(params.id as string, formData);
      if (result.success) setSuccess("Draft saved successfully — you can continue later.");
      else setError(result.error || "Failed to save");
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return; } finally { setSaving(false); }
  }

  async function handleSubmit() {
    setSubmitting(true); setError("");
    try {
      const formData = await buildFormData();
      const saveResult = await saveDailyAccount(params.id as string, formData);
      if (!saveResult.success) { setError(saveResult.error || "Failed to save"); setConfirmOpen(false); return; }
      const submitResult = await submitDailyAccount(params.id as string);
      if (submitResult.success) {
        await dailyDraft.clearDraft();
        router.push("/worker/dashboard");
      }
      else setError(submitResult.error || "Failed to submit");
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return; } finally { setSubmitting(false); setConfirmOpen(false); }
  }

  if (loading) return <div className="space-y-4 py-4" role="status" aria-label="Loading daily account"><div className="skeleton h-20 rounded-xl" /><div className="skeleton h-64 rounded-xl" /></div>;
  if (!account) return <div className="text-center py-20"><p className="text-slate-500">Account not found</p><button onClick={() => router.push("/worker/dashboard")} className="btn btn-primary mt-4">Back to Dashboard</button></div>;

  if (account.status !== "draft") {
    return (
      <div>
        <button onClick={() => router.push("/worker/dashboard")} className="text-sm text-slate-500 hover:text-slate-700 mb-4 inline-block">← Back to Dashboard</button>
        <div role="status" className="banner banner-success mb-4">This report has been submitted and is now read-only.</div>
        <div className="card">
          <h2 className="text-lg font-semibold mb-2">Daily Account — {formatDate(account.businessDate)}</h2>
          <p className="text-slate-500 mb-4">{account.location.name}</p>
          <p className="text-sm text-slate-500">Status: <span className="badge badge-green">{account.status}</span></p>
        </div>
      </div>
    );
  }

  const momoVariance = calculateMomoVariance();
  const cashVariance = calculateCashVariance();
  const totalVariance = momoVariance + cashVariance;
  const steps = [{ num: 1, label: "Start" }, { num: 2, label: "Totals" }, { num: 3, label: "Expenses" }, { num: 4, label: "Ending" }, { num: 5, label: "Review" }];

  return (
    <div className="space-y-4">
      <button onClick={() => router.push("/worker/dashboard")} className="text-sm text-slate-500 hover:text-slate-700 inline-block">← Back to Dashboard</button>

      <div className="card !p-4">
        <h1 className="text-lg font-bold text-slate-900">Daily Account</h1>
        <p className="text-sm text-slate-500">{formatDate(account.businessDate)} &bull; {account.location.name}</p>
      </div>

      {error && <div role="alert" className="banner banner-error text-sm">{error}</div>}
      {success && <div role="status" className="banner banner-success text-sm">{success}</div>}
      <DraftIndicator
        status={dailyDraft.status}
        lastSavedAt={dailyDraft.lastSavedAt}
        onDiscard={dailyDraft.clearDraft}
        onAcknowledge={dailyDraft.acknowledgeRestored}
      />

      <div className="flex gap-1 overflow-x-auto pb-2">
        {steps.map((s) => (
          <button key={s.num} onClick={() => setStep(s.num)} aria-current={step === s.num ? "step" : undefined} className={`flex-shrink-0 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${step === s.num ? "bg-brand-700 text-white" : "bg-slate-100 text-slate-600"}`}>
            {s.num}. {s.label}
          </button>
        ))}
      </div>

      {step === 1 && (
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold">Starting Balances</h2>
          <p className="text-sm text-slate-500">Enter the cash and MoMo balance you started business with today.</p>
          <div className="form-group"><label className="form-label">Starting Balance — MoMo (GH&#x20B5;) <InfoTooltip text="MoMo money available when you started the day." /></label><input type="number" autoComplete="off" step="0.01" min="0" value={openingMomoFloat || ""} onChange={(e) => setOpeningMomoFloat(parseFloat(e.target.value) || 0)} placeholder="0.00" /></div>
          <div className="form-group"><label className="form-label">Starting Cash (GH&#x20B5;) <InfoTooltip text="Physical business cash you had at the beginning of the day." /></label><input type="number" autoComplete="off" step="0.01" min="0" value={openingCash || ""} onChange={(e) => setOpeningCash(parseFloat(e.target.value) || 0)} placeholder="0.00" /></div>
          <button onClick={() => setStep(2)} className="btn btn-primary w-full">Next: Daily Totals →</button>
        </div>
      )}

      {step === 2 && (
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold">Daily Business Totals</h2>
          <p className="text-sm text-slate-500">Enter the totals for the three customer movements you handled today.</p>
          <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
            <p className="font-medium text-slate-700">Customer deposit</p>
            <p className="text-xs mt-0.5">Money you added to MoMo for customers who came to deposit cash. This raises your MoMo balance.</p>
          </div>
          <div className="form-group"><label className="form-label">Customer deposit (GH&#x20B5;) <InfoTooltip text="Money added to your MoMo balance through customer deposits." /></label><input type="number" autoComplete="off" step="0.01" min="0" value={totalCashIn || ""} onChange={(e) => setTotalCashIn(parseFloat(e.target.value) || 0)} placeholder="0.00" /></div>
          <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
            <p className="font-medium text-slate-700">Cash out</p>
            <p className="text-xs mt-0.5">Cash you paid to customers who came to withdraw. This lowers both your MoMo balance and your cash.</p>
          </div>
          <div className="form-group"><label className="form-label">Cash out (GH&#x20B5;) <InfoTooltip text="Cash paid to customers who withdrew money. It is counted once, against both the MoMo balance and cash." /></label><input type="number" autoComplete="off" step="0.01" min="0" value={totalCashOut || ""} onChange={(e) => setTotalCashOut(parseFloat(e.target.value) || 0)} placeholder="0.00" /></div>
          <div className="form-group"><label className="form-label">Cash in (GH&#x20B5;) <InfoTooltip text="Physical cash you received during the day." /></label><input type="number" autoComplete="off" step="0.01" min="0" value={totalCashReceived || ""} onChange={(e) => setTotalCashReceived(parseFloat(e.target.value) || 0)} placeholder="0.00" /></div>
          <div className="form-group"><label className="form-label">Commission Earned (GH&#x20B5;) <InfoTooltip text="Commission earned from MoMo transactions during the day." /></label><input type="number" autoComplete="off" step="0.01" min="0" value={commission || ""} onChange={(e) => setCommission(parseFloat(e.target.value) || 0)} placeholder="0.00" /></div>
          <div className="form-group"><label className="form-label">Other money received (GH&#x20B5;) <InfoTooltip text="Money received by the business that is not already included in the other fields above." /></label><input type="number" autoComplete="off" step="0.01" min="0" value={otherIncome || ""} onChange={(e) => setOtherIncome(parseFloat(e.target.value) || 0)} placeholder="0.00" /><p className="form-hint">Example: Owner cash top-up</p></div>
          <div className="flex gap-3"><button onClick={() => setStep(1)} className="btn btn-secondary flex-1">← Back</button><button onClick={() => setStep(3)} className="btn btn-primary flex-1">Next: Expenses →</button></div>
        </div>
      )}

      {step === 3 && (
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold">Business Expenses <InfoTooltip text="Money spent from business cash for approved business expenses (e.g. transport, phone/data, stationery, minor repairs)." /></h2>
          {expenses.map((expense, index) => (
            <div key={index} className="flex gap-2 items-start">
              <div className="flex-1"><input type="text" placeholder="Description (e.g. Transport)" value={expense.description} onChange={(e) => updateExpense(index, "description", e.target.value)} /></div>
              <div className="w-32"><input type="number" autoComplete="off" step="0.01" min="0" placeholder="Amount" value={expense.amount || ""} onChange={(e) => updateExpense(index, "amount", parseFloat(e.target.value) || 0)} /></div>
              <button type="button" onClick={() => removeExpense(index)} className="text-red-500 hover:text-red-700 p-2" aria-label={`Remove expense ${index + 1}`}><X size={16} aria-hidden /></button>
            </div>
          ))}
          <button onClick={addExpense} className="btn btn-secondary btn-sm w-full">+ Add Expense</button>
          {expenses.length > 0 && <div className="border-t pt-3"><div className="flex justify-between font-medium"><span>Total Business Expenses</span><span className="font-mono"><CediAmount amount={getTotalExpenses()} /></span></div></div>}
          <div className="flex gap-3"><button onClick={() => setStep(2)} className="btn btn-secondary flex-1">← Back</button><button onClick={() => setStep(4)} className="btn btn-primary flex-1">Next: Ending →</button></div>
        </div>
      )}

      {step === 4 && (
        <div className="card space-y-4">
          <h2 className="text-lg font-semibold">Ending Balances</h2>
          <p className="text-sm text-slate-500">Count the cash in the drawer and check your MoMo balance. Enter what you actually have, not what you expect.</p>
          <div className="form-group"><label className="form-label">Ending Balance — MoMo (GH&#x20B5;) <InfoTooltip text="MoMo money you have at the end of the day." /></label><input type="number" autoComplete="off" step="0.01" min="0" value={closingMomoFloat || ""} onChange={(e) => setClosingMomoFloat(parseFloat(e.target.value) || 0)} placeholder="0.00" /></div>
          <div className="form-group"><label className="form-label">Ending Cash on Hand (GH&#x20B5;) <InfoTooltip text="Physical business cash available at the location." /></label><input type="number" autoComplete="off" step="0.01" min="0" value={closingCash || ""} onChange={(e) => setClosingCash(parseFloat(e.target.value) || 0)} placeholder="0.00" /></div>
          <div className="flex gap-3"><button onClick={() => setStep(3)} className="btn btn-secondary flex-1">← Back</button><button onClick={() => setStep(5)} className="btn btn-primary flex-1">Next: Review →</button></div>
        </div>
      )}

      {step === 5 && (
        <div className="space-y-4">
          <div className="card">
            <h2 className="text-lg font-semibold mb-4">Review — Today&apos;s Account</h2>
            <div className="space-y-3">
              {/* MoMo Balance */}
              <div className="bg-blue-50 rounded-lg p-4">
                <div className="text-sm text-blue-600 font-medium mb-2">MoMo Balance <InfoTooltip text="MoMo money reconciliation — what the system expects vs. what you have." /></div>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span>Starting Balance</span><span className="font-mono"><CediAmount amount={openingMomoFloat} /></span></div>
                  <div className="flex justify-between"><span>Customer deposit</span><span className="font-mono text-green-700">+<CediAmount amount={totalCashIn} /></span></div>
                  <div className="flex justify-between"><span>Cash out</span><span className="font-mono text-red-700">-<CediAmount amount={totalCashOut} /></span></div>
                  <div className="flex justify-between pt-1 border-t border-blue-200 mt-1"><span className="font-medium">Expected Ending Balance <InfoTooltip text="The balance the system expects after adding money received and subtracting money paid out." /></span><span className="font-mono font-medium"><CediAmount amount={openingMomoFloat + totalCashIn - totalCashOut} /></span></div>
                  <div className="flex justify-between"><span>Your Ending Balance</span><span className="font-mono"><CediAmount amount={closingMomoFloat} /></span></div>
                </div>
<div className="mt-2 pt-2 border-t border-blue-200">
                    <div className="flex justify-between"><span className="text-sm font-medium">Difference <InfoTooltip text="The difference between your ending balance and the amount the system expects." /></span><span className={`font-mono font-bold ${momoVariance === 0 ? "text-green-600" : "text-red-600"}`}><CediAmount amount={momoVariance} /></span></div>
                  </div>
              </div>

              {/* Cash on Hand */}
              <div className="bg-green-50 rounded-lg p-4">
                <div className="text-sm text-green-600 font-medium mb-2">Cash on Hand <InfoTooltip text="Physical business cash reconciliation." /></div>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span>Starting Cash</span><span className="font-mono"><CediAmount amount={openingCash} /></span></div>
                  <div className="flex justify-between"><span>Cash in</span><span className="font-mono text-green-700">+<CediAmount amount={totalCashReceived} /></span></div>
                  <div className="flex justify-between"><span>Cash out</span><span className="font-mono text-red-700">-<CediAmount amount={totalCashOut} /></span></div>
                  <div className="flex justify-between"><span>Commission Earned</span><span className="font-mono text-green-700">+<CediAmount amount={commission} /></span></div>
                  <div className="flex justify-between"><span>Other Money Received</span><span className="font-mono text-green-700">+<CediAmount amount={otherIncome} /></span></div>
                  <div className="flex justify-between"><span>Business Expenses</span><span className="font-mono text-red-700">-<CediAmount amount={getTotalExpenses()} /></span></div>
                  <div className="flex justify-between pt-1 border-t border-green-200 mt-1"><span className="font-medium">Expected Cash <InfoTooltip text="The balance the system expects after adding money received and subtracting cash out and expenses." /></span><span className="font-mono font-medium"><CediAmount amount={openingCash + totalCashReceived + commission + otherIncome - totalCashOut - getTotalExpenses()} /></span></div>
                  <div className="flex justify-between"><span>Your Ending Cash</span><span className="font-mono"><CediAmount amount={closingCash} /></span></div>
                </div>
<div className="mt-2 pt-2 border-t border-green-200">
                    <div className="flex justify-between"><span className="text-sm font-medium">Difference <InfoTooltip text="The difference between your ending cash and the amount the system expects." /></span><span className={`font-mono font-bold ${cashVariance === 0 ? "text-green-600" : "text-red-600"}`}><CediAmount amount={cashVariance} /></span></div>
                  </div>
              </div>

              {/* Total Difference */}
              <div className={`rounded-lg p-4 ${totalVariance === 0 ? "bg-green-100" : "bg-yellow-50 border border-yellow-300"}`}>
                <div className="flex justify-between items-center">
                  <span className="font-semibold">Total Difference <InfoTooltip text="The combined difference between the expected MoMo balance/cash position and the amounts you reported." /></span>
                  <span className={`text-xl font-bold ${totalVariance === 0 ? "text-green-700" : "text-red-700"}`}><CediAmount amount={totalVariance} /></span>
                </div>
                <div className="mt-1"><span className={`badge ${totalVariance === 0 ? "badge-green" : "badge-red"}`}>{totalVariance === 0 ? "Matches" : "⚠ Check Required"}</span></div>
                {totalVariance !== 0 && (
                  <p className="text-sm text-yellow-800 mt-2">
                    The amounts you entered do not match the expected figures. Please review your entries before submitting.
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="card">
            <h2 className="text-lg font-semibold mb-3">Quick Summary</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-600">Business Expenses</span><span className="font-mono"><CediAmount amount={getTotalExpenses()} /></span></div>
              <div className="flex justify-between"><span className="text-slate-600">Commission Earned</span><span className="font-mono"><CediAmount amount={commission} /></span></div>
              <div className="flex justify-between"><span className="text-slate-600">Other Money Received</span><span className="font-mono"><CediAmount amount={otherIncome} /></span></div>
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={() => setStep(4)} className="btn btn-secondary flex-1">← Back</button>
            <button onClick={handleSave} className="btn btn-secondary flex-1" disabled={saving}>{saving ? "Saving..." : "Save Draft"} <InfoTooltip text="Save your work and continue later." /></button>
            <button onClick={() => setConfirmOpen(true)} className="btn btn-primary flex-1" disabled={submitting}>Submit Today&apos;s Account</button>
          </div>
        </div>
      )}

      {/* Submission confirmation — the report becomes locked after submitting */}
      {confirmOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black bg-opacity-50 px-4" role="dialog" aria-modal="true" aria-labelledby="submit-title">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <h2 id="submit-title" className="text-lg font-semibold text-slate-900">Submit today&apos;s account?</h2>
            <p className="text-sm text-slate-600 mt-2">After you submit, this account becomes read-only. Please make sure the figures are correct.</p>
            <div className="flex gap-3 mt-6">
              <button type="button" onClick={() => setConfirmOpen(false)} className="btn btn-secondary flex-1" disabled={submitting}>Cancel</button>
              <button type="button" onClick={handleSubmit} className="btn btn-primary flex-1" disabled={submitting}>{submitting ? "Submitting..." : "Submit Today&apos;s Account"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
