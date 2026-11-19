/**
 * ============================================================================
 * BILLING FEEDBACK — ONE MESSAGE, ONE TONE
 * ============================================================================
 *
 * Every billing action ends in a notification. The wording and the severity are
 * decided here, once, so the page cannot accidentally invite a second payment
 * or understate a failure.
 *
 * The rules that matter:
 *
 *   * An uncertain charge is a warning, never an error with a retry hint. The
 *     owner must check the status first; paying again could double-charge.
 *   * A confirmed provider rejection is an error that explicitly says a safe
 *     retry is available, because no charge exists.
 *   * Success is only ever described after server-side verification.
 */

export type FeedbackTone = "success" | "error" | "info" | "warning";

export interface Feedback {
  tone: FeedbackTone;
  message: string;
}

const UNRESOLVED =
  "We could not confirm whether Paystack received the last request. Do not pay again — use Check payment status so MaaCash can confirm whether Paystack received it.";
const REJECTED =
  "Paystack did not accept this payment request. Nothing was charged. You can try again safely: the same package will get a fresh payment reference.";
const START_FAILED = "The payment could not be started. No money was taken.";
const PENDING =
  "Paystack has not confirmed this payment yet. Do not pay again; MaaCash keeps checking and you can check again shortly.";
const VERIFIED = "Payment verified. Your subscription is active.";

function text(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export interface PaymentFailureInput {
  error?: string | null;
  state?: "rejected" | "unresolved" | "closed" | string | null;
}

/** A failed payment-start response, with the safe next step for that state. */
export function describePaymentFailure(input: PaymentFailureInput): Feedback {
  const detail = text(input.error);
  if (input.state === "unresolved") {
    // The server already says "do not pay again" in some paths; repeating the
    // whole sentence makes the popup harder to read.
    if (/do not pay again/i.test(detail)) return { tone: "warning", message: detail };
    return { tone: "warning", message: detail ? `${detail} ${UNRESOLVED}` : UNRESOLVED };
  }
  if (input.state === "rejected") {
    if (/try again safely/i.test(detail)) return { tone: "error", message: detail };
    return { tone: "error", message: detail ? `${detail} ${REJECTED}` : REJECTED };
  }
  if (input.state === "closed") {
    // Already active, or the attempt is closed: retrying would be wrong.
    return {
      tone: "warning",
      message: detail || "This payment is already closed. Refresh Billing to see the current state.",
    };
  }
  return { tone: "error", message: detail || START_FAILED };
}

export interface PaymentStatusInput {
  status: "pending" | "success" | "failed" | "ignored" | "unresolved";
  message?: string | null;
}

/** The result of a read-only status check or reconciliation. */
export function describePaymentStatus(input: PaymentStatusInput): Feedback {
  const detail = text(input.message);
  switch (input.status) {
    case "success":
      return { tone: "success", message: detail || VERIFIED };
    case "failed":
      return {
        tone: "error",
        message: detail || "That payment was not completed. No money was taken.",
      };
    case "ignored":
      return { tone: "info", message: detail || "This payment needs no further action." };
    case "unresolved":
    case "pending":
    default:
      return { tone: "warning", message: detail || PENDING };
  }
}

/** The tone of an inline readiness notice (never a credential). */
export function readinessTone(enabled: boolean): FeedbackTone {
  return enabled ? "success" : "warning";
}
