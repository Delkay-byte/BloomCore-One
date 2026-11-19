"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { submitAccountEnquiry } from "@/lib/actions/account-enquiry.actions";
import { ENQUIRY_PACKAGES } from "@/lib/pricing/catalogue";
import TurnstileWidget from "@/components/security/TurnstileWidget";
import { ACCOUNT_ENQUIRY_ACTION } from "@/lib/security/turnstile-actions";

/**
 * Public enquiry form.
 *
 * One component serves both public entry points — the pricing page's account
 * enquiry and the contact page's demonstration request — and both submit to the
 * same server action and AccountEnquiry table. There is deliberately no second
 * enquiry pipeline.
 *
 * The Turnstile widget is part of the form. Its token lands in the form data as
 * `turnstileToken` and the server verifies it with Cloudflare before anything is
 * stored. A token is single use, so every failed submission requests a fresh
 * challenge instead of replaying the previous one.
 *
 * The form never creates a tenant, a login or a subscription, and the
 * confirmation says exactly that.
 */
export default function PricingEnquiryForm({
  defaultPlan,
  variant = "account",
  planContext,
}: {
  defaultPlan?: string;
  variant?: "account" | "demo";
  /** Package pre-selected on the pricing page, e.g. "Business". */
  planContext?: string;
}) {
  const isDemo = variant === "demo";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reference, setReference] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const token = String(form.get("turnstileToken") ?? "").trim();
    setError("");

    if (siteKey && !token) {
      setError("Complete the security check above, then send the request.");
      return;
    }

    setBusy(true);
    try {
      const result = await submitAccountEnquiry({
        businessName: String(form.get("businessName") ?? ""),
        contactName: String(form.get("contactName") ?? ""),
        phone: String(form.get("phone") ?? ""),
        email: String(form.get("email") ?? ""),
        locationCount: String(form.get("locationCount") ?? ""),
        interestedPlan: String(form.get("interestedPlan") ?? ""),
        modules: String(form.get("modules") ?? ""),
        message: String(form.get("message") ?? ""),
        turnstileToken: token || null,
        kind: isDemo ? "demo" : "account",
      });
      if (!result.success) {
        setError(result.error ?? "The request could not be sent.");
        // A submitted token is spent: ask Cloudflare for a new challenge.
        setResetSignal((value) => value + 1);
        return;
      }
      setReference(result.reference ?? "SENT");
    } catch {
      setError("The request could not be sent. Please try again.");
      setResetSignal((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  if (reference) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5" role="status">
        <p className="font-semibold text-emerald-900">
          {isDemo
            ? "Your demonstration request has been received."
            : "Enquiry received"}
        </p>
        <p className="mt-1 text-sm text-emerald-800">
          Your reference is <strong>{reference}</strong>. BloomCore Technologies
          will review the request and contact you using the details you supplied.
          {isDemo
            ? " No appointment has been booked yet, and no workspace has been created."
            : " No account has been created yet, and nothing has been charged."}
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
        Email{isDemo ? " (optional)" : ""}
        <input
          name="email"
          type="email"
          required={!isDemo}
          autoComplete="email"
          placeholder="owner@business.com"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <span className="mt-1 block text-xs font-normal text-slate-500">
          {isDemo
            ? "Add an email if you would like a written reply as well."
            : "The business owner signs in with this address, so it is required."}
        </span>
      </label>
      <label className="text-sm font-medium text-slate-700">
        Number of locations{isDemo ? "" : " (optional)"}
        <input
          name="locationCount"
          type="number"
          min={1}
          max={100}
          required={isDemo}
          inputMode="numeric"
          placeholder="1"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <label className="text-sm font-medium text-slate-700">
        Interested package
        <select
          name="interestedPlan"
          defaultValue={defaultPlan ?? planContext ?? "Not sure yet"}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          {ENQUIRY_PACKAGES.map((plan) => (
            <option key={plan} value={plan}>
              {plan}
            </option>
          ))}
        </select>
      </label>
      {isDemo && (
        <label className="text-sm font-medium text-slate-700 sm:col-span-2">
          What do you want to manage?
          <select
            name="modules"
            required
            defaultValue=""
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="" disabled>
              Select mobile money, Susu, or both
            </option>
            <option value="momo">Mobile money</option>
            <option value="susu">Susu collections</option>
            <option value="both">Mobile money and Susu</option>
          </select>
        </label>
      )}
      <label className="text-sm font-medium text-slate-700 sm:col-span-2">
        {isDemo
          ? "Anything else we should know? (optional)"
          : "What would you like to manage? (optional)"}
        <textarea
          name="message"
          rows={3}
          maxLength={2000}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          placeholder={
            isDemo
              ? "How you run mobile money and Susu today, staff numbers, and the best time to reach you."
              : "MoMo operations, Susu collections, number of staff, anything else we should know."
          }
        />
      </label>

      <div className="sm:col-span-2">
        <TurnstileWidget action={ACCOUNT_ENQUIRY_ACTION} resetSignal={resetSignal} />
      </div>

      {error && (
        <p className="sm:col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      )}

      <div className="sm:col-span-2">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Send size={15} aria-hidden />}
          {busy
            ? "Sending request…"
            : isDemo
              ? "Request a demonstration"
              : "Send enquiry"}
        </button>
        <p className="mt-2 text-xs text-slate-500">
          This sends a request only. It does not create an account, a login or a
          subscription, and no payment is taken.
        </p>
      </div>
    </form>
  );
}
