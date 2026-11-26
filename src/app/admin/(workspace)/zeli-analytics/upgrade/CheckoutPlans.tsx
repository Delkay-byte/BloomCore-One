"use client";

import { useState } from "react";
import { CheckCircle2, CreditCard, Loader2, ShieldCheck } from "lucide-react";
import { startZeliCheckout, startZeliTrial } from "@/lib/actions/zeli-billing.actions";
import {
  navigateCheckoutTab,
  openBlankCheckoutTab,
  type CheckoutTab,
} from "@/lib/payments/checkout-window";
import PaymentMethodSelector from "@/components/billing/PaymentMethodSelector";
import type { HostedCheckoutChannel } from "@/lib/payments/checkout-url";

export interface CheckoutPlan {
  code: string;
  name: string;
  description: string | null;
  billingInterval: string;
  price: number;
  currency: string;
  features: string[];
  usageAllowance: number | null;
  trialDays: number;
}

/**
 * Package checkout for the Zeli Analytics page.
 *
 * Every method is chosen on Paystack's hosted checkout. The blank tab is opened
 * synchronously inside the click so a popup blocker can never leave a created
 * transaction without a window, and the original page stays open.
 */
export default function CheckoutPlans({
  plans,
  paymentConfigured,
  providerMessage,
  channels,
}: {
  plans: CheckoutPlan[];
  paymentConfigured: boolean;
  providerMessage: string;
  channels: HostedCheckoutChannel[];
}) {
  const [selected, setSelected] = useState<string | null>(plans[0]?.code ?? null);
  const [channel, setChannel] = useState<HostedCheckoutChannel>("mobile_money");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function trial() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const result = await startZeliTrial(selected);
      if (!result.success) {
        setError(result.error ?? "The trial could not be started.");
        return;
      }
      window.location.assign("/admin/zeli-analytics");
    } finally {
      setBusy(false);
    }
  }

  async function checkout() {
    if (!selected || busy) return;

    const tab: CheckoutTab | null = openBlankCheckoutTab();
    if (!tab) {
      setError(
        "Your browser blocked the Paystack checkout tab. Allow pop-ups for this site, then try again. Nothing has been charged."
      );
      return;
    }

    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await startZeliCheckout(selected, channel);
      if (!result.success || !result.data?.authorizationUrl) {
        try {
          tab.close();
        } catch {
          // The tab may already be gone.
        }
        setError(result.error ?? "Checkout could not be started.");
        return;
      }
      const navigation = navigateCheckoutTab(tab, result.data.authorizationUrl);
      if (navigation === "untrusted") {
        try {
          tab.close();
        } catch {
          // The tab may already be gone.
        }
        setError("The payment provider returned an untrusted checkout address. No money was taken.");
        return;
      }
      if (navigation === "closed") {
        setNotice(
          "The Paystack tab was closed before it opened. Use Check payment status in Billing to reopen the same checkout."
        );
        return;
      }
      setNotice(
        "Paystack checkout has opened in a new tab. Complete your payment there, then return here and check the payment status."
      );
    } catch {
      try {
        tab.close();
      } catch {
        // The tab may already be gone.
      }
      setError("Checkout could not be started. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!paymentConfigured) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        {providerMessage}
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
        No Zeli Analytics package is currently published. The platform
        administrator configures the catalogue and approved prices.
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="zeli-checkout">
      <div className="grid gap-3 sm:grid-cols-2">
        {plans.map((plan) => (
          <label
            key={plan.code}
            className={`cursor-pointer rounded-xl border p-4 transition-colors ${
              selected === plan.code
                ? "border-brand-700 bg-brand-50/60 ring-1 ring-brand-700"
                : "border-slate-200 bg-white hover:border-brand-300"
            }`}
          >
            <input
              type="radio"
              name="zeli-plan"
              className="sr-only"
              value={plan.code}
              checked={selected === plan.code}
              onChange={() => setSelected(plan.code)}
            />
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold text-brand-900">{plan.name}</p>
                <p className="text-xs text-slate-500">
                  Billed every {plan.billingInterval}
                  {plan.trialDays > 0 ? ` · ${plan.trialDays}-day trial policy` : ""}
                </p>
              </div>
              <p className="whitespace-nowrap text-lg font-bold text-brand-900">
                {plan.currency} {plan.price.toFixed(2)}
              </p>
            </div>
            {plan.description && (
              <p className="mt-2 text-sm text-slate-600">{plan.description}</p>
            )}
            {plan.features.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-slate-600">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-1.5">
                    <CheckCircle2 size={12} className="mt-0.5 text-emerald-600" aria-hidden />
                    {feature}
                  </li>
                ))}
              </ul>
            )}
            {plan.usageAllowance != null && (
              <p className="mt-2 text-xs text-slate-500">
                Usage allowance: {plan.usageAllowance} assistant requests per day.
              </p>
            )}
          </label>
        ))}
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">
          {notice}
        </p>
      )}

      {selected && plans.find((plan) => plan.code === selected)?.trialDays ? (
        <button type="button" onClick={trial} className="btn btn-secondary mr-2" disabled={busy}>
          Start {plans.find((plan) => plan.code === selected)?.trialDays}-day trial
        </button>
      ) : null}
      <PaymentMethodSelector
        channels={channels}
        value={channel}
        onChange={setChannel}
        disabled={busy}
      />
      <button
        type="button"
        onClick={() => void checkout()}
        className="btn btn-primary"
        disabled={busy || !selected}
        aria-busy={busy}
      >
        {busy ? (
          <Loader2 size={15} className="animate-spin" aria-hidden />
        ) : (
          <CreditCard size={15} aria-hidden />
        )}
        {busy ? "Opening Paystack…" : "Pay securely with Paystack"}
      </button>
      <p className="text-xs text-slate-500">
        Payments are processed securely by Paystack. Your subscription will be activated once your
        payment has been successfully verified. You will see the applicable amount before confirming
        your payment. Paystack opens in a new tab, so this page stays open.
      </p>
      <p className="flex items-start gap-1.5 text-xs text-slate-500">
        <ShieldCheck size={13} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
        Any mobile-money code or PIN is entered on Paystack&apos;s checkout, never inside MaaCash.
      </p>
    </div>
  );
}
