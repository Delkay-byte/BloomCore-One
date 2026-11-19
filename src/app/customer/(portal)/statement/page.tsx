"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardList, Download, RefreshCw } from "lucide-react";
import { SkeletonPage } from "@/components/ui/Skeletons";
import Notice from "@/components/ui/Notice";
import CediAmount from "@/components/CediAmount";
import { getCustomerStatement } from "@/lib/actions/susu-customer.actions";
import type {
  SusuStatement,
  SusuStatementEntry,
  SusuStatementKind,
} from "@/lib/susu-statements";
import { buildCsv } from "@/lib/csv";

const KIND_LABEL: Record<SusuStatementKind, string> = {
  contribution: "Contribution",
  withdrawal: "Withdrawal",
  commission: "Commission",
  card_fee: "Card fee",
};

function fmtDate(value: string): string {
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function channelLabel(entry: SusuStatementEntry): string {
  if (entry.kind === "contribution") {
    const base = entry.channel === "collector" ? "Paid to collector" : "Paid at office";
    return entry.receivedBy ? `${base} (${entry.receivedBy})` : base;
  }
  if (entry.kind === "withdrawal") return "Withdrawal paid to customer";
  if (entry.kind === "commission") return "First-withdrawal commission";
  return "Susu card fee";
}

export default function CustomerStatementPage() {
  const [statement, setStatement] = useState<SusuStatement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [applied, setApplied] = useState({ from: "", to: "" });

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await getCustomerStatement({
        from: applied.from || undefined,
        to: applied.to || undefined,
      });
      setStatement(result.statement);
    } catch {
      setError("Your statement could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [applied]);

  useEffect(() => {
    void load();
  }, [load]);

  function exportCsv() {
    if (!statement || statement.entries.length === 0) return;
    const headers = [
      "Date",
      "Type",
      "Amount",
      "Balance",
      "Account",
      "Cycle",
      "Details",
      "Receipt number",
      "Status",
    ];
    const rows = statement.entries.map((entry) => [
      fmtDate(entry.occurredAt),
      entry.isReversal ? `${KIND_LABEL[entry.kind]} reversal` : KIND_LABEL[entry.kind],
      entry.amount.toFixed(2),
      entry.balance.toFixed(2),
      entry.accountNumber ?? "",
      entry.cycleNumber === null ? "" : String(entry.cycleNumber),
      channelLabel(entry),
      entry.reference ?? "",
      entry.status,
    ]);
    const csv = buildCsv([headers, ...rows]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `maacash-statement-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (loading && !statement) return <SkeletonPage variant="table" />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">My account statement</h1>
          <p className="mt-1 text-sm text-slate-600">
            Every contribution, withdrawal, commission and card fee in date order,
            with the balance after each entry.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void load()} className="btn btn-secondary">
            <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
          </button>
          <button
            type="button"
            onClick={exportCsv}
            className="btn btn-secondary"
            disabled={!statement || statement.entries.length === 0}
          >
            <Download className="h-4 w-4" aria-hidden /> Download CSV
          </button>
        </div>
      </div>

      {error && <Notice type="error">{error}</Notice>}

      <section className="card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium text-slate-600">
            From
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="input mt-1 block"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            To
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="input mt-1 block"
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setApplied({ from, to })}
          >
            Apply dates
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setFrom("");
              setTo("");
              setApplied({ from: "", to: "" });
            }}
          >
            Clear
          </button>
          <p className="text-xs text-slate-500">
            Dates are inclusive. The opening balance is the position before the
            first selected date.
          </p>
        </div>
      </section>

      {statement && (
        <>
          <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryCard label="Opening balance" amount={statement.summary.openingBalance} />
            <SummaryCard
              label="Money in"
              amount={statement.summary.credits}
              tone="text-emerald-700"
            />
            <SummaryCard
              label="Money out"
              amount={statement.summary.debits}
              tone="text-red-700"
            />
            <SummaryCard label="Closing balance" amount={statement.summary.closingBalance} />
          </section>

          <p className="text-xs text-slate-500">
            {statement.summary.from || statement.summary.to
              ? `Showing ${statement.summary.entryCount} entries for the selected dates.`
              : `Showing all ${statement.summary.entryCount} entries.`}{" "}
            Contributions{" "}
            <CediAmount amount={statement.summary.contributionTotal} /> · withdrawals{" "}
            <CediAmount amount={statement.summary.withdrawalTotal} /> · commission{" "}
            <CediAmount amount={statement.summary.commissionTotal} /> · card fees{" "}
            <CediAmount amount={statement.summary.cardFeeTotal} />.
          </p>

          {statement.entries.length === 0 ? (
            <div className="card py-14 text-center">
              <ClipboardList
                className="mx-auto mb-2 h-9 w-9 text-brand-300"
                aria-hidden
              />
              <p className="font-medium text-slate-700">No transactions in this period.</p>
              <p className="mt-1 text-sm text-slate-500">
                Clear the dates to see your full history.
              </p>
            </div>
          ) : (
            <section className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    Customer statement with signed amount, running balance and receipt
                    reference
                  </caption>
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2 text-right">Balance</th>
                      <th className="px-3 py-2">Account / cycle</th>
                      <th className="px-3 py-2">Details</th>
                      <th className="px-3 py-2">Receipt</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {statement.entries.map((entry) => (
                      <tr key={`${entry.kind}-${entry.id}`} className="hover:bg-slate-50">
                        <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                          {fmtDate(entry.occurredAt)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`badge ${
                              entry.isReversal
                                ? "badge-yellow"
                                : entry.kind === "contribution"
                                  ? "badge-green"
                                  : entry.kind === "withdrawal"
                                    ? "badge-orange"
                                    : "badge-gray"
                            }`}
                          >
                            {entry.isReversal ? "Reversal" : KIND_LABEL[entry.kind]}
                          </span>
                          {entry.status === "reversed" && (
                            <span className="ml-1 text-[11px] text-amber-700">reversed</span>
                          )}
                        </td>
                        <td
                          className={`whitespace-nowrap px-3 py-2 text-right font-semibold tnum ${
                            entry.amount < 0 ? "text-red-700" : "text-emerald-700"
                          }`}
                        >
                          <CediAmount amount={entry.amount} showSign />
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right tnum text-slate-800">
                          <CediAmount amount={entry.balance} />
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-600">
                          {entry.accountNumber ?? "—"}
                          {entry.cycleNumber !== null && (
                            <span className="block text-slate-400">
                              Cycle {entry.cycleNumber}
                            </span>
                          )}
                        </td>
                        <td className="max-w-[18rem] px-3 py-2 text-xs text-slate-600">
                          <span className="block">{channelLabel(entry)}</span>
                          {entry.notes && (
                            <span className="mt-0.5 block break-words text-slate-500">
                              {entry.notes}
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {entry.receiptAvailable && entry.reference ? (
                            <span className="flex flex-col gap-1">
                              <Link
                                href={`/customer/receipt/${encodeURIComponent(entry.reference)}`}
                                className="text-xs font-semibold text-brand-700 hover:underline"
                              >
                                View receipt
                              </Link>
                              <Link
                                href={`/customer/disputes/new?type=${
                                  entry.kind === "withdrawal" ? "withdrawal" : "contribution"
                                }&id=${encodeURIComponent(entry.id)}`}
                                className="text-[11px] font-semibold text-amber-800 hover:underline"
                              >
                                Dispute
                              </Link>
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <p className="text-xs text-slate-500">
            A reversal appears as its own line so the original transaction and the
            correction both stay visible.
          </p>
        </>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  amount,
  tone = "text-slate-900",
}: {
  label: string;
  amount: number;
  tone?: string;
}) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-bold tnum ${tone}`}>
        <CediAmount amount={amount} />
      </p>
    </div>
  );
}
