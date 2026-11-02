/**
 * Canonical contribution payloads for offline idempotency.
 *
 * An idempotency key identifies one immutable financial instruction. The
 * server normalizes the incoming payload, validates it, and compares a SHA-256
 * digest of the canonical form with the digest of the payload stored when the
 * key was first reserved. Property order and omitted optional fields therefore
 * do not create false mismatches, while any material change (amount, account,
 * channel, notes, collector) is rejected.
 *
 * Server-only: imports Node's crypto module.
 */

import { createHash } from "crypto";

export type ContributionChannel = "collector" | "direct_office";

export interface NormalizedContributionPayload {
  accountId: string;
  amount: number;
  channel: ContributionChannel;
  notes: string | null;
  collectorId: string | null;
}

export type PayloadResult =
  | {
      ok: true;
      payload: NormalizedContributionPayload;
      canonical: string;
      hash: string;
    }
  | { ok: false; error: string };

export function canonicalContributionPayload(
  payload: NormalizedContributionPayload
): string {
  // Fixed key order. Optional fields are explicit nulls so `notes: undefined`
  // and an omitted notes field are the same instruction.
  return JSON.stringify({
    accountId: payload.accountId,
    amount: payload.amount,
    channel: payload.channel,
    notes: payload.notes,
    collectorId: payload.collectorId,
  });
}

export function hashCanonicalPayload(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate and canonicalize one contribution payload. */
export function normalizeContributionPayload(input: unknown): PayloadResult {
  if (!isRecord(input)) {
    return { ok: false, error: "Invalid transaction payload" };
  }

  const accountId = input.accountId;
  if (
    typeof accountId !== "string" ||
    accountId.length === 0 ||
    accountId.length > 200 ||
    accountId.trim() !== accountId
  ) {
    return { ok: false, error: "Invalid account" };
  }

  const amount = input.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Invalid amount" };
  }

  const channel = input.channel;
  if (channel !== "collector" && channel !== "direct_office") {
    return { ok: false, error: "Invalid collection channel" };
  }

  let notes: string | null = null;
  if (input.notes !== undefined && input.notes !== null) {
    if (typeof input.notes !== "string" || input.notes.length > 2000) {
      return { ok: false, error: "Invalid notes" };
    }
    const trimmed = input.notes.trim();
    notes = trimmed.length > 0 ? trimmed : null;
  }

  let collectorId: string | null = null;
  if (input.collectorId !== undefined && input.collectorId !== null) {
    if (
      typeof input.collectorId !== "string" ||
      input.collectorId.length === 0 ||
      input.collectorId.length > 200
    ) {
      return { ok: false, error: "Invalid collector" };
    }
    collectorId = input.collectorId;
  }

  const payload: NormalizedContributionPayload = {
    accountId,
    amount,
    channel,
    notes,
    collectorId,
  };
  const canonical = canonicalContributionPayload(payload);

  return {
    ok: true,
    payload,
    canonical,
    hash: hashCanonicalPayload(canonical),
  };
}

/**
 * Normalize a payload previously stored for this key. Legacy rows stored the
 * raw client JSON, which normalizes to the same canonical form.
 */
export function payloadDigestForStored(stored: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stored);
    const normalized = normalizeContributionPayload(parsed);
    return normalized.ok ? normalized.hash : null;
  } catch {
    return null;
  }
}

export function idempotencyKeyIsValid(key: unknown): key is string {
  return typeof key === "string" && /^[A-Za-z0-9:_-]{8,200}$/.test(key);
}
