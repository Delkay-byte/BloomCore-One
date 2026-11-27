import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSupportIdentity } from "@/lib/support-access";
import { getSupportRequestDetail } from "@/lib/actions/susu-support.actions";
import {
  supportCategoryLabel,
  supportPriorityLabel,
  supportStatusLabel,
} from "@/lib/support";
import SupportThread from "./_components/SupportThread";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  open: "badge badge-blue",
  acknowledged: "badge badge-brand",
  in_progress: "badge badge-brand",
  escalated: "badge badge-yellow",
  resolved: "badge badge-green",
  closed: "badge badge-gray",
};

export default async function SusuSupportRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await requireSupportIdentity();
  const { id } = await params;
  const request = await getSupportRequestDetail(id);
  if (!request) notFound();

  return (
    <section className="space-y-6">
      <div>
        <Link href="/susu/support" className="text-xs text-brand-700 hover:underline">
          ← All support requests
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold text-brand-900">{request.subject}</h1>
          <span className={STATUS_STYLES[request.status] ?? "badge badge-gray"}>
            {supportStatusLabel(request.status)}
          </span>
        </div>
        <p className="mt-1 text-sm text-ink-muted">
          <span className="font-mono">{request.reference}</span> ·
          {" "}{supportCategoryLabel(request.category)} · {supportPriorityLabel(request.priority)} priority ·
          {" "}{request.branchName} · opened by {request.submittedByName}
        </p>
      </div>

      <article className="card space-y-2">
        <p className="whitespace-pre-wrap text-sm text-ink">{request.description}</p>
        <p className="text-xs text-ink-muted">
          Opened {new Date(request.createdAt).toLocaleString()} · last activity{" "}
          {new Date(request.lastActivityAt).toLocaleString()}
        </p>
      </article>

      {request.resolutionNote && (
        <div className="rounded-control border border-brand-200 bg-brand-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
            Resolution
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{request.resolutionNote}</p>
          {request.resolvedAt && (
            <p className="mt-1 text-xs text-ink-muted">
              Resolved {new Date(request.resolvedAt).toLocaleString()}
            </p>
          )}
        </div>
      )}

      <div className="space-y-3">
        <h2 className="text-base font-semibold text-brand-900">Conversation</h2>
        {request.messages.length === 0 ? (
          <p className="card text-sm text-ink-muted">
            Support has not replied yet. Your request is in the queue.
          </p>
        ) : (
          <ol className="space-y-3">
            {request.messages.map((message) => (
              <li key={message.id} className="card">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-ink">{message.authorName}</p>
                  <p className="text-xs text-ink-muted">
                    {new Date(message.createdAt).toLocaleString()}
                  </p>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{message.body}</p>
              </li>
            ))}
          </ol>
        )}
      </div>

      <SupportThread requestId={request.id} status={request.status} isAdmin={ctx.role === "admin"} />

      <details className="card">
        <summary className="cursor-pointer text-sm font-medium text-brand-900">
          Request history
        </summary>
        <ol className="mt-3 space-y-2 text-sm text-ink-muted">
          {request.events.map((event) => (
            <li key={event.id}>
              <span className="text-ink">
                {event.type === "created"
                  ? "Request opened"
                  : event.type === "reopened"
                    ? "Request reopened"
                    : event.type === "replied"
                      ? "Message added"
                      : "Status changed"}
              </span>
              {event.toStatus ? " → " + supportStatusLabel(event.toStatus) : ""}
              {" · "}{event.actorName} ·{" "}
              {new Date(event.createdAt).toLocaleString()}
              {event.reason ? (
                <p className="mt-0.5 text-xs">Reason: {event.reason}</p>
              ) : null}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}