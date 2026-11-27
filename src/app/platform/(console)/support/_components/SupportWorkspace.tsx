"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Notice from "@/components/ui/Notice";
import {
  acknowledgeSupportRequest,
  addSupportInternalNote,
  assignSupportRequest,
  closeSupportRequest,
  escalateSupportRequest,
  reopenSupportRequestAsSupport,
  replyToTenantSupportRequest,
  resolveSupportRequest,
} from "@/lib/actions/platform-support.actions";

export default function SupportWorkspace({
  requestId,
  status,
  agents,
  assignedAgentId,
}: {
  requestId: string;
  status: string;
  agents: { id: string; fullName: string }[];
  assignedAgentId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const [resolution, setResolution] = useState("");
  const [escalation, setEscalation] = useState("");
  const [closeReason, setCloseReason] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const [agentId, setAgentId] = useState(assignedAgentId ?? agents[0]?.id ?? "");

  async function run(task: () => Promise<{ success: boolean; error?: string }>, message: string) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await task();
      if (!result.success) {
        setError(result.error || "The action could not be completed.");
        return;
      }
      setSuccess(message);
      router.refresh();
    } catch {
      setError("The action could not be completed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const resolved = status === "resolved" || status === "closed";

  return (
    <div className="space-y-4">
      {error && <Notice type="error" message={error}>{error}</Notice>}
      {success && <Notice type="success" message={success}>{success}</Notice>}

      <div className="grid gap-4 lg:grid-cols-2">
        <form
          className="card space-y-3 bg-white"
          onSubmit={(event) => {
            event.preventDefault();
            const body = reply;
            void run(async () => {
              const result = await replyToTenantSupportRequest({ requestId, body });
              if (result.success) setReply("");
              return result;
            }, "Reply sent to the business.");
          }}
        >
          <h2 className="font-semibold text-slate-900">Reply to the business</h2>
          <p className="text-xs text-slate-500">
            Visible to the business&apos;s administrators and to everyone on the request. Never ask
            for a password, PIN or one-time code.
          </p>
          <textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            rows={4}
            required
            maxLength={4000}
            className="w-full"
            placeholder="Answer the question or explain the next step."
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || status === "closed"}>
            Send reply
          </button>
          {status === "closed" && <p className="text-xs text-slate-500">Reopen the request to reply.</p>}
        </form>

        <form
          className="card space-y-3 bg-white"
          onSubmit={(event) => {
            event.preventDefault();
            const body = note;
            void run(async () => {
              const result = await addSupportInternalNote({ requestId, body });
              if (result.success) setNote("");
              return result;
            }, "Internal note saved. The business cannot see it.");
          }}
        >
          <h2 className="font-semibold text-slate-900">Internal note</h2>
          <p className="text-xs text-slate-500">
            Only platform staff see internal notes. They never appear in the business portal or in
            an export.
          </p>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={4}
            required
            maxLength={4000}
            className="w-full"
            placeholder="What you checked, what you found, who else is involved."
          />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={busy}>
            Save internal note
          </button>
        </form>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card space-y-3 bg-white">
          <h2 className="font-semibold text-slate-900">Assignment</h2>
          <p className="text-sm text-slate-600">
            {assignedAgentId ? "Assigned to a support agent." : "Not yet assigned."}
          </p>
          <div className="flex flex-wrap gap-2">
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)} className="min-w-40">
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.fullName}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy || !agentId}
              onClick={() =>
                void run(() => assignSupportRequest({ requestId, agentId }), "Request assigned.")
              }
            >
              Assign
            </button>
            {status === "open" && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => void run(() => acknowledgeSupportRequest(requestId), "Request acknowledged and assigned.")}
              >
                Acknowledge
              </button>
            )}
          </div>
        </div>

        <div className="card space-y-3 bg-white">
          <h2 className="font-semibold text-slate-900">Resolve</h2>
          <p className="text-xs text-slate-500">
            The resolution is shown to the business. Record what was done, not internal reasoning.
          </p>
          <textarea
            value={resolution}
            onChange={(event) => setResolution(event.target.value)}
            rows={3}
            maxLength={2000}
            className="w-full"
            placeholder="What was wrong and what changed."
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || resolved || resolution.trim().length < 10}
            onClick={() =>
              void run(() => resolveSupportRequest({ requestId, resolutionNote: resolution }), "Request resolved.")
            }
          >
            Resolve request
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card space-y-3 bg-white">
          <h2 className="font-semibold text-slate-900">Escalate</h2>
          <textarea
            value={escalation}
            onChange={(event) => setEscalation(event.target.value)}
            rows={3}
            maxLength={1000}
            className="w-full"
            placeholder="Why this needs a higher level of attention."
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || resolved || escalation.trim().length < 5}
            onClick={() =>
              void run(() => escalateSupportRequest({ requestId, reason: escalation }), "Request escalated.")
            }
          >
            Escalate
          </button>
        </div>

        <div className="card space-y-3 bg-white">
          <h2 className="font-semibold text-slate-900">Close</h2>
          <textarea
            value={closeReason}
            onChange={(event) => setCloseReason(event.target.value)}
            rows={3}
            maxLength={1000}
            className="w-full"
            placeholder="Reason (required for an escalated request)."
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || status === "closed"}
            onClick={() =>
              void run(() => closeSupportRequest({ requestId, reason: closeReason }), "Request closed.")
            }
          >
            Close request
          </button>
        </div>

        <div className="card space-y-3 bg-white">
          <h2 className="font-semibold text-slate-900">Reopen</h2>
          <textarea
            value={reopenReason}
            onChange={(event) => setReopenReason(event.target.value)}
            rows={3}
            maxLength={1000}
            className="w-full"
            placeholder="Why this is being reopened."
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || !resolved || reopenReason.trim().length < 5}
            onClick={() =>
              void run(() => reopenSupportRequestAsSupport({ requestId, reason: reopenReason }), "Request reopened.")
            }
          >
            Reopen
          </button>
        </div>
      </div>
    </div>
  );
}
