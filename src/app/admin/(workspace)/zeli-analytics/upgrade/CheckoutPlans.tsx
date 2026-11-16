"use client";

import { useState } from "react";
import { CheckCircle2, CreditCard, Loader2, Smartphone } from "lucide-react";
import {
  checkZeliMobileMoneyPayment,
  startZeliCheckout,
  startZeliMobileMoneyCheckout,
  startZeliTrial,
} from "@/lib/actions/zeli-billing.actions";

const MOBILE_MONEY_NETWORKS = [
  { code: "mtn", label: "MTN MoMo" },
  { code: "atl", label: "ATMoney / Airtel Money" },
  { code: "vod", label: "Telecel Cash" },
] as const;

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
  const [momoNetwork, setMomoNetwork] = useState<string>("mtn");
  const [momoPhone, setMomoPhone] = useState("");
  const [momoBusy, setMomoBusy] = useState(false);
  const [momoReference, setMomoReference] = useState<string | null>(null);
  const [momoStatus, setMomoStatus] = useState<string>("");
  const [momoPending, setMomoPending] = useState(false);

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

  async function startMobileMoney() {
    if (!selected) return;
    setMomoBusy(true);
    setError("");
    setMomoStatus("");
    setMomoReference(null);
    setMomoPending(false);
    try {
      const result = await startZeliMobileMoneyCheckout({
        planCode: selected,
        phone: momoPhone,
        provider: momoNetwork,
      });
      if (!result.success || !result.data) {
        setError(result.error ?? "The mobile money request could not be started.");
        return;
      }
      setMomoReference(result.data.reference);
      setMomoPending(true);
      setMomoStatus(
        result.data.displayText ??
          result.data.message ??
          "Approve the payment prompt on your phone, then check the status here."
      );
    } catch {
      setError("The mobile money request could not be started. Please try again.");
    } finally {
      setMomoBusy(false);
    }
  }

  async function checkMobileMoney() {
    if (!momoReference) return;
    setMomoBusy(true);
    setError("");
    try {
      const result = await checkZeliMobileMoneyPayment(momoReference);
      if (result.success && result.data?.status === "success") {
        setMomoStatus("Payment confirmed. Your subscription is active.");
        setMomoPending(false);
        window.location.assign("/admin/zeli-analytics?subscription=active");
        return;
      }
      if (result.success) {
        setMomoStatus(
          "Still waiting for authorisation. Approve the prompt on your phone, then check again."
        );
        return;
      }
      setMomoStatus(result.error ?? "The payment was not completed. No charge was applied.");
      setMomoPending(false);
    } catch {
      setError("Payment status could not be checked. Please try again.");
    } finally {
      setMomoBusy(false);
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

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-brand-900">
          <Smartphone size={15} aria-hidden />
          Pay with Ghana mobile money
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          Choose your network and number. Paystack sends a prompt to your phone;
          you have 180 seconds to approve it. Your subscription activates only
          after the payment is verified.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="text-xs font-medium text-slate-700">
            Network
            <select
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              value={momoNetwork}
              onChange={(event) => setMomoNetwork(event.target.value)}
              disabled={momoBusy}
            >
              {MOBILE_MONEY_NETWORKS.map((network) => (
                <option key={network.code} value={network.code}>
                  {network.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-700">
            Mobile money number
            <input
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="0551234987"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              value={momoPhone}
              onChange={(event) => setMomoPhone(event.target.value)}
              disabled={momoBusy}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={startMobileMoney}
            className="btn btn-secondary"
            disabled={momoBusy || !selected || momoPhone.trim().length < 9}
          >
            {momoBusy && !momoReference ? (
              <Loader2 size={15} className="animate-spin" aria-hidden />
            ) : (
              <Smartphone size={15} aria-hidden />
            )}
            Send payment prompt
          </button>
          <button
            type="button"
            onClick={checkMobileMoney}
            className="btn btn-primary"
            disabled={momoBusy || !momoReference}
          >
            {momoBusy && momoReference ? (
              <Loader2 size={15} className="animate-spin" aria-hidden />
            ) : null}
            Check payment status
          </button>
        </div>
        {momoStatus && (
          <p
            className={`mt-3 rounded-lg px-3 py-2 text-sm ${
              momoPending ? "bg-amber-50 text-amber-900" : "bg-slate-50 text-slate-700"
            }`}
            role="status"
            aria-live="polite"
          >
            {momoStatus}
          </p>
        )}
      </section>
    </div>
  );
}
