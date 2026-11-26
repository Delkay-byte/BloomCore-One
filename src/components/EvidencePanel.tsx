"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Paperclip, ShieldCheck } from "lucide-react";
import Notice from "@/components/ui/Notice";
import {
  getEvidenceForSubject,
  uploadEvidence,
  type EvidenceView,
} from "@/lib/actions/evidence.actions";
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_CONTENT_TYPES,
  type EvidenceSubjectType,
} from "@/lib/evidence-constants";

/**
 * Evidence files for one record.
 *
 * The file is read in the browser and sent to a server action that re-checks the
 * subject, the type and the size. The stored digest is shown after upload so the
 * person who attached it can see exactly what was kept.
 */
export default function EvidencePanel({
  subjectType,
  subjectId,
  label = "Evidence",
  readOnly = false,
  onUploaded,
}: {
  subjectType: EvidenceSubjectType;
  subjectId: string;
  label?: string;
  readOnly?: boolean;
  onUploaded?: () => void;
}) {
  const [attachments, setAttachments] = useState<EvidenceView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    const result = await getEvidenceForSubject(subjectType, subjectId);
    if (result.success) setAttachments(result.attachments ?? []);
  }, [subjectType, subjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onChoose(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      if (file.size > EVIDENCE_MAX_BYTES) {
        setError("That file is larger than 10 MB.");
        return;
      }
      if (!(EVIDENCE_CONTENT_TYPES as readonly string[]).includes(file.type)) {
        setError("Attach a JPEG, PNG, WebP image or a PDF.");
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await uploadEvidence({
        subjectType,
        subjectId,
        fileName: file.name,
        contentType: file.type,
        bytes,
      });
      if (!result.success) {
        setError(result.error ?? "The file could not be attached.");
      } else {
        setSuccess(`${result.data?.fileName} attached and fingerprinted.`);
        await load();
        onUploaded?.();
      }
    } catch {
      setError("The file could not be read.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <section className="card space-y-2 p-4" aria-labelledby={`evidence-${subjectId}`}>
      <h2
        id={`evidence-${subjectId}`}
        className="flex items-center gap-2 text-sm font-semibold text-slate-900"
      >
        <Paperclip size={14} aria-hidden /> {label}
      </h2>
      <p className="text-[11px] text-slate-500">
        Images or PDF only, up to 10 MB. Each file is stored privately with its
        fingerprint, so a changed file is detectable.
      </p>

      {error && <Notice type="error">{error}</Notice>}
      {success && <Notice type="success">{success}</Notice>}

      {attachments.length === 0 ? (
        <p className="text-xs text-slate-500">Nothing attached yet.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="flex flex-wrap items-center gap-2">
              <a
                href={`/api/evidence/${attachment.id}`}
                className="font-medium text-brand-700 underline"
              >
                {attachment.fileName}
              </a>
              <span className="text-slate-500">
                {Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB ·{" "}
                {new Date(attachment.uploadedAt).toLocaleDateString("en-GB")} ·{" "}
                {attachment.uploadedByType}
              </span>
              <span
                className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
                title={attachment.sha256}
              >
                <ShieldCheck size={10} aria-hidden /> {attachment.sha256.slice(0, 12)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!readOnly && (
        <div>
          <input
            ref={inputRef}
            type="file"
            accept={EVIDENCE_CONTENT_TYPES.join(",")}
            onChange={(event) => void onChoose(event)}
            disabled={busy}
            className="block w-full text-xs"
            aria-label={`Attach ${label.toLowerCase()}`}
          />
          {busy && <p className="mt-1 text-[11px] text-slate-500">Uploading…</p>}
        </div>
      )}
    </section>
  );
}
