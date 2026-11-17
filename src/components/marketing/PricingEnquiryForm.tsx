"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { submitAccountEnquiry } from "@/lib/actions/account-enquiry.actions";
import { ENQUIRY_PACKAGES } from "@/lib/pricing/catalogue";

/**
 * Public account enquiry form. It never creates a tenant, a login or a
 * subscription, and the confirmation says exactly that.
 */
export default function PricingEnquiryForm({
  defaultPlan,
}: {
  defaultPlan?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reference, setReference] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await submitAccountEnquiry({
        businessName: String(form.get("businessName") ?? ""),
        contactName: String(form.get("contactName") ?? ""),
        phone: String(form.get("phone") ?? ""),
        email: String(form.get("email") ?? ""),
        locationCount: String(form.get("locationCount") ?? ""),
        interestedPlan: String(form.get("interestedPlan") ?? ""),
        message: String(form.get("message") ?? ""),
        turnstileToken: String(form.get("cf-turnstile-response") ?? "") || null,
      });
      if (!result.success) {
        setError(result.error ?? "The enquiry could not be sent.");
        return;
      }
      setReference(result.reference ?? "SENT");
    } catch {
      setError("The enquiry could not be sent. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (reference) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5" role="status">
        <p className="font-semibold text-emerald-900">Enquiry received</p>
        <p className="mt-1 text-sm text-emerald-800">
          Thank you. Your enquiry reference is <strong>{reference}</strong>. We will
          contact you about setting up your business. No account has been created
          yet, and nothing has been charged.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm font-medium text-slate-700">
        Business name
        <input
          name="businessName"
          required
          minLength={2}
          maxLength={160}
          autoComplete="organization"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="text-sm font-medium text-slate-700">
        Owner or contact name
        <input
          name="contactName"
          required
          minLength={2}
          maxLength={120}
          autoComplete="name"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="text-sm font-medium text-slate-700">
        Phone number
        <input
          name="phone"
          type="tel"
          inputMode="tel"
          required
          autoComplete="tel"
          placeholder="0551234987"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="text-sm font-medium text-slate-700">
        Email (optional)
        <input
          name="email"
          type="email"
          autoComplete="email"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="text-sm font-medium text-slate-700">
        Number of locations
        <input
          name="locationCount"
          type="number"
          min={1}
          max={100}
          inputMode="numeric"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="text-sm font-medium text-slate-700">
        Interested package
        <select
          name="interestedPlan"
          defaultValue={defaultPlan ?? "Not sure yet"}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          {ENQUIRY_PACKAGES.map((plan) => (
            <option key={plan} value={plan}>
              {plan}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm font-medium text-slate-700 sm:col-span-2">
        What would you like to manage? (optional)
        <textarea
          name="message"
          rows={3}
          maxLength={2000}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          placeholder="MoMo operations, Susu collections, number of staff, anything else we should know."
        />
      </label>

      {error && (
        <p className="sm:col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      )}

      <div className="sm:col-span-2">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Send size={15} aria-hidden />}
          {busy ? "Sending enquiry…" : "Send enquiry"}
        </button>
        <p className="mt-2 text-xs text-slate-500">
          This sends an enquiry only. It does not create an account, a login or a
          subscription, and no payment is taken.
        </p>
      </div>
    </form>
  );
}
