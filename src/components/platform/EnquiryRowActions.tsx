"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { updateAccountEnquiryStatus } from "@/lib/actions/platform-enquiries.actions";

import { ENQUIRY_STATUSES } from "@/lib/pricing/enquiry-status";

export default function EnquiryRowActions({
  id,
  status,
}: {
  id: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState(status);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await updateAccountEnquiryStatus({ id, status: value, notes });
      if (!result.success) {
        setError(result.error ?? "Could not update this enquiry.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not update this enquiry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
          aria-label="Enquiry status"
          disabled={busy}
        >
          {ENQUIRY_STATUSES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <input
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Note (optional)"
          maxLength={2000}
          className="min-w-40 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs"
          disabled={busy}
        />
        <button
          type="button"
          onClick={save}
          className="btn btn-secondary text-xs"
          disabled={busy}
        >
          {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : null}
          Save
        </button>
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
