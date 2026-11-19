"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { MessageSquareWarning, RefreshCw } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import DisputeStatusBadge from "@/components/susu/DisputeStatusBadge";
import { StatCard } from "@/components/ui/DataDisplay";
import {
  getAdminDisputes,
  type AdminDisputeBoard,
} from "@/lib/actions/customer-dispute.actions";
import {
  DISPUTE_CATEGORIES,
  DISPUTE_CATEGORY_LABELS,
  type DisputeCategory,
} from "@/lib/customer-disputes";

function fmt(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function AdminDisputesPage() {
  const [board, setBoard] = useState<AdminDisputeBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({ status: "all", category: "all" });

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setBoard(await getAdminDisputes(filters));
    } catch {
      setError("The dispute register could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Customer disputes</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Review a customer&apos;s question about one recorded contribution or
            withdrawal. Resolving a dispute records an outcome only; any money
            correction stays in the existing correction/reversal control.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="btn btn-secondary">
          <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
        </button>
      </div>

      {error && <Notice type="error">{error}</Notice>}

      {loading && !board ? (
        <p className="text-sm text-slate-500">Loading disputes…</p>
      ) : board ? (
        <>
          <section className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Open" value={board.counts.open} tone="warning" />
            <StatCard label="In review" value={board.counts.underReview} />
            <StatCard
              label="Awaiting customer"
              value={board.counts.awaitingCustomer}
              tone="warning"
            />
            <StatCard
              label="Upheld"
              value={board.counts.resolvedUpheld}
              tone="positive"
            />
            <StatCard label="Records confirmed" value={board.counts.resolvedDeclined} />
            <StatCard label="Cancelled" value={board.counts.cancelled} />
          </section>

          <section className="card p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-slate-600">
                Status
                <select
                  value={filters.status}
                  onChange={(event) =>
                    setFilters((current) => ({ ...current, status: event.target.value }))
                  }
                  className="input mt-1 w-full"
                >
                  <option value="all">All statuses</option>
                  <option value="open">Open</option>
                  <option value="under_review">Under review</option>
                  <option value="awaiting_customer">Awaiting customer</option>
                  <option value="resolved_upheld">Resolved — upheld</option>
                  <option value="resolved_declined">Resolved — declined</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </label>
              <label className="text-xs font-medium text-slate-600">
                Category
                <select
                  value={filters.category}
                  onChange={(event) =>
                    setFilters((current) => ({ ...current, category: event.target.value }))
                  }
                  className="input mt-1 w-full"
                >
                  <option value="all">All categories</option>
                  {DISPUTE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {DISPUTE_CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          {board.disputes.length === 0 ? (
            <div className="card py-14 text-center">
              <MessageSquareWarning
                className="mx-auto mb-2 h-9 w-9 text-brand-300"
                aria-hidden
              />
              <p className="font-medium text-slate-700">
                No disputes match these filters.
              </p>
              <p className="mt-1 text-sm text-slate-500">
                Customer-raised disputes appear here as soon as they are submitted.
              </p>
            </div>
          ) : (
            <section className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-2">Reference</th>
                      <th className="px-4 py-2">Customer</th>
                      <th className="px-4 py-2">Record disputed</th>
                      <th className="px-4 py-2 text-right">Amount</th>
                      <th className="px-4 py-2">Category</th>
                      <th className="px-4 py-2">Status</th>
                      <th className="px-4 py-2">Raised</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {board.disputes.map((dispute) => (
                      <tr key={dispute.id} className="hover:bg-slate-50">
                        <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-800">
                          {dispute.reference}
                        </td>
                        <td className="px-4 py-2 text-slate-700">
                          {dispute.customerName ?? "Customer"}
                          <span className="block text-[11px] text-slate-400">
                            {dispute.customerNumber}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-slate-600">
                          {dispute.subjectType === "contribution"
                            ? "Contribution"
                            : "Withdrawal"}
                          <span className="block font-mono text-[11px] text-slate-400">
                            {dispute.subjectReference}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right tnum">
                          <CediAmount amount={dispute.subjectAmount} />
                        </td>
                        <td className="px-4 py-2 text-slate-600">
                          {DISPUTE_CATEGORY_LABELS[dispute.category as DisputeCategory] ??
                            dispute.category}
                        </td>
                        <td className="px-4 py-2">
                          <DisputeStatusBadge status={dispute.status} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-slate-500">
                          {fmt(dispute.createdAt)}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Link
                            href={`/susu/admin/disputes/${dispute.id}`}
                            className="text-xs font-semibold text-brand-700 hover:underline"
                          >
                            Review
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}
