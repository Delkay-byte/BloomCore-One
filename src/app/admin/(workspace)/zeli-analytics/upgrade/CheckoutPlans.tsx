"use client";

import { useState } from "react";
import { CheckCircle2, CreditCard, Loader2 } from "lucide-react";
import { startZeliCheckout, startZeliTrial } from "@/lib/actions/zeli-billing.actions";

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

export default function CheckoutPlans({
  plans,
  paymentConfigured,
  providerMessage,
}: {
  plans: CheckoutPlan[];
  paymentConfigured: boolean;
  providerMessage: string;
}) {
  const [selected, setSelected] = useState<string | null>(plans[0]?.code ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const result = await startZeliCheckout(selected);
      if (!result.success || !result.data) {
        setError(result.error ?? "Checkout could not be started.");
        return;
      }
      window.location.assign(result.data.authorizationUrl);
    } catch {
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

      {selected && plans.find((plan) => plan.code === selected)?.trialDays ? (
        <button type="button" onClick={trial} className="btn btn-secondary mr-2" disabled={busy}>
          Start {plans.find((plan) => plan.code === selected)?.trialDays}-day trial
        </button>
      ) : null}
      <button
        type="button"
        onClick={checkout}
        className="btn btn-primary"
        disabled={busy || !selected}
      >
        {busy ? (
          <Loader2 size={15} className="animate-spin" aria-hidden />
        ) : (
          <CreditCard size={15} aria-hidden />
        )}
        {busy ? "Opening secure checkout…" : "Continue to secure checkout"}
      </button>
      <p className="text-xs text-slate-500">
        Payment is processed by Paystack. Access is activated only after the
        server verifies the payment event; returning to this page alone does not
        grant access.
      </p>
    </div>
  );
}
