import Link from "next/link";
import { requireSupportIdentity } from "@/lib/support-access";
import { getBranchesForScope } from "@/lib/actions/branch.actions";
import { getSupportCounts, listSupportRequests } from "@/lib/actions/susu-support.actions";
import {
  SUPPORT_CATEGORIES,
  SUPPORT_PRIORITIES,
  supportAgeLabel,
  supportCategoryLabel,
  supportPriorityLabel,
  supportStatusLabel,
} from "@/lib/support";
import SupportRequestForm from "./_components/SupportRequestForm";

export const metadata = { title: "Support — MaaCash" };
export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  open: "badge badge-blue",
  acknowledged: "badge badge-brand",
  in_progress: "badge badge-brand",
  escalated: "badge badge-yellow",
  resolved: "badge badge-green",
  closed: "badge badge-gray",
};

export default async function SusuSupportPage() {
  const ctx = await requireSupportIdentity();
  const [rows, counts] = await Promise.all([listSupportRequests(), getSupportCounts()]);
  const isAdmin = ctx.role === "admin";
  const branches = isAdmin
    ? (await getBranchesForScope()).map((branch) => ({ id: branch.id, name: branch.name }))
    : [];
  const open = counts.open + counts.acknowledged + counts.in_progress + counts.escalated;

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-brand-900">Support</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-muted">
          Ask MaaCash support about Susu operations, reconciliation, staff access or an
          unexpected result. Every request is tied to this business
          {isAdmin ? " and to the branch scope of your account" : ""}.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Open</p>
          <p className="mt-1 text-2xl font-semibold text-brand-900">{open}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Resolved</p>
          <p className="mt-1 text-2xl font-semibold text-brand-900">{counts.resolved}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Closed</p>
          <p className="mt-1 text-2xl font-semibold text-brand-900">{counts.closed}</p>
        </div>
      </div>

      <SupportRequestForm
        categories={SUPPORT_CATEGORIES.map((value) => ({ value, label: supportCategoryLabel(value) }))}
        priorities={SUPPORT_PRIORITIES.map((value) => ({ value, label: supportPriorityLabel(value) }))}
        branches={branches}
      />

      <div className="overflow-x-auto rounded-control border border-line bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-brand-50 text-ink">
            <tr>
              <th className="p-3">Reference</th>
              <th className="p-3">Request</th>
              <th className="p-3">Status</th>
              <th className="p-3">Priority</th>
              <th className="p-3">Branch</th>
              <th className="p-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-6 text-center text-sm text-ink-muted">
                  No support requests yet.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="border-t border-line align-top">
                  <td className="p-3 font-mono text-xs">{row.reference}</td>
                  <td className="p-3">
                    <Link href={"/susu/support/" + row.id} className="font-medium text-brand-700 hover:underline">
                      {row.subject}
                    </Link>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {supportCategoryLabel(row.category)} · opened by {row.submittedByName}
                      {row.reopenedCount > 0 ? " · reopened " + row.reopenedCount + "×" : ""}
                    </p>
                  </td>
                  <td className="p-3">
                    <span className={STATUS_STYLES[row.status] ?? "badge badge-gray"}>
                      {supportStatusLabel(row.status)}
                    </span>
                  </td>
                  <td className="p-3">{supportPriorityLabel(row.priority)}</td>
                  <td className="p-3">{row.branchName}</td>
                  <td className="p-3 text-xs text-ink-muted">
                    {supportAgeLabel(new Date(row.lastActivityAt))}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="card space-y-2 text-sm text-ink-muted">
        <h2 className="text-base font-semibold text-brand-900">How support works</h2>
        <p>
          Support acknowledges new requests during business hours and replies inside the
          request so the whole conversation stays with the business record. Escalations are
          tracked; a request is only closed after support records the resolution.
        </p>
        <p>
          Never send passwords, PINs, API keys, full card numbers or another person&apos;s data.
          Support will never ask you to approve a payment or to read a one-time code.
        </p>
        <p>
          Resolved and closed requests stay readable here. An administrator can reopen a
          request that needs more work; history is kept.
        </p>
        <p className="text-xs">
          Request references look like SUP-2027-ABC123; quote one when you call.
        </p>
      </div>
    </section>
  );
}