"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CreditCard,
  Loader2,
  Smartphone,
  Sparkles,
} from "lucide-react";
import {
  cancelScheduledPlanChangeAction,
  checkBillingPaymentAction,
  schedulePlanChangeAction,
  selectPackageAction,
  startBillingPaymentAction,
  type BillingOverview,
} from "@/lib/actions/billing.actions";

const PROVIDERS = [
  { value: "mtn", label: "MTN Mobile Money" },
  { value: "atl", label: "ATMoney / AirtelTigo" },
  { value: "vod", label: "Telecel Cash" },
] as const;

type Provider = (typeof PROVIDERS)[number]["value"];
type Plan = BillingOverview["availablePlans"][number];

/** Never show a full wallet number back to the customer: keep a verifiable tail. */
function maskPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 6) return null;
  return `${digits.slice(0, 3)} ${"•".repeat(Math.max(0, digits.length - 5))}${digits.slice(-2)}`;
}

function money(value: number | null, currency = "GHS") {
  if (value == null) return "—";
  return `${currency === "GHS" ? "GH₵" : currency + " "}${value.toLocaleString("en-GH", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function date(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
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
      return "No package selected";
  }
}

/** Zeli requests per month come from the central catalogue. */
const zeliLabel = (plan: Plan) =>
  plan.usageAllowance ? `${plan.usageAllowance.toLocaleString("en-GH")} Zeli requests / month` : "Zeli included";

export default function BillingClient({
  overview,
  paymentRequired = false,
}: {
  overview: BillingOverview;
  paymentRequired?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>("mtn");
  const [phone, setPhone] = useState("");

  const [term, setTerm] = useState<"monthly" | "annual">(
    overview.billingTerm === "annual" ? "annual" : "monthly"
  );
  const [selectedCode, setSelectedCode] = useState<string | null>(overview.plan?.code ?? null);
  const [showPay, setShowPay] = useState(overview.lifecycle === "pending_payment");
  const [pendingSubscriptionId, setPendingSubscriptionId] = useState<string | null>(
    overview.payableSubscriptionId
  );

  const plans = useMemo(() => {
    // Catalogue rows use month|year; the toggle uses monthly|annual.
    const interval = term === "annual" ? "year" : "month";
    return overview.availablePlans.filter((plan) => plan.billingInterval === interval);
  }, [overview.availablePlans, term]);
  const selectedPlan = overview.availablePlans.find((plan) => plan.code === selectedCode) ?? null;
  const manageable = overview.lifecycle === "active" || overview.lifecycle === "grace_period";
  const sameAsCurrent = manageable && selectedPlan?.code === overview.plan?.code;

  const monthlyPlans = overview.availablePlans.filter((plan) => plan.billingInterval === "month");

  function annualSaving(plan: Plan) {
    const monthly = monthlyPlans.find((row) => row.name.replace(" Annual", "") === plan.name.replace(" Annual", ""));
    if (!monthly || plan.billingInterval !== "year") return 0;
    return Math.max(0, monthly.price * 12 - plan.price);
  }

  function usageFits(plan: Plan) {
    const tooManyLocations = plan.locationLimit !== null && overview.entitlements.locations > plan.locationLimit;
    const tooMuchStaff = plan.staffLimit !== null && overview.entitlements.staff > plan.staffLimit;
    return !tooManyLocations && !tooMuchStaff;
  }

  function priceFor(plan: Plan) {
    const monthly = plan.billingInterval === "month";
    const founding = monthly && overview.foundingEligible ? plan.foundingPrice : null;
    return { now: founding ?? plan.price, founding, standard: plan.price };
  }

  async function choosePackage() {
    if (!selectedPlan) {
      setError("Choose a package first.");
      return;
    }
    setError(null);
    setNotice(null);

    if (manageable) {
      setBusy(true);
      try {
        const result = await schedulePlanChangeAction({ planCode: selectedPlan.code });
        if (!result.ok) {
          setError(result.error ?? "The package change could not be scheduled.");
          return;
        }
        setNotice(
          `Package change scheduled for your next renewal: ${selectedPlan.name}. The current period you have paid for is unchanged.`
        );
        router.refresh();
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const selected = await selectPackageAction({ planCode: selectedPlan.code });
      if (!selected.ok) {
        setError(selected.error ?? "The package could not be selected.");
        return;
      }
      if (selected.subscriptionId) setPendingSubscriptionId(selected.subscriptionId);
      setShowPay(true);
    } finally {
      setBusy(false);
    }
  }

  // Bounded verification after a mobile money prompt. Paystack allows the
  // customer up to 180 seconds to authorise, so the page checks a few times
  // with a growing delay instead of hammering the provider. The owner can also
  // check manually at any time.
  useEffect(() => {
    if (!reference) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delays = [10, 20, 30, 30, 30, 30, 30];
    let attempt = 0;

    const schedule = () => {
      if (cancelled || attempt >= delays.length) return;
      timer = setTimeout(async () => {
        if (cancelled) return;
        const result = await checkBillingPaymentAction(reference).catch(() => null);
        if (cancelled) return;
        if (result?.status === "success") {
          setNotice(result.message);
          setReference(null);
          router.refresh();
          return;
        }
        if (result?.status === "failed") {
          setError("That payment was not completed. No money was taken.");
          setReference(null);
          return;
        }
        if (result?.message) setNotice(result.message);
        attempt += 1;
        schedule();
      }, delays[attempt] * 1000);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [reference, router]);

  async function pay(method: "hosted" | "mobile_money") {
    if (!pendingSubscriptionId) {
      setError("Choose a package, then continue to payment.");
      return;
    }
    setError(null);
    setNotice(null);
    setReference(null);
    setBusy(true);
    try {
      const result =
        method === "hosted"
          ? await startBillingPaymentAction({ subscriptionId: pendingSubscriptionId, method: "hosted" })
          : await startBillingPaymentAction({
              subscriptionId: pendingSubscriptionId,
              method: "mobile_money",
              phone,
              provider,
            });
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
          "Approve the payment prompt on your phone. This page confirms automatically once MaaCash verifies the payment."
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
      if (result.status === "success") router.refresh();
      if (result.status === "failed") setError("That payment was not completed. No money was taken.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelScheduled() {
    setBusy(true);
    try {
      await cancelScheduledPlanChangeAction();
      setNotice("Scheduled package change cancelled.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const amountDue = pendingSubscriptionId
    ? overview.amountDueNow ?? overview.nextAmount
    : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Subscription &amp; Billing</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">{overview.tenantName}</h1>
          <p className="mt-1 text-sm text-slate-600">
            Choose a package, pay securely, and see exactly what your business is entitled to.
          </p>
        </div>
        <Link href="/zeli" className="btn btn-secondary btn-sm">
          <Sparkles size={14} aria-hidden /> Open Zeli
        </Link>
      </header>

      {paymentRequired && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong className="font-semibold">Complete your first payment to start operations.</strong>{" "}
          Your workspace is ready, but daily accounts, contributions and Zeli become available once
          MaaCash verifies your first payment. You can choose or change the package below.
        </div>
      )}

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

      {/* Current position */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Current package</p>
          <p className="mt-2 text-lg font-semibold text-slate-900">{overview.plan?.name ?? "None yet"}</p>
          <p className="mt-1 text-sm text-slate-600">
            {overview.plan ? (overview.billingTerm === "annual" ? "Annual billing" : "Monthly billing") : "Choose below"}
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
                : "No paid period yet"}
          </p>
        </div>
        <div className="card bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {overview.lifecycle === "pending_payment" ? "Amount due now" : "Next payment"}
          </p>
          <p className="mt-2 text-lg font-semibold text-slate-900">
            {money(amountDue ?? overview.nextAmount)}
          </p>
          <p className="mt-1 text-sm text-slate-600">
            {overview.plan ? `${overview.plan.name}` : "Select a package to see the price"}
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

      {overview.scheduled && (
        <section className="rounded-xl border border-indigo-200 bg-indigo-50 p-5">
          <h2 className="text-sm font-semibold text-indigo-950">Scheduled package change</h2>
          <p className="mt-1 text-sm text-indigo-900">
            From your next renewal: <strong>{overview.scheduled.planName}</strong> (
            {overview.scheduled.billingTerm}) at {money(overview.scheduled.price)}. The period you have
            already paid for is unchanged.
          </p>
          <button
            type="button"
            onClick={cancelScheduled}
            className="mt-2 text-xs font-medium text-indigo-800 underline"
            disabled={busy}
          >
            Cancel scheduled change
          </button>
        </section>
      )}

      {overview.founding && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="text-sm font-semibold text-amber-900">Founding customer offer</h2>
          <p className="mt-1 text-sm text-amber-900">
            {overview.founding.active
              ? `You pay ${money(overview.founding.monthlyPrice)} per month for ${overview.founding.remainingPeriods} more monthly period${
                  overview.founding.remainingPeriods === 1 ? "" : "s"
                }, then ${money(overview.founding.standardPrice)} from the next renewal.`
              : `Your founding periods are complete. Standard pricing (${money(
                  overview.founding.standardPrice
                )}) applies from the next renewal.`}
          </p>
          <p className="mt-1 text-xs text-amber-800">
            {overview.founding.periodsUsed} of {overview.founding.periodsGranted} discounted periods used.
          </p>
        </section>
      )}

      {/* Package selector */}
      {(
        <section className="card bg-white p-5" aria-labelledby="package-heading">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="package-heading" className="text-base font-semibold text-slate-900">
                {manageable ? "Change package" : "Choose a MaaCash package to get started"}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {manageable
                  ? "A change takes effect at your next renewal. Nothing is charged now."
                  : "Pick the package that fits your business, then continue to payment."}
              </p>
            </div>
            <div className="inline-flex rounded-lg border border-slate-200 p-1" role="group" aria-label="Billing term">
              {(["monthly", "annual"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setTerm(value);
                    setSelectedCode(null);
                  }}
                  aria-pressed={term === value}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                    term === value ? "bg-brand-700 text-white" : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {value === "monthly" ? "Monthly" : "Annual"}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {plans.map((plan) => {
              const { now, founding, standard } = priceFor(plan);
              const selected = selectedCode === plan.code;
              const fits = usageFits(plan);
              const saving = annualSaving(plan);
              return (
                <button
                  key={plan.code}
                  type="button"
                  onClick={() => setSelectedCode(plan.code)}
                  aria-pressed={selected}
                  className={`relative rounded-xl border p-4 text-left transition-colors ${
                    selected
                      ? "border-brand-600 bg-brand-50/60 ring-2 ring-brand-600"
                      : "border-slate-200 bg-white hover:border-brand-300"
                  }`}
                >
                  {selected && (
                    <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-brand-700 px-2 py-0.5 text-[11px] font-semibold text-white">
                      <Check size={11} aria-hidden /> Selected
                    </span>
                  )}
                  <p className="text-sm font-semibold text-slate-900">{plan.name}</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-900">
                    {money(now)}
                    <span className="text-sm font-normal text-slate-600">
                      /{plan.billingInterval === "year" ? "year" : "month"}
                    </span>
                  </p>
                  {founding != null && (
                    <p className="mt-1 text-xs font-medium text-amber-800">
                      Founding price {money(founding)} for the first 3 paid monthly periods, then{" "}
                      {money(standard)} from the 4th renewal.
                    </p>
                  )}
                  {saving > 0 && (
                    <p className="mt-1 text-xs font-medium text-emerald-700">
                      Saves {money(saving)} a year ({money(Math.round(plan.price / 12))}/month equivalent).
                    </p>
                  )}
                  <ul className="mt-3 space-y-1.5 text-sm text-slate-700">
                    <li>
                      {plan.locationLimit === null
                        ? "Unlimited locations"
                        : `${plan.locationLimit} location${plan.locationLimit === 1 ? "" : "s"}`}
                    </li>
                    <li>
                      {plan.staffLimit === null
                        ? "Unlimited staff accounts"
                        : `${plan.staffLimit} staff account${plan.staffLimit === 1 ? "" : "s"}`}
                    </li>
                    <li>{zeliLabel(plan)}</li>
                    <li>{plan.supportLevel ?? "Standard"} support</li>
                  </ul>
                  {!fits && (
                    <p className="mt-3 inline-flex items-start gap-1 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
                      Your current {overview.entitlements.locations} location
                      {overview.entitlements.locations === 1 ? "" : "s"} and{" "}
                      {overview.entitlements.staff} staff exceed this package. Nothing is deleted; choose a
                      larger package or reduce usage first.
                    </p>
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !selectedPlan || sameAsCurrent}
              onClick={choosePackage}
            >
              {busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : null}
              {sameAsCurrent
                ? "This is your current package"
                : manageable
                  ? `Schedule ${selectedPlan?.name ?? "package"} from next renewal`
                  : "Continue to payment"}
            </button>
            {!overview.foundingEligible && term === "monthly" && (
              <p className="text-xs text-slate-500">
                The founding-customer price applies only to businesses already assigned one of the five
                founding places. It cannot be combined with annual billing.
              </p>
            )}
          </div>
        </section>
      )}

      {manageable && overview.plan && (
        <section className="card bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">{overview.plan?.name}</h2>
              <p className="mt-1 text-sm text-slate-600">
                {overview.billingTerm === "annual" ? "Annual billing" : "Monthly billing"} · renews{" "}
                {date(overview.periodEnd)}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() =>
                document.getElementById("package-heading")?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            >
              Change package
            </button>
          </div>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4 rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-slate-600">Locations used</dt>
              <dd className="font-medium text-slate-900">
                {overview.entitlements.locations}
                {overview.plan?.locationLimit != null ? ` of ${overview.plan.locationLimit}` : ""}
              </dd>
            </div>
            <div className="flex justify-between gap-4 rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-slate-600">Active staff</dt>
              <dd className="font-medium text-slate-900">
                {overview.entitlements.staff}
                {overview.plan?.staffLimit != null ? ` of ${overview.plan.staffLimit}` : ""}
              </dd>
            </div>
            <div className="flex justify-between gap-4 rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-slate-600">Zeli allowance</dt>
              <dd className="font-medium text-slate-900">
                {overview.plan?.usageAllowance
                  ? `${overview.plan.usageAllowance.toLocaleString("en-GH")} / month`
                  : "Included"}
              </dd>
            </div>
            <div className="flex justify-between gap-4 rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-slate-600">Next payment</dt>
              <dd className="font-medium text-slate-900">{money(overview.nextAmount)}</dd>
            </div>
          </dl>
        </section>
      )}

      {/* Payment */}
      {showPay && !manageable && (
        <section className="card bg-white p-5">
          <h2 className="text-base font-semibold text-slate-900">Pay for {selectedPlan?.name ?? overview.plan?.name}</h2>
          <p className="mt-1 text-sm text-slate-700">
            Amount due: <strong>{money(amountDue)}</strong>
            {overview.billingTerm === "annual" ? " for one year" : " for one month"}
            {overview.payableReference && (
              <>
                {" · "}Reference <span className="font-mono text-xs">{overview.payableReference}</span>
              </>
            )}
          </p>
          <p className="mt-1 text-sm text-slate-600">
            Pay with Ghana mobile money or a card. Access is activated only after MaaCash verifies the
            payment with the provider — never from a screenshot or a browser message.
          </p>

          {overview.providerReady && overview.providerMode === "live" && overview.localLiveTest && (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-semibold">Live payment — real money</p>
              <p className="mt-1">
                This workspace holds a live Paystack key in a local test process. You will be charged
                the amount shown below in Ghana cedis on your mobile money wallet. MaaCash activates
                access only after the provider confirms the payment.
              </p>
            </div>
          )}

          {overview.providerReady && overview.providerMode === "test" && (
            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
              Test mode: your Paystack test key is active, so you can complete a checkout without
              moving real money. Live activation needs the live key.
            </p>
          )}

          {!overview.providerReady ? (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <p className="font-medium text-slate-900">Online payments are not connected yet</p>
              <p className="mt-1">
                This workspace cannot take card or mobile money payments until the payment provider is
                connected. Your package selection is saved, and no money has been taken.
              </p>
            </div>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="space-y-3">
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
                <p className="text-xs text-slate-600">
                  {maskPhone(phone)
                    ? `You are about to authorise ${money(amountDue)} on ${
                        PROVIDERS.find((option) => option.value === provider)?.label
                      } for ${maskPhone(phone)}.`
                    : "Enter the mobile money number that will receive the payment prompt."}
                </p>
                <button
                  type="button"
                  className="btn btn-primary w-full"
                  disabled={busy || phone.trim().length < 9}
                  onClick={() => pay("mobile_money")}
                >
                  <Smartphone size={15} aria-hidden />
                  {busy ? "Starting…" : `Pay ${money(amountDue)} with mobile money`}
                </button>
              </div>
              <div className="space-y-3">
                <div className="rounded-lg border border-slate-200 p-3 text-sm text-slate-700">
                  <p className="font-medium text-slate-900">Pay by card</p>
                  <p className="mt-1 text-xs text-slate-600">
                    You will be taken to the provider&apos;s secure checkout and returned here afterwards.
                  </p>
                  <button
                    type="button"
                    className="btn btn-secondary mt-3 w-full"
                    disabled={busy}
                    onClick={() => pay("hosted")}
                  >
                    <CreditCard size={15} aria-hidden /> Pay by card
                  </button>
                </div>
                {pendingSubscriptionId && (
                  <button
                    type="button"
                    className="text-xs font-medium text-brand-700 underline"
                    onClick={() => setShowPay(false)}
                    disabled={busy}
                  >
                    Change the selected package
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* History */}
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
                  <th className="py-2 pr-4">Package</th>
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

      <p className="flex items-center gap-2 text-xs text-slate-500">
        <CheckCircle2 size={13} aria-hidden />
        Package changes never delete records. If your usage does not fit a smaller package, MaaCash tells you
        before anything changes.
      </p>
    </div>
  );
}
