/**
 * RETIRED from the normal launch workflow. The pure validation, masking and
 * accounting rules below are preserved for reuse by the Android Smart Counter.
 *
 * Counter Companion: the fast, policy-safe entry path for counter work.
 *
 * What this is: a guided capture that turns "network, type, customer, amount,
 * reference" into one validated record in seconds, on a phone, without changing how
 * money is recorded. It reuses the offline MoMo capture path, so a companion entry is
 * an ordinary capture with the same review, conflict and evidence rules.
 *
 * What this is NOT, deliberately:
 *
 *   * It never touches a MoMo PIN. There is no field for one, and a PIN entered into
 *     the reference field is refused rather than stored.
 *   * It never reads SMS, call logs, contacts or notification content, and it asks for
 *     no Android permission. Google Play restricts SMS and call-log access to a narrow
 *     set of use cases (a default-SMS handler or a backup/restore flow), and MaaCash's
 *     job is not one of them.
 *   * It never drives an AccessibilityService to walk a USSD menu. Blind menu
 *     automation would mean MaaCash operating a financial transaction on a customer's
 *     behalf, which is neither permitted by Play policy nor honest about who did what.
 *   * It never claims a transaction is provider-confirmed. A captured reference is a
 *     reference. Only an authenticated provider statement or an approved integration
 *     can produce a confirmed state, and this module cannot produce one at all.
 *
 * The network transaction stays with the network and the agent. MaaCash assists,
 * records and evidence-captures.
 */

import { MOMO_OFFLINE_NETWORKS, type MomoOfflineNetwork } from "@/lib/offline/momo-draft";

export const COUNTER_COMPANION_VERSION = "2026-12-counter.1";

/** What the agent is doing at the counter, in the agent's own vocabulary. */
export const COUNTER_FLOWS = [
  { id: "cash_in", label: "Customer sends money (cash in)", direction: "in" },
  { id: "cash_out", label: "Customer receives money (cash out)", direction: "out" },
  { id: "commission", label: "Record commission earned", direction: "none" },
  { id: "expense", label: "Record an expense paid", direction: "none" },
] as const;

export type CounterFlowId = (typeof COUNTER_FLOWS)[number]["id"];

/**
 * A transaction's status in the companion, and the only four states it may take.
 * None of them asserts that a network completed anything.
 */
export const COUNTER_STATUS_LABELS = {
  captured: "Captured on this device",
  queued: "Waiting to be sent",
  sent: "Sent to your business record",
  needs_review: "Needs a reviewer",
} as const;

export type CounterStatus = keyof typeof COUNTER_STATUS_LABELS;

export interface CounterCaptureInput {
  flow: string;
  network: string;
  /** The customer's number as the agent typed it. */
  customerNumber?: string | null;
  /** The agent has read the number back and confirmed it. */
  customerNumberConfirmed?: boolean;
  amount: number;
  reference?: string | null;
  evidenceRef?: string | null;
}

export interface CounterCapture {
  flow: CounterFlowId;
  network: MomoOfflineNetwork;
  /** Masked for display: the full number is never shown back in a list. */
  customerNumberMasked: string | null;
  amountMinor: number;
  reference: string | null;
  evidenceRef: string | null;
  status: CounterStatus;
  /** Always false: the companion cannot confirm anything with a network. */
  providerConfirmed: false;
}

export type CounterResult =
  | { ok: true; capture: CounterCapture }
  | { ok: false; error: string; field?: "flow" | "network" | "customer" | "amount" | "reference" };

/**
 * Patterns that look like someone typing a secret into a free-text field.
 *
 * A PIN is never needed by MaaCash, so the safe answer to "is this a PIN?" is to
 * refuse the value instead of storing it. The check is intentionally broad: a false
 * positive costs the agent one reference, a false negative stores a customer secret.
 */
const PIN_LIKE = [
  /^\d{4}$/,
  /^\d{5,6}$/,
  /\bpin\b/i,
  /password/i,
  /otp/i,
  /secret/i,
  /mpin/i,
];

export function looksLikeSecret(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return PIN_LIKE.some((pattern) => pattern.test(trimmed));
}

/** Ghanaian mobile numbers, local (0XXXXXXXXX) or international (+233XXXXXXXXX). */
export function normalizeCustomerNumber(value: string): string | null {
  const digits = value.replace(/[\s-]/g, "");
  if (/^0\d{9}$/.test(digits)) return `+233${digits.slice(1)}`;
  if (/^\+233\d{9}$/.test(digits)) return digits;
  if (/^233\d{9}$/.test(digits)) return `+${digits}`;
  return null;
}

