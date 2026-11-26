/**
 * Offline request payloads.
 *
 * An offline capture that would move money is queued as a request, never as a
 * posting. These normalizers are pure: they validate and canonicalise what the
 * device queued so the server stores exactly one interpretation of it, and so a
 * changed payload can never be replayed under an existing idempotency key.
 */

import { hashCanonicalPayload } from "./payload";

export const OFFLINE_REQUEST_KINDS = ["withdrawal", "remittance", "reversal"] as const;
export type OfflineRequestKind = (typeof OFFLINE_REQUEST_KINDS)[number];

export const OFFLINE_REQUEST_KIND_LABELS: Record<OfflineRequestKind, string> = {
  withdrawal: "Customer withdrawal",
  remittance: "Cash handed in",
  reversal: "Reversal request",
};

export interface NormalizedOfflineRequest {
  kind: OfflineRequestKind;
  /** The entity the request is about: a Susu account, a collector or a record. */
  subjectId: string;
  /** Money in pesewa, so the stored request cannot drift. */
  amountMinor: number | null;
  notes: string | null;
  /** Extra, kind-specific fields that are still required to authorise it. */
  reason: string | null;
}

export type OfflineRequestResult =
  | {
      ok: true;
      request: NormalizedOfflineRequest;
      canonical: string;
      hash: string;
    }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  return trimmed;
}

function cleanNote(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Money is validated as integer pesewa so no rounding can change it. */
function toMinor(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value > 9_999_999_999) return null;
  const minor = Math.round(value * 100);
  if (Math.abs(minor / 100 - value) > 1e-9) return null;
  return minor;
}

export function canonicalOfflineRequest(request: NormalizedOfflineRequest): string {
  return [
    request.kind,
    request.subjectId,
    request.amountMinor === null ? "" : String(request.amountMinor),
    request.notes ?? "",
    request.reason ?? "",
  ].join("|");
}

export function normalizeOfflineRequest(input: unknown): OfflineRequestResult {
  if (!isRecord(input)) return { ok: false, error: "Invalid request payload" };

  const kind = input.kind;
  if (typeof kind !== "string" || !(OFFLINE_REQUEST_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: "Unknown offline request type" };
  }

  const notes = cleanNote(input.notes, 500);
  if (notes === undefined) return { ok: false, error: "Invalid notes" };

  if (kind === "withdrawal") {
    const accountId = cleanId(input.accountId);
    if (!accountId) return { ok: false, error: "Invalid account" };
    const amountMinor = toMinor(input.amount);
    if (amountMinor === null) return { ok: false, error: "Invalid amount" };
    const request: NormalizedOfflineRequest = {
      kind: "withdrawal",
      subjectId: accountId,
      amountMinor,
      notes,
      reason: null,
    };
    const canonical = canonicalOfflineRequest(request);
    return { ok: true, request, canonical, hash: hashCanonicalPayload(canonical) };
  }

  if (kind === "remittance") {
    const collectorId = cleanId(input.collectorId);
    if (!collectorId) return { ok: false, error: "Invalid collector" };
    const amountMinor = toMinor(input.amount);
    if (amountMinor === null) return { ok: false, error: "Invalid amount" };
    const request: NormalizedOfflineRequest = {
      kind: "remittance",
      subjectId: collectorId,
      amountMinor,
      notes,
      reason: null,
    };
    const canonical = canonicalOfflineRequest(request);
    return { ok: true, request, canonical, hash: hashCanonicalPayload(canonical) };
  }

  // Reversal: a request to undo a record. It carries no amount of its own; the
  // amount belongs to the record being reversed, so the reviewer sees the truth
  // from the ledger rather than from a queued number.
  const recordType = input.recordType;
  if (recordType !== "withdrawal" && recordType !== "contribution") {
    return { ok: false, error: "Choose the record type to reverse" };
  }
  const recordId = cleanId(input.recordId);
  if (!recordId) return { ok: false, error: "Invalid record" };
  const reason = cleanNote(input.reason, 500);
  if (!reason || reason.length < 10) {
    return { ok: false, error: "A reversal request needs a reason of at least 10 characters" };
  }
  const request: NormalizedOfflineRequest = {
    kind: "reversal",
    // The record is the subject; its type is folded into the id so the canonical
    // form stays one flat string.
    subjectId: `${recordType}:${recordId}`,
    amountMinor: null,
    notes,
    reason,
  };
  const canonical = canonicalOfflineRequest(request);
  return { ok: true, request, canonical, hash: hashCanonicalPayload(canonical) };
}

/** Split a reversal subject back into its type and record id. */
export function splitReversalSubject(subjectId: string): {
  recordType: "withdrawal" | "contribution";
  recordId: string;
} | null {
  const [recordType, ...rest] = subjectId.split(":");
  const recordId = rest.join(":");
  if (!recordId) return null;
  if (recordType !== "withdrawal" && recordType !== "contribution") return null;
  return { recordType, recordId };
}
