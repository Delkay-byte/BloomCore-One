"use client";

import { Building2, CreditCard, Smartphone } from "lucide-react";
import {
  HOSTED_CHECKOUT_CHANNEL_LABELS,
  type HostedCheckoutChannel,
} from "@/lib/payments/checkout-url";

const ICONS: Record<HostedCheckoutChannel, typeof Smartphone> = {
  mobile_money: Smartphone,
  card: CreditCard,
  bank_transfer: Building2,
};

const DESCRIPTIONS: Record<HostedCheckoutChannel, string> = {
  mobile_money: "Approve the payment on your phone.",
  card: "Pay with a debit or credit card.",
  bank_transfer: "Pay by bank transfer where your account supports it.",
};

/**
 * Payment-method choice before Paystack opens. Mobile Money is the default.
 *
 * The selection only changes which single channel MaaCash sends. It never
 * collects a PIN, OTP or wallet number and never creates a payment by itself.
 */
export default function PaymentMethodSelector({
  channels,
  value,
  onChange,
  disabled = false,
  lockedReason = null,
}: {
  channels: HostedCheckoutChannel[];
  value: HostedCheckoutChannel;
  onChange: (channel: HostedCheckoutChannel) => void;
  disabled?: boolean;
  lockedReason?: string | null;
}) {
  return (
    <fieldset className="mt-3" disabled={disabled}>
      <legend className="text-sm font-medium text-slate-900">Payment method</legend>
      <p className="mt-0.5 text-xs text-slate-600">
        Choose how you want to pay. The final authorisation happens on Paystack&apos;s
        secure checkout.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {channels.map((channel) => {
          const Icon = ICONS[channel];
          const checked = value === channel;
          return (
            <label
              key={channel}
              className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm transition ${
                checked
                  ? "border-brand-500 bg-brand-50/60 text-brand-900"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
              } ${disabled ? "cursor-not-allowed opacity-70" : ""}`}
            >
              <input
                type="radio"
                name="checkout-payment-method"
                value={channel}
                checked={checked}
                onChange={() => onChange(channel)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-medium">
                  <Icon size={14} aria-hidden /> {HOSTED_CHECKOUT_CHANNEL_LABELS[channel]}
                </span>
                <span className="mt-0.5 block text-xs text-slate-600">
                  {DESCRIPTIONS[channel]}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {lockedReason && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" role="status">
          {lockedReason}
        </p>
      )}
    </fieldset>
  );
}
