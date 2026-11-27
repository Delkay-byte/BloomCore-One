"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Notice from "@/components/ui/Notice";
import {
  reopenSupportRequest,
  replyToSupportRequest,
} from "@/lib/actions/susu-support.actions";

export default function SupportThread({
  requestId,
  status,
  isAdmin,
}: {
  requestId: string;
  status: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const closed = status === "closed";
  const canReopen = isAdmin && (status === "resolved" || status === "closed");

  async function reply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await replyToSupportRequest({ requestId, body });
      if (!result.success) {
        setError(result.error || "The message could not be sent.");
        return;
      }
      setBody("");
      router.refresh();
    } catch {
      setError("The message could not be sent. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function reopen(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await reopenSupportRequest({ requestId, reason });
      if (!result.success) {
        setError(result.error || "The request could not be reopened.");
        return;
      }
      setReason("");
      router.refresh();
    } catch {
      setError("The request could not be reopened. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Notice type="error" message={error}>{error}</Notice>}
      {canReopen && (
        <form onSubmit={reopen} className="card space-y-3">
          <h2 className="text-base font-semibold text-brand-900">Reopen this request</h2>
          <p className="text-sm text-ink-muted">
            Reopen when the answer did not resolve the issue or the situation changed.
          </p>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={500}
            required
            placeholder="What still needs attention?"
            className="w-full"
          />
          <button type="submit" className="btn btn-secondary" disabled={busy}>
            Reopen request
          </button>
        </form>
      )}
      {closed ? (
        <p className="card text-sm text-ink-muted">
          This request is closed. An administrator can reopen it if the issue returns.
        </p>
      ) : (
        <form onSubmit={reply} className="card space-y-3">
          <h2 className="text-base font-semibold text-brand-900">Reply</h2>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={4}
            maxLength={4000}
            required
            placeholder="Add an update or answer the question support asked."
            className="w-full"
          />
          <p className="text-xs text-ink-muted">
            Replies are visible to the support team and to this business&apos;s administrators.
            Never include passwords, PINs or API keys.
          </p>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Sending…" : "Send reply"}
          </button>
        </form>
      )}
    </div>
  );
}