import Link from "next/link";
import { requirePlatformPage } from "@/lib/platform-auth";
import {
  getSupportOperationsSummary,
  listSupportQueue,
} from "@/lib/actions/platform-support.actions";
import {
  SUPPORT_CATEGORIES,
  SUPPORT_PRIORITIES,
  SUPPORT_STATUSES,
  supportCategoryLabel,
  supportPriorityLabel,
  supportStatusLabel,
} from "@/lib/support";
import SupportQueueTools from "./_components/SupportQueueTools";

export const metadata = { title: "Support queue — MaaCash Platform" };
export const dynamic = "force-dynamic";

interface SearchParams {
  status?: string;
  priority?: string;
  category?: string;
  assignment?: string;
  search?: string;
}

function statusClass(status: string): string {
  if (status === "escalated") return "badge badge-red";
  if (status === "resolved") return "badge badge-green";
  if (status === "closed") return "badge badge-gray";
  if (status === "in_progress" || status === "acknowledged") return "badge badge-blue";
  return "badge badge-yellow";
}

export default async function PlatformSupportPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePlatformPage();
  const sp = await searchParams;
  const assignment: "all" | "mine" | "unassigned" =
    sp.assignment === "mine" || sp.assignment === "unassigned" ? sp.assignment : "all";
  const filters = {
    status: sp.status,
    priority: sp.priority,
    category: sp.category,
    assignment,
    search: sp.search,
  };
  const [summary, rows] = await Promise.all([
    getSupportOperationsSummary(),
    listSupportQueue(filters),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Support queue</h1>
          <p className="mt-1 text-sm text-slate-500">
            Tenant support requests. Every action here is recorded in the platform activity history
            against the request reference; internal notes never reach the business.
          </p>
        </div>
        <SupportQueueTools
          status={sp.status}
          priority={sp.priority}
          assignment={assignment}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Open", value: summary.open, tone: "text-slate-900" },
          { label: "Unassigned", value: summary.unassigned, tone: "text-amber-700" },
          { label: "Escalated", value: summary.escalated, tone: "text-red-700" },
          { label: "Urgent open", value: summary.urgent, tone: "text-red-700" },
          { label: "Older than 48h", value: summary.olderThan48h, tone: "text-amber-700" },
          { label: "Awaiting first response", value: summary.awaitingFirstResponse, tone: "text-slate-900" },
          { label: "Resolved in 7 days", value: summary.resolvedLast7Days, tone: "text-emerald-700" },
          { label: "Businesses with open requests", value: summary.tenantsWithOpenRequests, tone: "text-slate-900" },
        ].map((card) => (
          <div key={card.label} className="card bg-white">
            <p className="text-xs uppercase tracking-wide text-slate-400">{card.label}</p>
            <p className={"mt-1 text-2xl font-semibold " + card.tone}>{card.value}</p>
          </div>
        ))}
      </div>

      <form method="get" className="card bg-white">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-sm">
            <span className="mb-1 block font-medium text-slate-700">Status</span>
            <select name="status" defaultValue={sp.status ?? ""} className="w-full">
              <option value="">All</option>
              {SUPPORT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {supportStatusLabel(status)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-slate-700">Priority</span>
            <select name="priority" defaultValue={sp.priority ?? ""} className="w-full">
              <option value="">All</option>
              {SUPPORT_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {supportPriorityLabel(priority)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-slate-700">Category</span>
            <select name="category" defaultValue={sp.category ?? ""} className="w-full">
              <option value="">All</option>
              {SUPPORT_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {supportCategoryLabel(category)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-slate-700">Assignment</span>
            <select name="assignment" defaultValue={assignment} className="w-full">
              <option value="all">Everyone</option>
              <option value="mine">Assigned to me</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-slate-700">Search</span>
            <input type="text" name="search" defaultValue={sp.search ?? ""} className="w-full" placeholder="Reference or subject" />
          </label>
        </div>
        <div className="mt-3 flex gap-2">
          <button type="submit" className="btn btn-secondary btn-sm">
            Apply filters
          </button>
          <Link href="/platform/support" className="btn btn-ghost btn-sm">
            Clear
          </Link>
        </div>
      </form>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="p-3">Request</th>
              <th className="p-3">Business</th>
              <th className="p-3">Status</th>
              <th className="p-3">Priority</th>
              <th className="p-3">Assigned</th>
              <th className="p-3">Age</th>
              <th className="p-3">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-6 text-center text-sm text-slate-500">
                  No requests match these filters.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="border-t border-slate-100 align-top">
                  <td className="p-3">
                    <Link href={"/platform/support/" + row.id} className="font-medium text-brand-700 hover:underline">
                      {row.subject}
                    </Link>
                    <p className="mt-0.5 font-mono text-xs text-slate-500">{row.reference}</p>
                    <p className="text-xs text-slate-500">
                      {supportCategoryLabel(row.category)} · {row.branchName}
                    </p>
                  </td>
                  <td className="p-3">{row.tenantName}</td>
                  <td className="p-3">
                    <span className={statusClass(row.status)}>{supportStatusLabel(row.status)}</span>
                  </td>
                  <td className="p-3">{supportPriorityLabel(row.priority)}</td>
                  <td className="p-3">{row.assignedAgentName}</td>
                  <td className="p-3 text-xs text-slate-500">{row.ageHours}h</td>
                  <td className="p-3 text-xs text-slate-500">{row.internalNoteCount}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
