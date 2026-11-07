"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import {
  correctDailyAccount,
  type DailyAccountCorrectionView,
} from "@/lib/actions/daily-account.actions";
import { calculateReconciliation } from "@/lib/momo-reconciliation";
import { formatCedi, formatDateTime } from "@/lib/utils";

type MoneyField =
  | "openingMomoFloat"
  | "openingCash"
  | "totalCashIn"
  | "totalCashOut"
  | "totalCashReceived"
  | "commission"
  | "otherIncome"
  | "closingMomoFloat"
  | "closingCash";

// Approved business terminology. "Cash paid out" is retired because it
// duplicated Cash out; the server no longer reads it from this form.
const FIELDS: Array<{ key: MoneyField; label: string; hint?: string }> = [
  { key: "openingMomoFloat", label: "Opening MoMo balance" },
  { key: "openingCash", label: "Opening cash" },
  { key: "totalCashIn", label: "Customer deposit" },
  { key: "totalCashOut", label: "Cash out" },
  { key: "totalCashReceived", label: "Cash in" },
  { key: "commission", label: "Commission earned" },
  { key: "otherIncome", label: "Other income" },
  { key: "closingMomoFloat", label: "Closing MoMo balance" },
  { key: "closingCash", label: "Closing cash" },
];

function calculate(values: Record<MoneyField, number>, expensesTotal: number) {
  return calculateReconciliation({
    openingMomoFloat: values.openingMomoFloat,
    openingCash: values.openingCash,
    customerDeposit: values.totalCashIn,
    cashOut: values.totalCashOut,
    cashIn: values.totalCashReceived,
    commission: values.commission,
    otherIncome: values.otherIncome,
    totalExpenses: expensesTotal,
    closingMomoFloat: values.closingMomoFloat,
    closingCash: values.closingCash,
  });
}

