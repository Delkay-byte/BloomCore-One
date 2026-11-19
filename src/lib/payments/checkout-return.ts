/**
 * Server-side Paystack return handler.
 *
 * Paystack redirects the customer back with the transaction reference. The
 * redirect itself proves nothing: the reference is verified with Paystack and
 * the subscription is fulfilled through the same idempotent service as the
 * signed webhook.
 *
 * This module deliberately does not require a tenant session. The checkout is
 * opened in a separate tab, so that tab may not carry the workspace tab session
 * even when the payment is genuine. No tenant data is returned or rendered by
 * this path; the reference plus the provider's verified answer is the only
 * authority.
 */

import { db } from "@/lib/db";
import { verifyAndFulfil } from "@/lib/payments/zeli-subscriptions";

export type CheckoutReturnStatus = "success" | "pending" | "failed" | "invalid";

export interface CheckoutReturnResult {
  status: CheckoutReturnStatus;
  reference: string | null;
  message: string;
}

const REFERENCE_PATTERN = /^[A-Za-z0-9._=-]{6,120}$/;

/** Verify the reference and report what Paystack actually says about it. */
export async function confirmHostedCheckoutReturn(
  reference: string
): Promise<CheckoutReturnResult> {
  if (!REFERENCE_PATTERN.test(reference)) {
    return {
      status: "invalid",
      reference: null,
      message: "This payment return link is not valid.",
    };
  }

  const subscription = await db.zeliSubscription.findUnique({
    where: { providerReference: reference },
    select: { id: true },
  });
  if (!subscription) {
    return {
      status: "invalid",
      reference,
      message: "No payment matches this reference.",
    };
  }

  try {
    const result = await verifyAndFulfil(reference, "hosted-return");
    switch (result.decision) {
      case "processed":
        return {
          status: "success",
          reference,
          message: "Payment confirmed. Your subscription is active.",
        };
      case "ignored":
        if (result.reason === "duplicate_reference" || result.reason === "duplicate_event") {
          return {
            status: "success",
            reference,
            message: "Payment confirmed. Your subscription is active.",
          };
        }
        if (result.reason === "not_successful") {
          return {
            status: "pending",
            reference,
            message:
              "Paystack has not confirmed this payment yet. If you completed checkout, wait a moment and check the payment status from Billing. Nothing was activated.",
          };
        }
        return {
          status: "pending",
          reference,
          message:
            "MaaCash is still processing this payment. Do not pay again; return to Billing and use Check payment status shortly.",
        };
      case "refund_requested":
        return {
          status: "failed",
          reference,
          message:
            "This payment belonged to a checkout that had already been replaced, so a refund has been requested. No new access was granted.",
        };
      case "exception":
      case "failed":
      default:
        return {
          status: "failed",
          reference,
          message:
            "This payment could not be verified against the selected package. No access was activated. Contact support with the reference before paying again.",
        };
    }
  } catch {
    return {
      status: "pending",
      reference,
      message:
        "MaaCash could not reach Paystack to confirm this payment yet. Do not pay again; return to Billing and use Check payment status.",
    };
  }
}
