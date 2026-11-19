"use client";

import { useEffect } from "react";

/**
 * Tell the original MaaCash billing tab that the Paystack tab came back.
 *
 * `storage` events are delivered to every other same-origin tab, so the billing
 * tab can verify the same reference and refresh without polling or opening
 * anything. The value contains no payment data beyond the public reference and
 * a coarse status.
 */
export default function CheckoutReturnSignal({
  reference,
  status,
}: {
  reference: string | null;
  status: string;
}) {
  useEffect(() => {
    if (!reference) return;
    try {
      window.localStorage.setItem(
        "maacash:paystack-return",
        JSON.stringify({ reference, status, at: Date.now() })
      );
    } catch {
      // Storage may be unavailable (private mode); the billing tab still checks
      // payment status on focus/visibility.
    }
  }, [reference, status]);

  return null;
}
