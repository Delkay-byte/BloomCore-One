"use client";
import { SkeletonPage } from "@/components/ui/Skeletons";

import { useEffect, useState } from "react";
import { getCustomerWithdrawals } from "@/lib/actions/susu-customer.actions";
import { formatDateTime } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";

interface Withdrawal {
  id: string;
  requestedAmount: number;
  commissionAmount: number;
  netAmount: number;
  remainingBalance: number;
  createdAt: Date;
  notes?: string | null;
  cycleNumber: number;
}

export default function CustomerWithdrawalsPage() {
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadWithdrawals() {
      try {
        const data = await getCustomerWithdrawals();
        setWithdrawals(data as unknown as Withdrawal[]);
      } catch (err) {
        setError("Failed to load withdrawals");
      } finally {
        setLoading(false);
      }
    }
    loadWithdrawals();
  }, []);

  if (loading) return <SkeletonPage variant="table" />;

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-slate-500">{error}</p>
      </div>
    );
  }

  if (withdrawals.length === 0) {
    return (
      <div className="text-center py-20">
        <p className="text-4xl mb-2">🏧</p>
        <p className="font-medium text-slate-700">No withdrawals recorded.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">My Withdrawals</h1>
        <p className="text-slate-500 mt-1">All your Susu withdrawals</p>
      </div>

      <div className="card">
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Amount Requested</th>
                <th>Commission</th>
                <th>Amount Paid</th>
                <th>Balance After</th>
                <th>Cycle</th>
              </tr>
            </thead>
            <tbody>
              {withdrawals.map((w) => (
                <tr key={w.id}>
                  <td className="text-sm">{formatDateTime(w.createdAt)}</td>
                  <td className="font-mono"><CediAmount amount={w.requestedAmount} /></td>
                  <td className="font-mono text-purple-600">
                    {w.commissionAmount > 0 ? (
                      <>
                        <CediAmount amount={w.commissionAmount} />
                        {w.commissionAmount > 0 && <span className="text-xs ml-1">(First withdrawal)</span>}
                      </>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="font-mono font-semibold text-orange-700"><CediAmount amount={w.netAmount} /></td>
                  <td className="font-mono"><CediAmount amount={w.remainingBalance} /></td>
                  <td className="text-sm text-slate-500">Cycle {w.cycleNumber}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}