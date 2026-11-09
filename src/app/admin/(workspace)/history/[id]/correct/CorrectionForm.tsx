"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import {
  correctDailyAccount,
  type DailyAccountCorrectionView,
} from "@/lib/actions/daily-account.actions";
import {
  calculateReconciliation,
  resolveStoredDifference,
  statusLabel,
} from "@/lib/momo-reconciliation";
import { sumExpenseLines } from "@/lib/expense-lines";
import { formatCedi, formatDateTime } from "@/lib/utils";

type MoneyField =
  | "openingMomoFloat"
  | "openingCash"
  | "commission"
  | "debtsCollected"
  | "closingMomoFloat"
  | "closingCash";

// Approved simplified closing fields. Legacy transaction columns remain on the
// historical row but are not editable here.
const FIELDS: Array<{ key: MoneyField; label: string; hint?: string }> = [
  { key: "openingCash", label: "Start of day — Total Physical Cash" },
  { key: "openingMomoFloat", label: "Start of day — Total E-cash" },
  { key: "closingCash", label: "End of day — Total Physical Cash" },
  { key: "closingMomoFloat", label: "End of day — Total E-cash" },
  { key: "commission", label: "Commission" },
  { key: "debtsCollected", label: "Debts Collected" },
];

function calculate(values: Record<MoneyField, number>, expensesTotal: number) {
  return calculateReconciliation({
    openingMomoFloat: values.openingMomoFloat,
    openingCash: values.openingCash,
    debtsCollected: values.debtsCollected,
    commission: values.commission,
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
    commission: data.values.commission,
    debtsCollected: data.values.debtsCollected,
    closingMomoFloat: data.values.closingMomoFloat,
    closingCash: data.values.closingCash,
  });
  const initialExpenses = useMemo(
    () =>
      data.expenses.length > 0
        ? data.expenses.map((expense) => ({
            description: expense.description,
            amount: Number(expense.amount),
          }))
        : data.values.totalExpenses > 0
          ? [
              {
                description: "Expenses carried from earlier record",
                amount: data.values.totalExpenses,
              },
            ]
          : [],
    [data.expenses, data.values.totalExpenses]
  );
  const [expenses, setExpenses] = useState(initialExpenses);
  // Operational record only. It must never enter the accountability formula.
  const [airtimeSold, setAirtimeSold] = useState(data.values.totalAirtimeSold);
  const [reason, setReason] = useState("");
  const [reconciliationNote, setReconciliationNote] = useState(
    data.reconciliationNote ?? ""
  );
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const initialExpenseJson = useMemo(
    () => JSON.stringify(initialExpenses),
    [initialExpenses]
  );
  // Expenses are always derived from their lines. The total is not editable.
  const expensesTotal = useMemo(
    () => sumExpenseLines(expenses),
    [expenses]
  );
  const proposed = useMemo(
    () => calculate(values, expensesTotal),
    [values, expensesTotal]
  );

  const changed = useMemo(() => {
    return (
      FIELDS.some((field) => values[field.key] !== data.values[field.key]) ||
      airtimeSold !== data.values.totalAirtimeSold ||
      JSON.stringify(expenses) !== initialExpenseJson ||
      reconciliationNote.trim() !== (data.reconciliationNote ?? "").trim()
    );
  }, [
    values,
    airtimeSold,
    expenses,
    initialExpenseJson,
    data.values,
    reconciliationNote,
    data.reconciliationNote,
  ]);

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
    if (proposed.status === "shortage" && reconciliationNote.trim().length === 0) {
      setError(
        "This correction leaves a shortage. Explain the shortage before saving. The figures stay unchanged."
      );
      return;
    }

    setSaving(true);
    try {
      const formData = new FormData();
      for (const field of FIELDS) {
        formData.set(field.key, String(values[field.key]));
      }
      formData.set("totalAirtimeSold", String(airtimeSold));
      formData.set("reconciliationNote", reconciliationNote.trim());
      formData.set(
        "expenses",
        JSON.stringify(
          expenses.map((expense) => ({
            description: expense.description,
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
            Net daily profit / increase = commission + debts collected − expenses.
            Expected closing = opening total + net daily profit / increase. Customer
            deposits, withdrawals and airtime only move money between the two pockets.
            Airtime Sold is recorded for information and never changes the expected
            closing total.
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

          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
            <label className="block text-sm">
              <span className="font-medium text-slate-700">
                Airtime Sold (GH₵) — operational record
              </span>
              <input
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                className="mt-1 w-full"
                value={airtimeSold || ""}
                placeholder="0.00"
                onChange={(event) =>
                  setAirtimeSold(Number.parseFloat(event.target.value) || 0)
                }
                aria-describedby="airtime-sold-hint"
              />
              <span id="airtime-sold-hint" className="mt-1 block text-xs text-slate-600">
                Enter the total value of airtime sold that day. Physical cash rises
                and E-cash falls by the same amount, so the combined closing total
                does not change.
              </span>
              <span className="mt-1 block text-xs text-slate-400">
                Original: {formatCedi(data.values.totalAirtimeSold)}
              </span>
            </label>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Expenses</h3>
                <p className="text-xs text-slate-500">
                  Add each cost. The total is calculated from these lines.
                </p>
              </div>
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
                + Add Expense
              </button>
            </div>
            <div className="space-y-2">
              {expenses.map((expense, index) => (
                <div key={index} className="flex flex-col gap-2 sm:flex-row sm:items-end">
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
                      min="0.01"
                      className="mt-1 w-full"
                      value={expense.amount || ""}
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
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-emerald-50 px-3 py-2.5">
              <span className="text-sm font-bold text-emerald-950">Total Expenses</span>
              <span className="text-base font-bold tnum text-emerald-950">
                {formatCedi(expensesTotal)}
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Original recorded total: {formatCedi(data.values.totalExpenses)}.
              Saving this correction stores the total calculated from the lines above.
            </p>
          </div>
        </section>

        <section className="card bg-white">
          <h2 className="font-semibold text-slate-900">Reconciliation</h2>
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Net daily profit / increase
            </p>
            <p className="mt-1 text-lg font-bold tnum text-slate-900">
              {formatCedi(proposed.netIncrease)}
            </p>
            <p className="text-xs text-slate-500">
              Commission {formatCedi(values.commission)} + debts collected{" "}
              {formatCedi(values.debtsCollected)} − total expenses{" "}
              {formatCedi(expensesTotal)}
            </p>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Expected closing accountability
              </p>
              <p className="mt-1 text-lg font-bold tnum text-slate-900">
                {formatCedi(proposed.expectedClosing)}
              </p>
              <p className="text-xs text-slate-400">
                Opening total {formatCedi(proposed.openingTotal)} + net daily profit /
                increase {formatCedi(proposed.netIncrease)}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Actual closing accountability
              </p>
              <p className="mt-1 text-lg font-bold tnum text-slate-900">
                {formatCedi(proposed.actualClosing)}
              </p>
              <p className="text-xs text-slate-400">
                Closing cash {formatCedi(values.closingCash)} + closing float{" "}
                {formatCedi(values.closingMomoFloat)}
              </p>
            </div>
          </div>
          <div className="mt-3 rounded-lg border border-slate-200 p-3 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-slate-600">Profit retained at closing</span>
              <span className="font-semibold tnum">{formatCedi(proposed.profitRetained)}</span>
            </div>
            <div className="mt-1 flex justify-between gap-3">
              <span className="text-slate-600">Profit withdrawn / not retained</span>
              <span className="font-semibold tnum">{formatCedi(proposed.profitNotRetained)}</span>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Withdrawn profit is not a loss. A shortage is reported only when counted
              money is below the opening capital floor of {formatCedi(proposed.capitalFloor)}.
            </p>
          </div>
          <div
            className={`mt-3 rounded-lg p-3 ${
              proposed.status === "shortage"
                ? "bg-red-50 text-red-800"
                : "bg-emerald-50 text-emerald-800"
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">
                {statusLabel(proposed.status)}
              </span>
              <span className="text-lg font-bold tnum">
                {formatCedi(proposed.difference)}
              </span>
            </div>
            <p className="mt-1 text-xs opacity-80">
              Original recorded difference{" "}
              {formatCedi(resolveStoredDifference(data.values).difference)}
            </p>
          </div>
          <label className="mt-4 block text-sm">
            <span className="font-medium text-slate-700">
              Shortage explanation
              {proposed.status === "shortage" ? " (required)" : " (optional)"}
            </span>
            <textarea
              className="mt-1 w-full"
              rows={2}
              maxLength={500}
              value={reconciliationNote}
              onChange={(event) => setReconciliationNote(event.target.value)}
            />
          </label>
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
                    Values replaced: difference{" "}
                    {formatCedi(revision.snapshot.calculatedDifference ?? 0)}, airtime{" "}
                    {formatCedi(revision.snapshot.totalAirtimeSold ?? 0)}, expenses{" "}
                    {formatCedi(revision.snapshot.totalExpenses)}.
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
