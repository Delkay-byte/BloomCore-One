/**
 * Offline MoMo day capture: payload rules.
 *
 * A MoMo day is captured on a device when the connection is gone, then parked on the
 * server so it can be completed online. Everything here is pure and strict, because
 * these figures are what an agent will later read off a screen and type into the real
 * daily account:
 *
 *   * money is integer pesewa — a value that cannot be represented exactly is refused;
 *   * the networks are the three the product supports, not free text;
 *   * a captured reference is a reference, never proof of a provider transaction;
 *   * the canonical form is hashed, so a retry with a changed body cannot masquerade as
 *     the same draft.
 *
 * Nothing in this module posts, submits or moves money.
 */

import { hashCanonicalPayload } from "./payload";

export const MOMO_OFFLINE_NETWORKS = ["mtn", "telecel", "at_money"] as const;
export type MomoOfflineNetwork = (typeof MOMO_OFFLINE_NETWORKS)[number];

export const MOMO_OFFLINE_NETWORK_LABELS: Record<MomoOfflineNetwork, string> = {
  mtn: "MTN",
  telecel: "Telecel",
  at_money: "AT Money",
};

/** The longest a capture may sit before it cannot be applied to a day. */
export const MOMO_OFFLINE_MAX_AGE_DAYS = 14;

export interface MomoOfflineActivity {
  /** cash_in | cash_out | commission | expense */
  kind: "cash_in" | "cash_out" | "commission" | "expense";
  network: MomoOfflineNetwork;
  /** Always positive; `kind` carries the direction. */
  amountMinor: number;
  reference: string | null;
  note: string | null;
  /**
   * A device-side evidence reference (a photo/file id held on the device). A reference
   * is not a provider confirmation and is labelled as such everywhere it is shown.
   */
  evidenceRef: string | null;
}

export interface NormalizedMomoDay {
  businessDate: string;
  locationId: string;
  openingCashMinor: number;
  openingFloatMinor: number;
  closingCashMinor: number;
  closingFloatMinor: number;
  activities: MomoOfflineActivity[];
  note: string | null;
  /** How the worker says the figure was obtained. Never used as proof. */
  captureSource: "manual" | "device";
}

export type NormalizeResult =
  | { ok: true; day: NormalizedMomoDay; canonical: string; hash: string }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Integer pesewa, or null. A fractional pesewa is refused, not rounded. */
export function toMinor(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const minor = Math.round(value * 100);
  if (Math.abs(minor / 100 - value) > 1e-9) return null;
  return minor;
}

function cleanString(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanAmount(value: unknown, { allowZero = true } = {}): number | null {
  const minor = toMinor(value);
  if (minor === null) return null;
  if (minor < 0) return null;
  if (!allowZero && minor === 0) return null;
  if (minor > 9_999_999_999) return null;
  return minor;
}

export function isBusinessDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Old enough to be suspicious when applied, but not refused for that reason alone. */
export function isStaleBusinessDate(businessDate: string, now: Date = new Date()): boolean {
  const captured = new Date(`${businessDate}T00:00:00.000Z`).getTime();
  if (Number.isNaN(captured)) return true;
  const ageDays = Math.floor((now.getTime() - captured) / 86_400_000);
  return ageDays > MOMO_OFFLINE_MAX_AGE_DAYS;
}

function normalizeActivity(value: unknown): MomoOfflineActivity | null {
  if (!isRecord(value)) return null;
  const kinds = ["cash_in", "cash_out", "commission", "expense"] as const;
  if (typeof value.kind !== "string" || !(kinds as readonly string[]).includes(value.kind)) {
    return null;
  }
  if (
    typeof value.network !== "string" ||
    !(MOMO_OFFLINE_NETWORKS as readonly string[]).includes(value.network)
  ) {
    return null;
  }
  const amountMinor = cleanAmount(value.amount, { allowZero: false });
  if (amountMinor === null) return null;
  const reference = cleanString(value.reference, 120);
  const note = cleanString(value.note, 300);
  const evidenceRef = cleanString(value.evidenceRef, 200);
  if (reference === undefined || note === undefined || evidenceRef === undefined) return null;
  return {
    kind: value.kind as MomoOfflineActivity["kind"],
    network: value.network as MomoOfflineNetwork,
    amountMinor,
    reference,
    note,
    evidenceRef,
  };
}

export function canonicalMomoDay(day: NormalizedMomoDay): string {
  const activities = [...day.activities]
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.network.localeCompare(b.network) ||
        a.amountMinor - b.amountMinor ||
        (a.reference ?? "").localeCompare(b.reference ?? "")
    )
    .map((a) =>
      [a.kind, a.network, a.amountMinor, a.reference ?? "", a.note ?? "", a.evidenceRef ?? ""].join("~")
    );
  return [
    day.businessDate,
    day.locationId,
    day.openingCashMinor,
    day.openingFloatMinor,
    day.closingCashMinor,
    day.closingFloatMinor,
    day.captureSource,
    day.note ?? "",
    activities.join("|"),
  ].join("|");
}

/**
 * Validate and canonicalise a captured MoMo day.
 *
 * An empty day is allowed — an agent with no transactions still has an opening and a
 * closing figure to account for — but the four figures are required, because a day
 * without them is not a day an owner can reconcile.
 */
export function normalizeMomoDay(input: unknown): NormalizeResult {
  if (!isRecord(input)) return { ok: false, error: "Invalid capture payload" };

  if (!isBusinessDate(input.businessDate)) {
    return { ok: false, error: "Enter a valid business date (YYYY-MM-DD)." };
  }
  const locationId = cleanString(input.locationId, 200);
  if (!locationId) return { ok: false, error: "The capture is missing its branch." };

  const openingCash = cleanAmount(input.openingCash);
  const openingFloat = cleanAmount(input.openingFloat);
  const closingCash = cleanAmount(input.closingCash);
  const closingFloat = cleanAmount(input.closingFloat);
  if (openingCash === null || openingFloat === null || closingCash === null || closingFloat === null) {
    return {
      ok: false,
      error: "Enter opening and closing cash and float as amounts with at most two decimals.",
    };
  }

  if (!Array.isArray(input.activities) || input.activities.length > 200) {
    return { ok: false, error: "A day cannot carry that many captured activities." };
  }
  const activities: MomoOfflineActivity[] = [];
  for (const raw of input.activities) {
    const activity = normalizeActivity(raw);
    if (!activity) {
      return { ok: false, error: "One of the captured activities is not valid." };
    }
    activities.push(activity);
  }

  const note = cleanString(input.note, 500);
  if (note === undefined) return { ok: false, error: "Keep the day note under 500 characters." };

  const captureSource = input.captureSource === "device" ? "device" : "manual";

  const day: NormalizedMomoDay = {
    businessDate: input.businessDate,
    locationId,
    openingCashMinor: openingCash,
    openingFloatMinor: openingFloat,
    closingCashMinor: closingCash,
    closingFloatMinor: closingFloat,
    activities,
    note,
    captureSource,
  };
  const canonical = canonicalMomoDay(day);
  return { ok: true, day, canonical, hash: hashCanonicalPayload(canonical) };
}

/** Totals for display only. The server recomputes nothing from these. */
export function summarizeMomoDay(day: NormalizedMomoDay) {
  const by = (kind: MomoOfflineActivity["kind"]) =>
    day.activities.filter((a) => a.kind === kind).reduce((sum, a) => sum + a.amountMinor, 0);
  return {
    cashInMinor: by("cash_in"),
    cashOutMinor: by("cash_out"),
    commissionMinor: by("commission"),
    expenseMinor: by("expense"),
    activityCount: day.activities.length,
  };
}
