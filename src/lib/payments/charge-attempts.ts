import { randomBytes } from "crypto";
import { db } from "@/lib/db";

/**
 * ============================================================================
 * PAYMENT-CHARGE ATTEMPTS
 * ============================================================================
 *
 * Exactly one row exists per provider reference (`reference` is unique), and
 * that uniqueness is the concurrency guard: a second request cannot create a
 * row, so it can never reach Paystack a second time.
 *
 * The row is an explicit state machine:
 *
 *   initiating ──▶ pending       provider accepted the charge (awaiting the
 *                                customer's phone authorisation)
 *              ──▶ rejected      provider refused it; no charge exists
 *              ──▶ failed        provider or verification says the charge failed
 *              ──▶ unresolved    we cannot tell whether the provider acted
 *              ──▶ succeeded     a verified transaction settled it
 *              ──▶ abandoned     reconciliation proved no charge exists
 *
 * Only `rejected` and `abandoned` may be claimed again on the same reference,
 * and only after the caller has confirmed that the provider holds no
 * transaction for it. `pending`, `unresolved`, `failed` and `succeeded` block
 * any further provider call on that reference:
 *
 *   * `pending`      return the prompt that is already on the customer's phone;
 *   * `unresolved`   reconcile before anything else;
 *   * `failed`       Paystack declined it, so the same unpaid subscription moves
 *                    to a fresh reference and this row stays as history;
 *   * `succeeded`    fulfil exactly once, never charge again.
 *
 * The row never stores a wallet number, e-mail address, provider payload, OTP
 * or secret. `reason` is always a sanitized, bounded string, and
 * `requiredAction` is only ever the *kind* of input Paystack asked for.
 */

export type ChargeAttemptState =
  | "initiating"
  | "pending"
  | "rejected"
  | "failed"
  | "unresolved"
  | "succeeded"
  | "abandoned";

/**
 * What the customer still has to do while the attempt is pending. This is a
 * classification only; the OTP itself is never written anywhere.
 */
export type ChargeRequiredAction = "otp" | "phone_prompt" | "offline" | "checkout";

export function isChargeRequiredAction(
  value: string | null | undefined
): value is ChargeRequiredAction {
  return (
    value === "otp" ||
    value === "phone_prompt" ||
    value === "offline" ||
    value === "checkout"
  );
}

/** The provider's `send_otp` state is the only one that opens the OTP form. */
export function requiresOtp(attempt: {
  state: string;
  requiredAction: string | null;
}): boolean {
  return attempt.state === "pending" && attempt.requiredAction === "otp";
}

/** States in which the provider may still hold a charge for the reference. */
const OPEN_STATES: ChargeAttemptState[] = ["initiating", "pending", "unresolved"];

/** States that may be claimed again because no provider charge exists. */
const RETRYABLE_STATES: ChargeAttemptState[] = ["rejected", "abandoned"];

