"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import Notice from "@/components/ui/Notice";
import { getCustomerStatement } from "@/lib/actions/susu-customer.actions";
import { getCustomerProfile } from "@/lib/actions/susu-customer.actions";
import type { SusuStatement, SusuStatementKind } from "@/lib/susu-statements";

const KIND_LABEL: Record<SusuStatementKind, string> = {
  contribution: "Contribution",
  withdrawal: "Withdrawal",
  commission: "Commission",
  card_fee: "Card fee",
};

function money(value: number): string {
  return new Intl.NumberFormat("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function fmtDate(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Printable statement.
 *
 * The same ledger the on-screen statement shows, laid out as a document someone
 * can print or save as a PDF from the browser. No new source of truth: it calls
 * the same customer-scoped statement action, so it cannot show another
 * customer's entries. A print stylesheet removes the application chrome.
 */
export default function PrintableStatementPage() {
  const [statement, setStatement] = useState<SusuStatement | null>(null);
  const [profile, setProfile] = useState<{ fullName: string; customerId: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [printedAt] = useState(() => new Date());

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [result, profileResult] = await Promise.all([
          getCustomerStatement(),
          getCustomerProfile(),
        ]);
        if (!active) return;
        setStatement(result.statement);
        const row = profileResult as unknown as { fullName?: string; customerId?: string } | null;
        setProfile(
          row?.fullName && row?.customerId
            ? { fullName: row.fullName, customerId: row.customerId }
            : null
        );
      } catch {
        if (active) setError("The statement could not be prepared.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return <p className="p-6 text-sm text-slate-500">Preparing your statement…</p>;
  }
  if (error || !statement) {
    return (
      <div className="p-6">
        <Notice type="error">{error || "No statement is available yet."}</Notice>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href="/customer/statement" className="btn btn-secondary btn-sm">
          <ArrowLeft size={14} aria-hidden /> Back to statement
        </Link>
        <button type="button" onClick={() => window.print()} className="btn btn-primary btn-sm">
          <Printer size={14} aria-hidden /> Print or save as PDF
        </button>
      </div>

      <header className="border-b border-slate-300 pb-3">
        <h1 className="text-xl font-semibold text-slate-900">Savings statement</h1>
        <p className="mt-1 text-sm text-slate-700">
          {profile?.fullName ?? "Customer"} · {profile?.customerId ?? ""}
        </p>
        <p className="text-xs text-slate-500">
          Prepared {printedAt.toLocaleString("en-GB")} · {statement.entries.length} entries ·
          Closing balance GH₵ {money(statement.summary.closingBalance)}
        </p>
      </header>

      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-slate-300 text-slate-600">
            <th className="py-1 pr-2">Date</th>
            <th className="py-1 pr-2">Type</th>
            <th className="py-1 pr-2">Account</th>
            <th className="py-1 pr-2 text-right">Amount</th>
            <th className="py-1 pr-2 text-right">Balance</th>
            <th className="py-1">Reference</th>
          </tr>
        </thead>
        <tbody>
          {statement.entries.map((entry) => (
            <tr key={entry.id} className="border-b border-slate-100">
              <td className="py-1 pr-2">{fmtDate(entry.occurredAt)}</td>
              <td className="py-1 pr-2">
                {entry.isReversal ? `${KIND_LABEL[entry.kind]} reversal` : KIND_LABEL[entry.kind]}
              </td>
              <td className="py-1 pr-2">{entry.accountNumber ?? "—"}</td>
              <td className="py-1 pr-2 text-right font-mono">{money(entry.amount)}</td>
              <td className="py-1 pr-2 text-right font-mono">{money(entry.balance)}</td>
              <td className="py-1 font-mono">{entry.reference ?? "—"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} className="pt-2 text-right font-medium">
              Closing balance
            </td>
            <td />
            <td className="pt-2 text-right font-mono font-semibold">
              {money(statement.summary.closingBalance)}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>

      <footer className="border-t border-slate-300 pt-2 text-[11px] text-slate-500">
        <p>
          This statement lists contributions, withdrawals, commissions and card fees recorded
          in MaaCash for this account. It is not a bank statement.
        </p>
        <p className="mt-1">
          Dispute anything that looks wrong from Customer → Disputes within 30 days.
        </p>
      </footer>
    </div>
  );
}
