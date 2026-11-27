"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import Notice from "@/components/ui/Notice";
import { exportSupportQueue } from "@/lib/actions/platform-support.actions";

export default function SupportQueueTools({
  status,
  priority,
  assignment,
}: {
  status?: string;
  priority?: string;
  assignment?: "all" | "mine" | "unassigned";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    setBusy(true);
    setError("");
    try {
      const result = await exportSupportQueue({ status, priority, assignment });
      if (!result.success || !result.csv || !result.filename) {
        setError(result.error || "The queue could not be exported.");
        return;
      }
      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("The queue could not be exported.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {error && <Notice type="error" message={error}>{error}</Notice>}
      <button type="button" onClick={run} disabled={busy} className="btn btn-secondary btn-sm">
        <Download size={14} aria-hidden /> {busy ? "Exporting…" : "Export queue (metadata only)"}
      </button>
    </div>
  );
}