export interface ChargeAttempt {
  id: string;
  reference: string;
  tenantId: string;
  subscriptionId: string;
  method: string;
  network: string | null;
  checkoutChannel: string | null;
  amount: number;
  currency: string;
  state: string;
  requiredAction: string | null;
  checkoutUrl: string | null;
  attempts: number;
  providerHttpStatus: number | null;
  providerCode: string | null;
  reason: string | null;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

export function isOpenAttempt(state: string | null | undefined): boolean {
  return OPEN_STATES.includes(state as ChargeAttemptState);
}

/** Can this reference be replaced by a new intent without a provider check? */
export function canReplaceReference(state: string | null | undefined): boolean {
  // No attempt at all, or an attempt that provably never became a charge.
  if (!state) return true;
  return RETRYABLE_STATES.includes(state as ChargeAttemptState) || state === "failed";
}

type ChargeAttemptRow = {
  id: string;
  reference: string;
  tenantId: string;
  subscriptionId: string;
  method: string;
  network: string | null;
  checkoutChannel: string | null;
  amount: unknown;
  currency: string;
  state: string;
  requiredAction: string | null;
  checkoutUrl: string | null;
  attempts: number;
  providerHttpStatus: number | null;
  providerCode: string | null;
  reason: string | null;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
};

function toAttempt(row: ChargeAttemptRow): ChargeAttempt {
  return { ...row, amount: Number(row.amount) };
}

export async function findChargeAttempt(reference: string): Promise<ChargeAttempt | null> {
  const row = await db.zeliChargeAttempt.findUnique({ where: { reference } });
  return row ? toAttempt(row as ChargeAttemptRow) : null;
}

export interface ClaimInput {
  reference: string;
  tenantId: string;
  subscriptionId: string;
  method: "mobile_money" | "hosted";
  network?: string | null;
  checkoutChannel?: string | null;
  amount: number;
  currency: string;
  requiredAction?: ChargeRequiredAction | null;
}

export type ClaimResult =
  | { claimed: true; attempt: ChargeAttempt }
  | { claimed: false; attempt: ChargeAttempt };

/**
 * Atomically claim the right to call the provider for a reference.
 *
 * The insert is the claim. A concurrent request loses the race on the unique
 * index and is handed the winner's row instead of calling Paystack again. A
 * reference that was definitely rejected may be claimed a second time by a
 * conditional update, which is again atomic.
 */
export async function claimChargeAttempt(input: ClaimInput): Promise<ClaimResult> {
  const correlationId = randomBytes(8).toString("hex");
  try {
    const created = await db.zeliChargeAttempt.create({
      data: {
        reference: input.reference,
        tenantId: input.tenantId,
        subscriptionId: input.subscriptionId,
        provider: "paystack",
        method: input.method,
        network: input.network ?? null,
        checkoutChannel: input.checkoutChannel ?? null,
        amount: input.amount,
        currency: input.currency,
        state: "initiating",
        requiredAction: input.requiredAction ?? null,
        attempts: 1,
        correlationId,
      },
    });
    return { claimed: true, attempt: toAttempt(created as ChargeAttemptRow) };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  // A row already exists. Only a definitely-rejected or abandoned attempt may
  // be reused, and the transition itself is the atomic claim.
  const reclaimed = await db.zeliChargeAttempt.updateMany({
    where: { reference: input.reference, state: { in: RETRYABLE_STATES } },
    data: {
      state: "initiating",
      requiredAction: input.requiredAction ?? null,
      ...(input.checkoutChannel !== undefined
        ? { checkoutChannel: input.checkoutChannel }
        : {}),
      attempts: { increment: 1 },
      providerHttpStatus: null,
      providerCode: null,
      reason: null,
      resolvedAt: null,
      correlationId,
      updatedAt: new Date(),
    },
  });
  const existing = await findChargeAttempt(input.reference);
  if (existing && reclaimed.count === 1) return { claimed: true, attempt: existing };
  if (!existing) throw new Error("charge_attempt_missing");
  return { claimed: false, attempt: existing };
}

export interface AttemptOutcome {
  state: ChargeAttemptState;
  requiredAction?: ChargeRequiredAction | null;
  /** Explicit URL to keep/resume. `undefined` leaves the stored value alone. */
  checkoutUrl?: string | null;
  providerHttpStatus?: number | null;
  providerCode?: string | null;
  reason?: string | null;
}

const TERMINAL_STATES = ["succeeded", "failed", "rejected", "abandoned"];

/**
 * Build the columns for an outcome without erasing a pending instruction the
 * caller did not intend to change. An explicit `requiredAction` always wins;
 * a terminal outcome always clears it; any other outcome leaves the stored
 * value untouched (Prisma treats `undefined` as "do not update").
 */
function outcomeColumns(outcome: AttemptOutcome) {
  const terminal = TERMINAL_STATES.includes(outcome.state);
  return {
    state: outcome.state,
    ...(outcome.requiredAction !== undefined
      ? { requiredAction: outcome.requiredAction }
      : terminal
        ? { requiredAction: null }
        : {}),
    ...(outcome.checkoutUrl !== undefined
      ? { checkoutUrl: outcome.checkoutUrl }
      : terminal
        ? { checkoutUrl: null }
        : {}),
    providerHttpStatus: outcome.providerHttpStatus ?? null,
    providerCode: outcome.providerCode ?? null,
    reason: outcome.reason ?? null,
    resolvedAt: terminal ? new Date() : null,
  };
}

export async function recordAttemptOutcome(
  id: string,
  outcome: AttemptOutcome
): Promise<void> {
  await db.zeliChargeAttempt.update({
    where: { id },
    data: outcomeColumns(outcome),
  });
}

/** Move an open attempt forward only; a late duplicate must not reopen it. */
export async function settleOpenAttempt(id: string, outcome: AttemptOutcome): Promise<void> {
  await db.zeliChargeAttempt.updateMany({
    where: { id, state: { in: OPEN_STATES } },
    data: outcomeColumns(outcome),
  });
}

/** Customer-safe description of an attempt, safe to return to the browser. */
export function attemptMessage(attempt: ChargeAttempt): string {
  switch (attempt.state) {
    case "pending":
      if (attempt.requiredAction === "otp") {
        return (
          attempt.reason ||
          "Paystack sent a verification code to your phone. Enter it here to finish the payment."
        );
      }
      if (attempt.requiredAction === "checkout") {
        return (
          attempt.reason ||
          "A secure Paystack checkout is already open for this payment. Complete it, then check the payment status."
        );
      }
      return (
        attempt.reason ||
        "A mobile money prompt is waiting on your phone. Approve it, then check the payment status."
      );
    case "unresolved":
      return "We could not confirm whether Paystack received the last attempt. Do not pay again. Check the payment status and MaaCash will reconcile it first.";
    case "succeeded":
      return "This payment is already confirmed.";
    case "rejected":
      return (
        attempt.reason ||
        "Paystack rejected the last attempt. Nothing was charged; you can correct the details and try again."
      );
    case "failed":
      return "The last attempt was declined by Paystack. No access was granted; a new attempt uses a new payment reference.";
    case "abandoned":
      return "The last attempt was never completed and no charge exists. You can try again.";
    default:
      return "A payment attempt is already in progress for this reference.";
  }
}
