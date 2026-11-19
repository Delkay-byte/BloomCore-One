"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardList, MessageSquareWarning } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import DisputeStatusBadge from "@/components/susu/DisputeStatusBadge";
import { getCustomerDisputes } from "@/lib/actions/customer-dispute.actions";
import type { CustomerDisputeView } from "@/lib/actions/customer-dispute.actions";
import { DISPUTE_CATEGORY_LABELS, type DisputeCategory } from "@/lib/customer-disputes";

function fmt(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function CustomerDisputesPage() {
  const [disputes, setDisputes] = useState<CustomerDisputeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setDisputes(await getCustomerDisputes());
    } catch {
      setError("Your disputes could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">My disputes</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Raise a question about a contribution or withdrawal and follow the
          review. Opening a dispute never changes your balance; any correction is
          made separately and referenced in the outcome.
        </p>
      </div>

      {error && <Notice type="error">{error}</Notice>}

      {loading ? (
        <p className="text-sm text-slate-500">Loading your disputes…</p>
      ) : disputes.length === 0 ? (
        <div className="card py-14 text-center">
          <MessageSquareWarning className="mx-auto mb-2 h-9 w-9 text-brand-300" aria-hidden />
          <p className="font-medium text-slate-700">You have not raised a dispute.</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            Open your statement, find the contribution or withdrawal, and choose
            Dispute if something does not match your record.
          </p>
          <Link href="/customer/statement" className="btn btn-primary mt-4 inline-flex">
            <ClipboardList className="h-4 w-4" aria-hidden /> Open my statement
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {disputes.map((dispute) => (
            <li key={dispute.id}>
              <Link
                href={`/customer/disputes/${dispute.id}`}
                className="card block p-4 transition-shadow hover:shadow-md"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-slate-900">
                      {dispute.subjectType === "contribution" ? "Contribution" : "Withdrawal"}{" "}
                      · <CediAmount amount={dispute.subjectAmount} />
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {dispute.reference} · transaction {dispute.subjectReference}
                    </p>
                  </div>
                  <DisputeStatusBadge status={dispute.status} />
                </div>
                <p className="mt-2 text-sm text-slate-600">
                  {DISPUTE_CATEGORY_LABELS[dispute.category as DisputeCategory] ??
                    dispute.category}
                  {" · "}raised {fmt(dispute.createdAt)}
                </p>
                {dispute.resolutionNote && (
                  <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                    Outcome: {dispute.resolutionNote}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