export default function CorrectionForm({
  data,
}: {
  data: DailyAccountCorrectionView;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<MoneyField, number>>({
    openingMomoFloat: data.values.openingMomoFloat,
    openingCash: data.values.openingCash,
    totalCashIn: data.values.totalCashIn,
    totalCashOut: data.values.totalCashOut,
    totalCashReceived: data.values.totalCashReceived,
    commission: data.values.commission,
    otherIncome: data.values.otherIncome,
    closingMomoFloat: data.values.closingMomoFloat,
    closingCash: data.values.closingCash,
  });
  const [expenses, setExpenses] = useState(
    data.expenses.length > 0
      ? data.expenses
      : [{ description: "", amount: 0 }]
  );
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const expensesTotal = useMemo(
    () => expenses.reduce((sum, expense) => sum + (Number(expense.amount) || 0), 0),
    [expenses]
  );
  const proposed = useMemo(
    () => calculate(values, expensesTotal),
    [values, expensesTotal]
  );

  const changed = useMemo(() => {
    return (
      FIELDS.some((field) => values[field.key] !== data.values[field.key]) ||
      expensesTotal !== data.values.totalExpenses ||
      expenses.length !== data.expenses.length
    );
  }, [values, expenses.length, expensesTotal, data.values, data.expenses.length]);

  function updateField(key: MoneyField, raw: string) {
    const parsed = raw === "" ? 0 : Number(raw);
    setValues((current) => ({
      ...current,
      [key]: Number.isFinite(parsed) ? parsed : 0,
    }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (!changed) {
      setError("Change at least one value before saving a correction.");
      return;
    }
    if (reason.trim().length < 10) {
      setError("Enter a correction reason of at least 10 characters.");
      return;
    }
    if (!confirmed) {
      setError("Confirm that you have reviewed the original and proposed values.");
      return;
    }

    setSaving(true);
    try {
      const formData = new FormData();
      for (const field of FIELDS) {
        formData.set(field.key, String(values[field.key]));
      }
      formData.set(
        "expenses",
        JSON.stringify(
          expenses
            .filter(
              (expense) =>
                expense.description.trim().length > 0 && Number(expense.amount) > 0
            )
            .map((expense) => ({
              description: expense.description.trim(),
              amount: Number(expense.amount),
            }))
        )
      );

      const result = await correctDailyAccount(data.id, formData, reason);
      if (!result.success) {
        setError(result.error ?? "The correction could not be saved.");
        return;
      }
      setSuccess(
        "Correction saved. The previous values are preserved in revision history."
      );
      router.refresh();
    } catch {
      setError("The correction could not be saved. Reload and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <section className="card bg-white">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="font-semibold text-slate-900">Proposed values</h2>
            <span className="text-xs text-slate-500">
              Revision {data.revisionCount + 1}
            </span>
          </div>
          <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Customer deposit, Cash out and Cash in are the approved field names.
            Cash out is counted once against both the MoMo balance and cash; the
            old Cash paid out input has been retired and is not used.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map((field) => (
              <label key={field.key} className="block text-sm">
                <span className="font-medium text-slate-700">{field.label}</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  className="mt-1 w-full"
                  value={values[field.key]}
                  onChange={(event) => updateField(field.key, event.target.value)}
                  aria-describedby={`${field.key}-original`}
                />
                <span
                  id={`${field.key}-original`}
                  className={`mt-1 block text-xs ${
                    values[field.key] !== data.values[field.key]
                      ? "font-medium text-amber-700"
                      : "text-slate-400"
                  }`}
                >
                  Original: {formatCedi(data.values[field.key])}
                </span>
              </label>
            ))}
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Expenses</h3>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() =>
                  setExpenses((current) => [
                    ...current,
                    { description: "", amount: 0 },
                  ])
                }
              >
                Add expense
              </button>
            </div>
            <div className="space-y-2">
              {expenses.map((expense, index) => (
                <div key={index} className="flex flex-col gap-2 sm:flex-row">
                  <label className="flex-1 text-xs font-medium text-slate-600">
                    Description
                    <input
                      className="mt-1 w-full"
                      value={expense.description}
                      maxLength={200}
                      onChange={(event) =>
                        setExpenses((current) =>
                          current.map((row, rowIndex) =>
                            rowIndex === index
                              ? { ...row, description: event.target.value }
                              : row
                          )
                        )
                      }
                    />
                  </label>
                  <label className="w-full text-xs font-medium text-slate-600 sm:w-40">
                    Amount
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      className="mt-1 w-full"
                      value={expense.amount}
                      onChange={(event) =>
                        setExpenses((current) =>
                          current.map((row, rowIndex) =>
                            rowIndex === index
                              ? { ...row, amount: Number(event.target.value) || 0 }
                              : row
                          )
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm self-end"
                    onClick={() =>
                      setExpenses((current) =>
                        current.filter((_, rowIndex) => rowIndex !== index)
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              {expenses.length === 0 && (
                <p className="text-xs text-slate-500">No expenses recorded.</p>
              )}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Expenses total: {formatCedi(expensesTotal)} · Original:{" "}
              {formatCedi(data.values.totalExpenses)}
            </p>
          </div>
        </section>

        <section className="card bg-white">
          <h2 className="font-semibold text-slate-900">Reconciliation</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">
                MoMo variance
              </p>
              <p className="mt-1 text-lg font-bold tnum text-slate-900">
                {formatCedi(proposed.momoVariance)}
              </p>
              <p className="text-xs text-slate-400">
                Original {formatCedi(data.values.calculatedMomoVariance)}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Cash variance
              </p>
              <p className="mt-1 text-lg font-bold tnum text-slate-900">
                {formatCedi(proposed.cashVariance)}
              </p>
              <p className="text-xs text-slate-400">
                Original {formatCedi(data.values.calculatedCashVariance)}
              </p>
            </div>
          </div>
        </section>

        <section className="card bg-white">
          <label className="block text-sm">
            <span className="font-semibold text-slate-900">
              Correction reason (required)
            </span>
            <span className="mt-1 block text-xs text-slate-500">
              Explain what was wrong and what evidence supports the change. This
              reason is stored with the revision and the audit event.
            </span>
            <textarea
              className="mt-2 w-full"
              rows={3}
              maxLength={500}
              minLength={10}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
            />
          </label>
          <label className="mt-3 flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              I have reviewed the original and proposed values. I understand
              that the current record will be replaced and preserved as an
              immutable revision.
            </span>
          </label>
          {error && (
            <div
              className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800"
              role="alert"
            >
              {error}
            </div>
          )}
          {success && (
            <div
              className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
              role="status"
            >
              <CheckCircle2 size={16} className="mt-0.5" aria-hidden />
              {success}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || !changed}
            >
              {saving && <Loader2 size={14} className="animate-spin" aria-hidden />}
              {saving ? "Saving correction…" : "Save correction"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => router.push("/admin/history")}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        </section>
      </form>

      <aside className="space-y-4" aria-label="Revision history">
        <section className="card bg-white">
          <h2 className="font-semibold text-slate-900">Record</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Business date" value={formatDateTime(data.businessDate)} />
            <Row label="Worker" value={data.worker.fullName} />
            <Row label="Location" value={`${data.location.name} (${data.location.code})`} />
            <Row label="Submitted" value={data.submittedAt ? formatDateTime(data.submittedAt) : "—"} />
            <Row label="Reviewed" value={data.reviewedAt ? formatDateTime(data.reviewedAt) : "—"} />
            <Row label="Last corrected" value={data.correctedAt ? formatDateTime(data.correctedAt) : "—"} />
            {data.correctionReason && (
              <Row label="Last reason" value={data.correctionReason} />
            )}
          </dl>
        </section>

        <section className="card bg-white">
          <h2 className="font-semibold text-slate-900">
            Revision history ({data.revisions.length})
          </h2>
          {data.revisions.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">
              This record has not been corrected. The first correction will
              create revision 1.
            </p>
          ) : (
            <ol className="mt-3 space-y-3">
              {data.revisions.map((revision) => (
                <li
                  key={revision.id}
                  className="rounded-lg border border-slate-200 p-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-800">
                      Revision {revision.version}
                    </span>
                    <span className="text-xs text-slate-400">
                      {formatDateTime(revision.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    By {revision.correctedByName ?? revision.correctedById}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-slate-700">
                    {revision.reason}
                  </p>
                  <p className="mt-2 text-xs text-slate-500">
                    Values replaced: MoMo variance{" "}
                    {formatCedi(revision.snapshot.calculatedMomoVariance)}, cash
                    variance {formatCedi(revision.snapshot.calculatedCashVariance)},
                    expenses {formatCedi(revision.snapshot.totalExpenses)}.
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>

        {data.status === "draft" && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <AlertTriangle size={16} className="mt-0.5" aria-hidden />
            Draft accounts are corrected by the worker on the daily account
            screen, not here.
          </div>
        )}
      </aside>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-800">{value}</dd>
    </div>
  );
}
