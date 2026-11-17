"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  checkBillingPaymentAction,
  startBillingPaymentAction,
  type BillingOverview,
} from "@/lib/actions/billing.actions";

const PROVIDERS = [
  { value: "mtn", label: "MTN Mobile Money" },
  { value: "atl", label: "ATMoney / AirtelTigo" },
  { value: "vod", label: "Telecel Cash" },
] as const;

type Provider = (typeof PROVIDERS)[number]["value"];

function money(value: number | null, currency = "GHS") {
  if (value == null) return "—";
  return `${currency === "GHS" ? "GH₵" : currency + " "}${value.toLocaleString("en-GH", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function date(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function statusLabel(overview: BillingOverview) {
  switch (overview.lifecycle) {
    case "pending_payment":
      return "Payment required";
    case "active":
      return "Active";
    case "grace_period":
      return "Grace period";
    case "suspended":
      return "Suspended";
    default:
      return "No subscription";
  }
}

export default function BillingClient({ overview }: { overview: BillingOverview }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>("mtn");
  const [phone, setPhone] = useState("");
  const [planChoice, setPlanChoice] = useState<string>(
    overview.plan?.code ?? overview.availablePlans[0]?.code ?? ""
  );

  const payable = overview.payableSubscriptionId != null;
  const canRenew = overview.lifecycle === "active" || overview.lifecycle === "grace_period" || overview.lifecycle === "suspended";
  const selectedPlan = overview.availablePlans.find((plan) => plan.code === planChoice) ?? null;

  async function pay(method: "hosted" | "mobile_money", planCode?: string) {
    setError(null);
    setNotice(null);
    setReference(null);
    setBusy(true);
    try {
      const target = planCode
        ? ({ planCode, method } as const)
        : payable
          ? method === "hosted"
            ? ({ subscriptionId: overview.payableSubscriptionId!, method: "hosted" } as const)
            : ({ subscriptionId: overview.payableSubscriptionId!, method: "mobile_money", phone, provider } as const)
          : null;
      if (!target) {
        setError("There is nothing to pay right now.");
        return;
      }
      const result = await startBillingPaymentAction(
        target.method === "mobile_money"
          ? ({ ...target, method: "mobile_money", phone, provider } as never)
          : (target as never)
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.authorizationUrl) {
        window.location.href = result.authorizationUrl;
        return;
      }
      setReference(result.reference ?? null);
      setNotice(
        result.displayText ||
          result.message ||
          "Approve the payment prompt on your phone. This page will confirm automatically once the payment is verified."
      );
    } finally {
      setBusy(false);
    }
  }

  async function checkStatus() {
    if (!reference) return;
    setBusy(true);
    try {
      const result = await checkBillingPaymentAction(reference);
      setNotice(result.message);
      if (result.status === "success") {
        router.refresh();
      }
      if (result.status === "failed") setError("That payment was not completed. No money was taken.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Subscription & Billing</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">{overview.tenantName}</h1>
          <p className="mt-1 text-sm text-slate-600">
            Manage your MaaCash package, see what you have paid, and renew when a period ends.
          </p>
        </div>
        <Link href="/admin/zeli-analytics" className="btn btn-secondary btn-sm">
          Open Zeli
        </Link>
      </header>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {notice}
          {reference && (
            <button type="button" onClick={checkStatus} className="ml-3 underline" disabled={busy}>
              Check status
            </button>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Current plan</p>
          <p className="mt-2 text-lg font-semibold text-slate-900">{overview.plan?.name ?? "No plan yet"}</p>
          <p className="mt-1 text-sm text-slate-600">
            {overview.billingTerm === "annual" ? "Annual billing" : "Monthly billing"}
          </p>
        </div>
        <div className="card bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Status</p>
          <p className="mt-2 text-lg font-semibold text-slate-900">{statusLabel(overview)}</p>
          <p className="mt-1 text-sm text-slate-600">
            {overview.lifecycle === "grace_period" && overview.graceEndsAt
              ? `Access continues until ${date(overview.graceEndsAt)}`
              : overview.periodEnd
                ? `Renews ${date(overview.periodEnd)}`
                : "Nothing to renew yet"}
          </p>
        </div>
        <div className="card bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {payable ? "Amount due now" : "Next payment"}
          </p>
          <p className="mt-2 text-lg font-semibold text-slate-900">
            {money(payable ? overview.amountDueNow : overview.nextAmount)}
          </p>
          <p className="mt-1 text-sm text-slate-600">
            {overview.plan ? `${overview.plan.name} · ${overview.billingTerm}` : "Choose a package to start"}
          </p>
        </div>
        <div className="card bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Zeli this month</p>
          <p className="mt-2 text-lg font-semibold text-slate-900">
            {overview.zeli.blocked ? "Paused" : `${overview.zeli.used} / ${overview.zeli.limit}`}
          </p>
          <p className="mt-1 text-sm text-slate-600">
            {overview.zeli.blocked ? overview.zeli.blocked.message : `Resets ${date(overview.zeli.resetAt)}`}
          </p>
        </div>
      </div>

      {overview.founding && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="text-sm font-semibold text-amber-900">Founding customer offer</h2>
          <p className="mt-1 text-sm text-amber-900">
            {overview.founding.active
              ? `You pay ${money(overview.founding.monthlyPrice)} for ${overview.founding.remainingPeriods} more monthly period${
                  overview.founding.remainingPeriods === 1 ? "" : "s"
                }. Standard pricing (${money(overview.founding.standardPrice)}) applies from the next renewal after that.`
              : `Your founding periods are complete. Standard pricing (${money(overview.founding.standardPrice)}) now applies.`}
          </p>
          <p className="mt-1 text-xs text-amber-800">
            Used {overview.founding.periodsUsed} of {overview.founding.periodsGranted} discounted periods.
          </p>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card bg-white p-5">
          <h2 className="text-base font-semibold text-slate-900">What is included</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-600">Locations</dt>
              <dd className="font-medium text-slate-900">
                {overview.entitlements.locations}
                {overview.plan?.locationLimit != null ? ` of ${overview.plan.locationLimit}` : ""}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-600">Active staff</dt>
              <dd className="font-medium text-slate-900">
                {overview.entitlements.staff}
                {overview.plan?.staffLimit != null ? ` of ${overview.plan.staffLimit}` : ""}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-600">Zeli AI</dt>
              <dd className="font-medium text-slate-900">Included in your package</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-600">Support</dt>
              <dd className="font-medium text-slate-900">{overview.plan?.supportLevel ?? "Standard"}</dd>
            </div>
          </dl>
          {overview.zeli.blocked && (
            <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700">{overview.zeli.blocked.message}</p>
          )}
        </section>

        <section className="card bg-white p-5">
          <h2 className="text-base font-semibold text-slate-900">
            {payable ? "Complete your payment" : canRenew ? "Renew your subscription" : "Start a subscription"}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Pay with Ghana mobile money. Access is activated only after the payment is verified by MaaCash — never from a
            screenshot or a browser message.
          </p>
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="text-slate-700">Mobile money network</span>
              <select
                className="input mt-1 w-full"
                value={provider}
                onChange={(event) => setProvider(event.target.value as Provider)}
              >
                {PROVIDERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-slate-700">Mobile money number</span>
              <input
                className="input mt-1 w-full"
                inputMode="tel"
                placeholder="024 000 0000"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn btn-primary w-full"
              disabled={busy || phone.trim().length < 9}
              onClick={() => pay("mobile_money")}
            >
              {busy ? "Starting…" : `Pay ${money(payable ? overview.amountDueNow : overview.nextAmount)} with mobile money`}
            </button>
            <button
              type="button"
              className="btn btn-secondary w-full"
              disabled={busy}
              onClick={() => pay("hosted")}
            >
              Pay by card
            </button>
          </div>

          {!payable && canRenew && (
            <div className="mt-5 border-t border-slate-200 pt-4">
              <label className="block text-sm">
                <span className="text-slate-700">Change package for the next period</span>
                <select
                  className="input mt-1 w-full"
                  value={planChoice}
                  onChange={(event) => setPlanChoice(event.target.value)}
                >
                  {overview.availablePlans.map((plan) => (
                    <option key={plan.code} value={plan.code}>
                      {plan.name} · {money(plan.price)} / {plan.billingInterval}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-secondary mt-3 w-full"
                disabled={busy || !selectedPlan}
                onClick={() => pay("mobile_money", planChoice)}
              >
                {busy ? "Starting…" : `Pay ${money(selectedPlan?.price ?? null)} for ${selectedPlan?.name ?? "the selected plan"}`}
              </button>
            </div>
          )}
        </section>
      </div>

      <section className="card bg-white p-5">
        <h2 className="text-base font-semibold text-slate-900">Payment history</h2>
        {overview.history.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No payments yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Plan</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Period</th>
                  <th className="py-2">Receipt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {overview.history.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 text-slate-700">{date(row.paidAt ?? row.createdAt)}</td>
                    <td className="py-2 pr-4 text-slate-900">
                      {row.planName}
                      {row.foundingApplied && <span className="ml-2 text-xs text-amber-700">Founding</span>}
                    </td>
                    <td className="py-2 pr-4 text-slate-900">{money(row.amount, row.currency)}</td>
                    <td className="py-2 pr-4 text-slate-700">{row.status}</td>
                    <td className="py-2 pr-4 text-slate-600">
                      {row.periodStart ? `${date(row.periodStart)} – ${date(row.periodEnd)}` : "—"}
                    </td>
                    <td className="py-2">
                      {row.paidAt ? (
                        <Link className="text-brand-700 underline" href={`/admin/billing/receipt/${row.id}`}>
                          View
                        </Link>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
