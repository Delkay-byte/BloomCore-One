"use client";

import { useEffect, useState } from "react";
import { getCustomerStatement } from "@/lib/actions/susu-customer.actions";
import { formatDateTime } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";

interface StatementEntry {
  date: Date;
  type: "contribution" | "withdrawal" | "commission";
  amount: number;
  balance?: number;
  channel: string;
  receivedBy?: string;
  cycleNumber: number;
  notes?: string;
}

export default function CustomerStatementPage() {
  const [entries, setEntries] = useState<StatementEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadStatement() {
      try {
        const data = await getCustomerStatement();
        setEntries(data as unknown as StatementEntry[]);
      } catch (err) {
        setError("Failed to load statement");
      } finally {
        setLoading(false);
      }
    }
    loadStatement();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="spinner" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-slate-500">{error}</p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="text-center py-20">
        <p className="text-4xl mb-2">📋</p>
        <p className="font-medium text-slate-700">No account history available yet.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">My Account Statement</h1>
        <p className="text-slate-500 mt-1">Chronological transaction history</p>
      </div>

      <div className="card">
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Date & Time</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Balance</th>
                <th>Details</th>
                <th>Cycle</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={`${index}-${entry.date.getTime()}-${entry.type}`}>
                  <td className="text-sm whitespace-nowrap">{formatDateTime(entry.date)}</td>
                  <td>
                    <span className={`badge ${entry.type === "contribution" ? "badge-green" : entry.type === "withdrawal" ? "badge-orange" : "badge-purple"}`}>
                      {entry.type === "contribution" ? "Payment" : entry.type === "withdrawal" ? "Withdrawal" : "Commission"}
                    </span>
                  </td>
                  <td className="font-mono font-semibold text-right">
                    {entry.type === "contribution" ? (
                      <>+<CediAmount amount={entry.amount} /></>
                    ) : (
                      <>-<CediAmount amount={entry.amount} /></>
                    )}
                  </td>
                  <td className="font-mono text-right">
                    {entry.balance !== undefined ? <CediAmount amount={entry.balance} /> : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="text-sm">
                    {entry.type === "contribution" ? (
                      <>
                        {entry.channel === "collector" ? "Paid to Collector" : "Paid at Office"}
                        {entry.receivedBy && <span className="ml-1">({entry.receivedBy})</span>}
                      </>
                    ) : entry.type === "withdrawal" ? (
                      "Withdrawal"
                    ) : (
                      "First withdrawal commission"
                    )}
                  </td>
                  <td className="text-sm text-slate-500">Cycle {entry.cycleNumber}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}