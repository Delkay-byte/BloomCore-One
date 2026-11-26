"use client";

import { useState } from "react";
import Notice from "@/components/ui/Notice";
import { publishControlledEmployeeNotice } from "@/lib/actions/risk-governance.actions";

/**
 * Restricted publication of the controlled Instrument 3 template. The server
 * chooses the text; this form only supplies version and effective date.
 */
export default function NoticePublisher({
  currentVersion,
  currentEffectiveDate,
}: {
  currentVersion: string | null;
  currentEffectiveDate: string | null;
}) {
  const [version, setVersion] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(
    currentEffectiveDate ?? new Date().toISOString().slice(0, 10)
  );
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function publish() {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await publishControlledEmployeeNotice({
        version: version.trim(),
        effectiveDate: new Date(effectiveDate + "T00:00:00.000Z").toISOString(),
      });
      if (result.success) {
        setMessage("Controlled Instrument 3 published. Employees will see their own verified facts.");
        setVersion("");
      } else {
        setError(result.error ?? "The notice could not be published.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-3" data-testid="notice-publisher">
      <p className="text-xs text-slate-600">
        Current version: {currentVersion ?? "none"}. Publishing here stores the controlled
        Employee and Agent Privacy Notice (Instrument 3). Employee names and phone suffixes are
        inserted only when each employee reads it; do not paste a partially completed copy.
      </p>
      {message && <Notice type="success">{message}</Notice>}
      {error && <Notice type="error">{error}</Notice>}
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="text-xs font-medium text-slate-700">
          Notice version
          <input
            className="input mt-1 w-full"
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            placeholder="e.g. employee-notice-2026.11"
          />
        </label>
        <label className="text-xs font-medium text-slate-700">
          Effective date
          <input
            type="date"
            className="input mt-1 w-full"
            value={effectiveDate}
            onChange={(event) => setEffectiveDate(event.target.value)}
          />
        </label>
        <div className="flex items-end">
          <button
            type="button"
            className="btn btn-primary btn-sm w-full"
            disabled={busy || version.trim().length < 3}
            onClick={publish}
          >
            {busy ? "Publishing…" : "Publish controlled notice"}
          </button>
        </div>
      </div>
    </div>
  );
}
