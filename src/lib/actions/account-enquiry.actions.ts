"use server";

import { headers } from "next/headers";
import { db } from "@/lib/db";
import { getClientIp } from "@/lib/security/client-ip";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { verifyTurnstile } from "@/lib/security/turnstile";
import { ACCOUNT_ENQUIRY_ACTION } from "@/lib/security/turnstile-actions";
import { logSecurityEvent } from "@/lib/security/log";
import {
  ENQUIRY_TYPES,
  validateEnquiry,
  type EnquiryDraft,
} from "@/lib/pricing/enquiry";
import { createNotification } from "@/lib/notifications/notifications";
import { sendTransactionalEmail, appBaseUrl } from "@/lib/email/resend";

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

/**
 * Both public forms — the pricing account enquiry and the demonstration
 * request — use this one action and one AccountEnquiry table. `kind` selects
 * the enquiry type and the wording of the notifications; it cannot change who
 * is authorised or what is created (nothing is).
 */
export type EnquiryKind = "account" | "demo";

export async function submitAccountEnquiry(
  input: EnquiryDraft & { turnstileToken?: string | null; kind?: EnquiryKind }
): Promise<AccountEnquiryResponse> {
  const kind: EnquiryKind = input?.kind === "demo" ? "demo" : "account";
  const isDemo = kind === "demo";
  const validated = validateEnquiry(input, {
    // A business account signs in with the email; a demonstration request may
    // be handled by phone only.
    requireEmail: !isDemo,
    requireLocationCount: isDemo,
    requireModules: isDemo,
  });
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
    action: ACCOUNT_ENQUIRY_ACTION,
    ip,
  });
  if (!turnstile.ok) {
    // Sanitized diagnostics only: category and Cloudflare error codes. The
    // token, the secret and the visitor's details are never logged.
    logSecurityEvent({
      event: "enquiry.turnstile_rejected",
      outcome: "blocked",
      actorType: "anonymous",
      reason: turnstile.reason ?? "rejected",
      detail: turnstile.errorCodes?.join(",") ?? undefined,
    });
    const retryHint =
      turnstile.reason === "replay" || turnstile.reason === "expired"
        ? "Please complete the security check again and resend."
        : "Please complete the check and try again.";
    return {
      success: false,
      error: `We could not verify this submission. ${retryHint}`,
    };
  }

  // A second click (or a resend after a slow response) must not create a second
  // lead. The token is already single use, so this guard covers the case where
  // the visitor solved a fresh challenge and submitted the same details again.
  const recentDuplicate = await db.accountEnquiry.findFirst({
    where: {
      businessName: validated.value.businessName,
      phone: validated.value.phone,
      createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (recentDuplicate) {
    return {
      success: true,
      reference: recentDuplicate.id.slice(-8).toUpperCase(),
    };
  }

  const enquiry = await db.accountEnquiry.create({
    data: {
      ...validated.value,
      status: "new",
      enquiryType: isDemo ? ENQUIRY_TYPES.demo : ENQUIRY_TYPES.account,
      source: isDemo ? "public-contact" : "public-pricing",
    },
  });

  const reference = enquiry.id.slice(-8).toUpperCase();

  // Platform Super Admin is notified in-app immediately. An enquiry never
  // creates an account, a tenant, a subscription or a charge.
  await createNotification({
    audience: "platform",
    kind: "system",
    severity: "attention",
    title: isDemo
      ? `New demonstration request: ${enquiry.businessName}`
      : `New account enquiry: ${enquiry.businessName}`,
    body: isDemo
      ? `${enquiry.contactName} asked for a MaaCash demonstration. Reference ${reference}. Contact the prospect, then provision only after they decide to proceed.`
      : `${enquiry.contactName} requested a MaaCash account. Reference ${reference}. Review the enquiry and provision only after confirming the business.`,
    href: "/platform/enquiries",
    dedupeKey: `enquiry:${enquiry.id}`,
  }).catch(() => undefined);

  const ownerEmail = process.env.PLATFORM_NOTIFICATION_EMAIL || process.env.CONTACT_EMAIL;
  if (ownerEmail) {
    const requestLabel = isDemo ? "demonstration request" : "account enquiry";
    const modules = enquiry.modules === "both" ? "Mobile money and Susu" : enquiry.modules === "susu" ? "Susu" : enquiry.modules === "momo" ? "Mobile money" : "not specified";
    // Delivery failures never invalidate the saved enquiry; the in-app
    // notification above is the primary channel.
    await sendTransactionalEmail({
      to: ownerEmail,
      subject: `New MaaCash ${requestLabel} (${reference})`,
      text: `${enquiry.businessName} (${enquiry.contactName}) submitted a MaaCash ${requestLabel}.
Reference: ${reference}
Phone: ${enquiry.phone}
Email: ${enquiry.email ?? "not provided"}
Locations: ${enquiry.locationCount ?? "not specified"}
Wants to manage: ${modules}
Plan interest: ${enquiry.interestedPlan ?? "not specified"}
Review: ${appBaseUrl()}/platform/enquiries

A request does not create an account, a subscription or a charge.`,
      html: `<p><strong>${enquiry.businessName}</strong> (${enquiry.contactName}) submitted a MaaCash ${requestLabel}.</p><p>Reference: <strong>${reference}</strong><br/>Phone: ${enquiry.phone}<br/>Email: ${enquiry.email ?? "not provided"}<br/>Locations: ${enquiry.locationCount ?? "not specified"}<br/>Wants to manage: ${modules}<br/>Plan interest: ${enquiry.interestedPlan ?? "not specified"}</p><p><a href="${appBaseUrl()}/platform/enquiries">Review the request</a></p><p>A request does not create an account, a subscription or a charge.</p>`,
      tag: isDemo ? "demo-request" : "account-enquiry",
    }).catch(() => undefined);
  }

  return { success: true, reference };
}