export function maskCustomerNumber(value: string | null): string | null {
  if (!value) return null;
  const normalized = normalizeCustomerNumber(value);
  if (!normalized) return null;
  return `${normalized.slice(0, 7)}•••${normalized.slice(-2)}`;
}

function toMinor(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const minor = Math.round(value * 100);
  if (Math.abs(minor / 100 - value) > 1e-9) return null;
  if (minor > 9_999_999_999) return null;
  return minor;
}

/**
 * Build one capture, refusing the things that must never be captured.
 *
 * Order of checks matches the order the agent sees the fields, so the message points
 * at the field that needs attention rather than at a rule.
 */
export function buildCounterCapture(input: CounterCaptureInput): CounterResult {
  const flow = COUNTER_FLOWS.find((row) => row.id === input.flow);
  if (!flow) {
    return { ok: false, error: "Choose what you are recording.", field: "flow" };
  }

  if (!(MOMO_OFFLINE_NETWORKS as readonly string[]).includes(input.network)) {
    return { ok: false, error: "Choose the network for this transaction.", field: "network" };
  }

  const needsCustomer = flow.id === "cash_in" || flow.id === "cash_out";
  let normalizedCustomer: string | null = null;
  if (needsCustomer) {
    const raw = (input.customerNumber ?? "").trim();
    if (!raw) {
      return { ok: false, error: "Enter the customer's number.", field: "customer" };
    }
    normalizedCustomer = normalizeCustomerNumber(raw);
    if (!normalizedCustomer) {
      return {
        ok: false,
        error: "That does not look like a Ghanaian mobile number (0XXXXXXXXX or +233XXXXXXXXX).",
        field: "customer",
      };
    }
    if (!input.customerNumberConfirmed) {
      return {
        ok: false,
        error: "Read the number back to the customer and confirm it before saving.",
        field: "customer",
      };
    }
  }

  const amountMinor = toMinor(input.amount);
  if (amountMinor === null) {
    return {
      ok: false,
      error: "Enter an amount greater than zero with at most two decimals.",
      field: "amount",
    };
  }

  const reference = (input.reference ?? "").trim() || null;
  if (reference && looksLikeSecret(reference)) {
    return {
      ok: false,
      error:
        "That looks like a PIN or a password. Never type a customer's or agent's PIN into MaaCash — use the network's own confirmation reference instead.",
      field: "reference",
    };
  }
  if (reference && reference.length > 120) {
    return { ok: false, error: "Keep the reference under 120 characters.", field: "reference" };
  }

  const evidenceRef = (input.evidenceRef ?? "").trim() || null;
  if (evidenceRef && evidenceRef.length > 200) {
    return { ok: false, error: "Keep the evidence reference under 200 characters.", field: "reference" };
  }

  return {
    ok: true,
    capture: {
      flow: flow.id,
      network: input.network as MomoOfflineNetwork,
      customerNumberMasked: maskCustomerNumber(normalizedCustomer),
      amountMinor,
      reference,
      evidenceRef,
      status: "captured",
      providerConfirmed: false,
    },
  };
}

/**
 * The line the companion shows after a capture. It states what is true — recorded
 * here, not yet reconciled — and never implies the network confirmed anything.
 */
export function counterConfirmationLine(capture: CounterCapture): string {
  const amount = `GH₵${(capture.amountMinor / 100).toFixed(2)}`;
  const network = capture.network === "at_money" ? "AT Money" : capture.network.toUpperCase();
  const where = capture.customerNumberMasked ? ` for ${capture.customerNumberMasked}` : "";
  return `${amount} ${network}${where} recorded on this device. It is sent to your business record when you reconnect and matched when a statement is imported — the network has not confirmed it to MaaCash.`;
}

/**
 * What a device may ask for. Kept as data so a future native shell can be checked
 * against it instead of inventing permissions at implementation time.
 */
export const COUNTER_PERMISSION_POLICY = {
  /** Permissions the companion needs today: none beyond the web platform. */
  required: [] as string[],
  /** Explicitly refused, with the reason, so nobody adds one "temporarily". */
  refused: [
    {
      permission: "android.permission.READ_SMS",
      reason:
        "Play restricts SMS access to default-SMS-handler and backup/restore use cases. Reading customer messages is not one.",
    },
    {
      permission: "android.permission.READ_CALL_LOG",
      reason: "Restricted for the same reason; a counter workflow has no need for call history.",
    },
    {
      permission: "android.permission.BIND_ACCESSIBILITY_SERVICE",
      reason:
        "Driving another app's UI to run USSD would make MaaCash the operator of the transaction.",
    },
  ],
} as const;
