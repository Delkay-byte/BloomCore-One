"use server";

import { headers } from "next/headers";
import { db } from "@/lib/db";
import { getClientIp } from "@/lib/security/client-ip";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { validateEnquiry, type EnquiryDraft } from "@/lib/pricing/enquiry";

/**
 * Public account enquiry.
 *
 * A prospective business can ask for a MaaCash account without creating one.
 * Nothing here creates a tenant, a user, a subscription or a payment. The row is
 * a lead for Platform Super Admin, and the UI never claims an account exists.
 */

export interface AccountEnquiryResponse {
  success: boolean;
  error?: string;
  reference?: string;
}

export async function submitAccountEnquiry(
  input: EnquiryDraft & { turnstileToken?: string | null }
): Promise<AccountEnquiryResponse> {
  const validated = validateEnquiry(input);
  if (!validated.ok) {
    return { success: false, error: validated.error };
  }

  const headerList = await headers();
  const ip = getClientIp(headerList).ip;

  const ipLimit = await consumeRateLimit(
    "enquiry:ip",
    ip ?? "unknown",
    RATE_LIMITS.publicExpensive
  );
  if (!ipLimit.allowed) {
    return {
      success: false,
      error: "Too many enquiries from this connection. Please try again later.",
    };
  }

  const turnstile = await verifyTurnstile({
    token: input?.turnstileToken ?? null,
    action: "account_enquiry",
    ip,
  });
  if (!turnstile.ok) {
    return {
      success: false,
      error:
        "We could not verify this submission. Please complete the check and try again.",
    };
  }

  const enquiry = await db.accountEnquiry.create({
    data: {
      ...validated.value,
      status: "new",
      source: "public-pricing",
    },
  });

  // Non-sensitive reference the visitor can quote on a call.
  return { success: true, reference: enquiry.id.slice(-8).toUpperCase() };
}
