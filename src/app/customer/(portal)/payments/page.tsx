"use client";

import { useEffect, useState } from "react";
import { getCustomerPayments } from "@/lib/actions/susu-customer.actions";
import { formatDate } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";

interface Payment {
  id: string;
  amount: number;
  collectionDate: Date;
  channel: string;
  collector?: { user: { fullName: string } } | null;
  receivedBy?: { fullName: string } | null;
  allocations: Array<{ cycleDay: number }>;
  cycleNumber: number;
}

export default function CustomerPaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadPayments() {
      try {
        const data = await getCustomerPayments();
        setPayments(data as unknown as Payment[]);
      } catch (err) {
        setError("Failed to load payments");
      } finally {
        setLoading(false);
      }
    }
    loadPayments();
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

  if (payments.length === 0) {
    return (
      <div className="text-center py-20">
        <p className="text-4xl mb-2">💵</p>
        <p className="font-medium text-slate-700">No customer payments recorded yet.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">My Payments</h1>
        <p className="text-slate-500 mt-1">All your Susu contributions</p>
      </div>

      <div className="card">
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Amount</th>
                <th>Days Covered</th>
                <th>How Payment Was Made</th>
                <th>Who Handled It</th>
                <th>Cycle</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="text-sm">{formatDate(p.collectionDate)}</td>
                  <td className="font-mono font-semibold text-green-700"><CediAmount amount={p.amount} /></td>
                  <td>
                    <span className="badge badge-blue">
                      {p.allocations?.length || Math.floor(p.amount / (p.amount > 0 ? 50 : 1))} day(s)
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${p.channel === "collector" ? "badge-yellow" : "badge-green"}`}>
                      {p.channel === "collector" ? "Paid to Collector" : "Paid at Office"}
                    </span>
                  </td>
                  <td className="text-sm">
                    {p.channel === "collector"
                      ? `Collected by ${p.collector?.user?.fullName || "—"}`
                      : `Received by ${(p as { receivedByName?: string | null }).receivedByName || p.receivedBy?.fullName || "—"}`}
                  </td>
                  <td className="text-sm text-slate-500">Cycle {p.cycleNumber}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}