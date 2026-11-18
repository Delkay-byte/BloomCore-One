/**
 * Account-enquiry validation (pure).
 *
 * Kept out of the `"use server"` module so the rules are testable without a
 * request context and cannot be invoked as a server action.
 */

import { normalizeGhanaPhone } from "@/lib/utils";
import { ENQUIRY_PACKAGES } from "@/lib/pricing/catalogue";

export interface EnquiryDraft {
  businessName?: unknown;
  contactName?: unknown;
  phone?: unknown;
  email?: unknown;
  locationCount?: unknown;
  interestedPlan?: unknown;
  message?: unknown;
}

export interface NormalizedEnquiry {
  businessName: string;
  contactName: string;
  phone: string;
  email: string;
  locationCount: number | null;
  interestedPlan: string | null;
  message: string | null;
}

export type EnquiryValidation =
  | { ok: true; value: NormalizedEnquiry }
  | { ok: false; error: string };

function text(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

export function validateEnquiry(input: EnquiryDraft): EnquiryValidation {
  const businessName = text(input?.businessName, 160);
  const contactName = text(input?.contactName, 120);
  const phoneInput = text(input?.phone, 40);
  const email = text(input?.email, 160).toLowerCase();
  const message = text(input?.message, 2000);
  const interestedPlan = text(input?.interestedPlan, 60);

  if (businessName.length < 2) {
    return { ok: false, error: "Enter your business name." };
  }
  if (contactName.length < 2) {
    return { ok: false, error: "Enter the name of the person we should contact." };
  }
  const phone = normalizeGhanaPhone(phoneInput).find((value) => /^0\d{9}$/.test(value));
  if (!phone) {
    return { ok: false, error: "Enter a valid Ghana phone number." };
  }
  // The business owner signs in with this address, so it cannot be optional.
  if (!email) {
    return {
      ok: false,
      error: "Enter the email address the business owner will sign in with.",
    };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  let locationCount: number | null = null;
  if (input?.locationCount !== undefined && input?.locationCount !== "") {
    const parsed = Number(input.locationCount);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      return { ok: false, error: "Enter the number of locations between 1 and 100." };
    }
    locationCount = parsed;
  }

  if (interestedPlan && !(ENQUIRY_PACKAGES as readonly string[]).includes(interestedPlan)) {
    return { ok: false, error: "Choose one of the listed packages." };
  }

  return {
    ok: true,
    value: {
      businessName,
      contactName,
      phone,
      email,
      locationCount,
      interestedPlan: interestedPlan || null,
      message: message || null,
    },
  };
}
