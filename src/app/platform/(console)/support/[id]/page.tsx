import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePlatformPage } from "@/lib/platform-auth";
import {
  getSupportRequestAgentView,
  listSupportAgents,
} from "@/lib/actions/platform-support.actions";
import {
  supportCategoryLabel,
  supportPriorityLabel,
  supportStatusLabel,
} from "@/lib/support";
import SupportWorkspace from "../_components/SupportWorkspace";

export const dynamic = "force-dynamic";

export default async function PlatformSupportRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePlatformPage();
  const { id } = await params;
  const [request, agents] = await Promise.all([getSupportRequestAgentView(id), listSupportAgents()]);
  if (!request) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link href="/platform/support" className="text-xs text-slate-500 hover:text-slate-700">
          ← Support queue
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-slate-900">{request.subject}</h1>
          <span className="badge badge-blue">{supportStatusLabel(request.status)}</span>
          {request.escalationLevel > 0 && (
            <span className="badge badge-red">Escalated ×{request.escalationLevel}</span>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-500">
          <span className="font-mono">{request.reference}</span> ·{" "}
          {supportCategoryLabel(request.category)} · {supportPriorityLabel(request.priority)} priority ·{" "}
          {request.tenantName} ({request.tenantCode}) · {request.branchName}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Opened {new Date(request.createdAt).toLocaleString()} · last activity{" "}
          {new Date(request.lastActivityAt).toLocaleString()} · {request.reopenedCount} reopen(s)
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card space-y-2 bg-white lg:col-span-2">
          <h2 className="font-semibold text-slate-900">The request</h2>
          <p className="whitespace-pre-wrap text-sm text-slate-700">{request.description}</p>
        </div>
        <div className="card space-y-1 bg-white text-sm">
          <h2 className="font-semibold text-slate-900">Submitted by</h2>
          {request.submittedBy ? (
            <>
              <p className="text-slate-900">{request.submittedBy.fullName}</p>
              <p className="text-slate-500">{request.submittedBy.email}</p>
              {request.submittedBy.phone && <p className="text-slate-500">{request.submittedBy.phone}</p>}
              <p className="text-slate-500">
                {request.submittedBy.role} · {request.submittedBy.status}
              </p>
            </>
          ) : (
            <p className="text-slate-500">The account no longer exists.</p>
          )}
          <p className="pt-2 text-xs text-slate-500">
            Business status: {request.tenantStatus || "unknown"} · assigned to{" "}
            {request.assignedAgentName}
          </p>
        </div>
      </div>

      {request.resolutionNote && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Resolution</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{request.resolutionNote}</p>
          {request.resolvedAt && (
            <p className="mt-1 text-xs text-slate-500">
              Resolved {new Date(request.resolvedAt).toLocaleString()}
            </p>
          )}
        </div>
      )}

      <SupportWorkspace
        requestId={request.id}
        status={request.status}
        agents={agents}
        assignedAgentId={request.assignedAgentId}
      />

      <div className="space-y-3">
        <h2 className="text-base font-semibold text-slate-900">Conversation</h2>
        <ol className="space-y-3">
          {request.messages.map((message) => (
            <li
              key={message.id}
              className={
                message.visibility === "internal"
                  ? "card border-amber-200 bg-amber-50"
                  : "card bg-white"
              }
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-900">
                  {message.authorName}
                  {message.visibility === "internal" && (
                    <span className="ml-2 badge badge-yellow">Internal note</span>
                  )}
                </p>
                <p className="text-xs text-slate-500">{new Date(message.createdAt).toLocaleString()}</p>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{message.body}</p>
            </li>
          ))}
        </ol>
      </div>

      <details className="card bg-white">
        <summary className="cursor-pointer text-sm font-medium text-slate-900">Audit trail</summary>
        <ol className="mt-3 space-y-2 text-sm text-slate-600">
          {request.events.map((event) => (
            <li key={event.id}>
              <span className="font-medium text-slate-800">{event.type}</span>
              {event.toStatus ? " → " + supportStatusLabel(event.toStatus) : ""} · {event.actorName} ·{" "}
              {new Date(event.createdAt).toLocaleString()}
              {event.reason ? <p className="mt-0.5 text-xs text-slate-500">Reason: {event.reason}</p> : null}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
