"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Loader2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  cancelScheduledPlanChangeAction,
  checkBillingPaymentAction,
  schedulePlanChangeAction,
  selectPackageAction,
  type BillingOverview,
} from "@/lib/actions/billing.actions";
import { useToast } from "@/components/ui/Toast";
import {
  describePaymentFailure,
  describePaymentStatus,
} from "@/lib/billing/feedback";
import Modal, { ConfirmDialog } from "@/components/ui/Modal";
import PaymentMethodSelector from "@/components/billing/PaymentMethodSelector";
import type { HostedCheckoutChannel } from "@/lib/payments/checkout-url";
import {
  navigateCheckoutTab,
  openBlankCheckoutTab,
  type CheckoutTab,
} from "@/lib/payments/checkout-window";

type Plan = BillingOverview["availablePlans"][number];
type BusyAction = "select" | "schedule" | "replace" | "pay" | "status" | "cancel" | null;

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
  const toast = useToast();

  const [busy, setBusy] = useState<BusyAction>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [selectionAmount, setSelectionAmount] = useState<number | null>(overview.amountDueNow);
  // The pending intent the owner is paying for. It changes only after the server
  // confirms a selection or replacement — browsing the cards never changes it.
  const [selectionIntent, setSelectionIntent] = useState<{ planName: string; amount: number | null } | null>(
    null
  );
  // Trusted Paystack URL for reopening the existing checkout without creating
  // another transaction. It is never navigated to automatically.
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(
    overview.payableAction?.requiredAction === "checkout"
      ? overview.payableAction.checkoutUrl
      : null
  );
  const [checkoutChannel, setCheckoutChannel] = useState<HostedCheckoutChannel>(
    overview.payableAction?.channel ?? "mobile_money"
  );

  const [term, setTerm] = useState<"monthly" | "annual">(
    overview.billingTerm === "annual" ? "annual" : "monthly"
  );
  const [selectedCode, setSelectedCode] = useState<string | null>(overview.plan?.code ?? null);
  const [showPay, setShowPay] = useState(overview.lifecycle === "pending_payment");
  const [pendingSubscriptionId, setPendingSubscriptionId] = useState<string | null>(
    overview.payableSubscriptionId
  );
  // The verification form is deliberately not tied to the payment panel's
  // scroll position: it is a fixed dialog that can open on load, after a
  // `send_otp` charge, or when a status check reveals the provider is waiting.
  const initialOtp =
    overview.payableAction?.requiredAction === "otp" ? overview.payableAction : null;
  const [otpOpen, setOtpOpen] = useState(Boolean(initialOtp));
  const [otpReference, setOtpReference] = useState<string | null>(initialOtp?.reference ?? null);
  const [otpValue, setOtpValue] = useState("");
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpHint, setOtpHint] = useState<string | null>(initialOtp?.displayText ?? null);
  // One in-flight payment request at a time. The backend also refuses a second
  // provider call for the same reference, so this is convenience, not safety.
  const payLock = useRef(false);
  const lastReturnCheck = useRef(0);
  const [replaceRequest, setReplaceRequest] = useState<{
    planCode: string;
    planName: string;
    existing: { planName: string; billingTerm: string; amount: number; reference: string };
  } | null>(null);

  const plans = useMemo(() => {
    // Catalogue rows use month|year; the toggle uses monthly|annual.
    const interval = term === "annual" ? "year" : "month";
    return overview.availablePlans.filter((plan) => plan.billingInterval === interval);
  }, [overview.availablePlans, term]);
  const selectedPlan = overview.availablePlans.find((plan) => plan.code === selectedCode) ?? null;
  const manageable = overview.lifecycle === "active" || overview.lifecycle === "grace_period";
  const sameAsCurrent = manageable && selectedPlan?.code === overview.plan?.code;
  // The package already has a payable intent. Selecting it again must reopen
  // the existing checkout, never create a second reference.
  const pendingForSelected =
    !manageable &&
    overview.lifecycle === "pending_payment" &&
    Boolean(selectedPlan) &&
    selectedPlan?.code === overview.plan?.code;

  const monthlyPlans = overview.availablePlans.filter((plan) => plan.billingInterval === "month");

  const statusReference = reference ?? overview.payableReference;

  const fail = (message: string) => toast.push("error", message);
  const warn = (message: string) => toast.push("warning", message);
  const info = (message: string) => toast.push("info", message);
  const succeed = (message: string) => toast.push("success", message);

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
    if (busy) return;
    if (!selectedPlan) {
      fail("Choose a package first.");
      return;
    }

    if (manageable) {
      setBusy("schedule");
      try {
        const result = await schedulePlanChangeAction({ planCode: selectedPlan.code });
        if (!result.ok) {
          fail(result.error ?? "The package change could not be scheduled.");
          return;
        }
        succeed(
          `Package change scheduled for your next renewal: ${result.scheduled?.planName ?? selectedPlan.name}. The period you have already paid for is unchanged.`
        );
        router.refresh();
      } catch {
        fail("The package change could not be scheduled. Please try again.");
      } finally {
        setBusy(null);
      }
      return;
    }

    if (pendingForSelected) {
      // Reopen the existing checkout with its existing reference.
      setShowPay(true);
      info(
        `Your pending payment${overview.payableReference ? ` (reference ${overview.payableReference})` : ""} was kept. Nothing new was created.`
      );
      return;
    }

    setBusy("select");
    try {
      const selected = await selectPackageAction({ planCode: selectedPlan.code });
      if (!selected.ok && selected.needsConfirmation && selected.existing) {
        setReplaceRequest({
          planCode: selectedPlan.code,
          planName: selectedPlan.name,
          existing: selected.existing,
        });
        return;
      }
      if (!selected.ok) {
        fail(selected.error ?? "The package could not be selected.");
        return;
      }
      if (selected.subscriptionId) setPendingSubscriptionId(selected.subscriptionId);
      if (selected.amount != null) setSelectionAmount(selected.amount);
      setSelectionIntent({ planName: selectedPlan.name, amount: selected.amount ?? null });
      setReference(null);
      setShowPay(true);
      succeed(
        `${selectedPlan.name} selected for ${money(
          selected.amount ?? priceFor(selectedPlan).now
        )}.${selected.reference ? ` Payment reference ${selected.reference}.` : ""} Nothing has been charged yet.`
      );
      router.refresh();
    } catch {
      fail("The package could not be selected. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function confirmReplacement() {
    if (!replaceRequest || busy) return;
    setBusy("replace");
    try {
      const result = await selectPackageAction({
        planCode: replaceRequest.planCode,
        confirmReplace: true,
      });
      if (!result.ok) {
        // The dialog stays open so the owner can retry or keep the old intent.
        fail(result.error ?? "The package could not be changed.");
        return;
      }
      const replacedFrom = replaceRequest.existing.reference;
      setReplaceRequest(null);
      setPendingSubscriptionId(result.subscriptionId ?? null);
      if (result.amount != null) setSelectionAmount(result.amount);
      setSelectionIntent({ planName: replaceRequest.planName, amount: result.amount ?? null });
      setReference(null);
      setShowPay(true);
      succeed(
        `Package changed to ${replaceRequest.planName}. The old reference ${replacedFrom} was released and a new reference ${result.reference ?? "is on file"} was created for ${money(
          result.amount ?? null
        )}. Nothing has been charged yet.`
      );
      router.refresh();
    } catch {
      fail("The package could not be changed. The existing payment reference was kept.");
    } finally {
      setBusy(null);
    }
  }

  function keepExistingIntent() {
    const kept = replaceRequest?.existing.reference ?? overview.payableReference;
    setReplaceRequest(null);
    // Nothing about the payable intent changed, so the displayed plan, the
    // selected card and the amount snap back to the intent that is pending.
    setSelectionIntent(null);
    setSelectionAmount(overview.amountDueNow ?? overview.nextAmount);
    setSelectedCode(overview.plan?.code ?? null);
    info(
      `Kept your existing payment reference${kept ? ` ${kept}` : ""}. Nothing was changed and nothing was charged.`
    );
  }

  // Bounded verification after a mobile money prompt. Paystack allows the
  // customer up to 180 seconds to authorise, so the page checks a few times
  // with a growing delay instead of hammering the provider. The owner can also
  // check manually at any time.
  useEffect(() => {
    // Hosted checkout is verified when the customer returns (focus, visibility
    // or the cross-tab signal), not by polling. Polling here would query an
    // unfinished checkout while the customer is still on Paystack.
    if (!reference || checkoutUrl) return;
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
          succeed(result.message);
          setReference(null);
          router.refresh();
          return;
        }
        if (result?.status === "failed") {
          setOtpOpen(false);
          fail(result.message || "That payment was not completed. No money was taken.");
          setReference(null);
          return;
        }
        if (result?.requiredAction === "otp") {
          // The provider is waiting for a code even if the form was closed.
          openOtp(reference, result.displayText ?? result.message ?? null);
        }
        attempt += 1;
        schedule();
      }, delays[attempt] * 1000);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference, checkoutUrl, router]);

  // The Paystack checkout is a different tab. When the customer comes back,
  // or when that tab writes the return signal, verify the same reference again
  // so this tab can show the confirmed state without a manual reload.
  useEffect(() => {
    function checkAfterReturn() {
      const target = reference ?? overview.payableReference;
      if (!target) return;
      const now = Date.now();
      if (now - lastReturnCheck.current < 10_000) return;
      lastReturnCheck.current = now;
      void (async () => {
        const result = await checkBillingPaymentAction(target).catch(() => null);
        if (!result) return;
        if (result.status === "success") {
          setReference(null);
          setOtpOpen(false);
          setOtpValue("");
          setCheckoutUrl(null);
          succeed("Payment verified. Your subscription is active.");
          router.refresh();
          return;
        }
        if (result.status === "failed") {
          setCheckoutUrl(null);
        }
      })();
    }
    function onStorage(event: StorageEvent) {
      if (event.key === "maacash:paystack-return") checkAfterReturn();
    }
    function onVisible() {
      if (document.visibilityState === "visible") checkAfterReturn();
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference, overview.payableReference, router]);

  function openOtp(ref: string, hint: string | null) {
    if (!ref) return;
    // Reopening for the same reference (for example when the status poll finds
    // the provider is still waiting) must never erase what the owner is typing.
    if (otpReference !== ref) {
      setOtpReference(ref);
      setOtpValue("");
      setOtpError(null);
    }
    if (hint) setOtpHint(hint);
    setOtpOpen(true);
  }

  function closeOtp() {
    if (otpBusy) return;
    setOtpOpen(false);
    // The code is dropped from component state on every close. It is never
    // kept for a retry, written to storage or put in a toast.
    setOtpValue("");
    setOtpError(null);
  }

  async function payWithPaystack() {
    if (payLock.current || busy) return;
    if (!pendingSubscriptionId) {
      fail("Choose a package, then continue to payment.");
      return;
    }

    // Open the tab BEFORE awaiting the backend. A popup blocker can only be
    // satisfied from the synchronous user gesture, and we must never create a
    // Paystack transaction without a window the customer can use.
    const tab: CheckoutTab | null = openBlankCheckoutTab();
    if (!tab) {
      warn(
        "Your browser blocked the Paystack checkout tab. Allow pop-ups for this site, then press Pay securely with Paystack again. Nothing has been charged."
      );
      return;
    }

    payLock.current = true;
    setBusy("pay");
    try {
      const response = await fetch("/api/billing/pay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subscriptionId: pendingSubscriptionId,
          method: "hosted",
          channel: checkoutChannel,
        }),
      });
      const result = (await response.json().catch(() => null)) as
        | {
            ok: boolean;
            error?: string;
            state?: string;
            reference?: string;
            authorizationUrl?: string;
            message?: string | null;
          }
        | null;

      if (!result) {
        try {
          tab.close();
        } catch {
          // The tab may already be gone.
        }
        fail(
          "The payment could not be started. No money was taken. Use Check payment status before trying again."
        );
        return;
      }

      if (!result.ok || !result.authorizationUrl) {
        try {
          tab.close();
        } catch {
          // The tab may already be gone.
        }
        const feedback = describePaymentFailure(result);
        toast.push(feedback.tone, feedback.message);
        if (result.state === "unresolved") {
          setReference(result.reference ?? overview.payableReference);
        }
        if (result.state === "rejected") {
          setReference(null);
          router.refresh();
        }
        return;
      }

      // Never navigate anywhere the server did not derive and approve.
      const navigation = navigateCheckoutTab(tab, result.authorizationUrl);
      if (navigation === "untrusted") {
        try {
          tab.close();
        } catch {
          // The tab may already be gone.
        }
        fail(
          "The payment provider returned an untrusted checkout address. No money was taken."
        );
        return;
      }

      setReference(result.reference ?? null);
      setCheckoutUrl(result.authorizationUrl);

      if (navigation === "closed") {
        // The customer closed the blank tab while we waited. Keep the existing
        // transaction and offer it through the explicit recovery link.
        info(
          "The Paystack tab was closed before it opened. Use Open Paystack checkout to continue this same payment."
        );
        return;
      }
      info(
        "Paystack checkout has opened in a new tab. Complete your payment there, then return here to check your payment status."
      );
    } catch {
      try {
        tab.close();
      } catch {
        // The tab may already be gone.
      }
      fail(
        "MaaCash could not reach the payment service. No money was taken. If you are unsure, use Check payment status before trying again."
      );
    } finally {
      setBusy(null);
      payLock.current = false;
    }
  }

  async function checkStatus(target?: string) {
    if (busy) return;
    const ref = target ?? statusReference;
    if (!ref) {
      warn("There is no payment to check yet. Choose a package and continue to payment.");
      return;
    }
    setBusy("status");
    try {
      const result = await checkBillingPaymentAction(ref);
      const feedback = describePaymentStatus(result);
      toast.push(feedback.tone, feedback.message);
      if (result.status === "success") {
        setReference(null);
        setOtpOpen(false);
        setOtpValue("");
        setCheckoutUrl(null);
        router.refresh();
        return;
      }
      if (result.requiredAction === "otp") {
        openOtp(ref, result.displayText ?? result.message ?? null);
      }
      if (result.status === "failed") {
        setReference(null);
        setCheckoutUrl(null);
        router.refresh();
      }
    } catch {
      fail("We could not check the payment status yet. This check never starts a new charge.");
    } finally {
      setBusy(null);
    }
  }

  async function submitOtp() {
    if (otpBusy || busy) return;
    const ref = otpReference;
    if (!ref) {
      setOtpError("There is no payment waiting for a code. Check the payment status first.");
      return;
    }
    const code = otpValue.replace(/[\s-]/g, "");
    if (!/^\d{4,10}$/.test(code)) {
      setOtpError("Enter the verification code Paystack sent to your phone.");
      return;
    }
    setOtpError(null);
    // Drop the code from state before the request leaves the browser. Only the
    // local `code` binding below holds it, and it is never rendered or logged.
    setOtpValue("");
    setOtpBusy(true);
    try {
      const response = await fetch("/api/billing/payments/submit-otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference: ref, otp: code }),
      });
      const result = (await response.json().catch(() => null)) as
        | {
            ok: boolean;
            status?: "success" | "pending" | "requires_action" | "failed";
            code?: string;
            error?: string;
            message?: string;
            state?: string;
            displayText?: string | null;
            requiredAction?: "otp" | "phone_prompt" | "offline" | "checkout" | null;
          }
        | null;
      if (!result) {
        setOtpError(
          "The code could not be submitted. Do not pay again: use Check payment status first."
        );
        return;
      }
      if (!result.ok) {
        if (result.state === "unresolved" || result.code === "charge_unresolved") {
          setOtpOpen(false);
          setReference(ref);
          warn(result.error || "We could not confirm the code with Paystack. Do not pay again.");
          router.refresh();
          return;
        }
        if (
          result.code === "already_active" ||
          result.code === "not_payable" ||
          result.code === "otp_not_expected" ||
          result.code === "not_found"
        ) {
          setOtpOpen(false);
          warn(result.error || "This payment is no longer waiting for a code.");
          router.refresh();
          return;
        }
        // invalid_otp, rate_limited and validation failures keep the form open
        // so the owner can correct the code; the attempt stays unchanged.
        setOtpError(result.error || "That verification code was not accepted. Try again.");
        return;
      }
      if (result.status === "success") {
        setOtpOpen(false);
        setReference(null);
        succeed(result.message || "Payment verified. Your subscription is active.");
        router.refresh();
        return;
      }
      if (result.requiredAction === "otp" && result.status === "requires_action") {
        // Paystack asked for another code. Keep the same reference and panel.
        setOtpHint(result.displayText ?? result.message ?? null);
        info(result.message || "Paystack sent another verification code to your phone.");
        return;
      }
      // The provider moved on to a phone prompt, another offline step, or a
      // confirmed failure. Close the code form and keep watching the payment.
      setOtpOpen(false);
      if (result.status === "failed") {
        fail(result.message || "The payment was not completed. No money was taken.");
        setReference(null);
        router.refresh();
        return;
      }
      setReference(ref);
      info(
        result.message ||
          "MaaCash is waiting for Paystack to confirm the payment. Do not pay again."
      );
    } catch {
      setOtpError(
        "MaaCash could not reach the payment service. Do not pay again: check the payment status first."
      );
    } finally {
      setOtpBusy(false);
    }
  }

  async function cancelScheduled() {
    if (busy) return;
    setBusy("cancel");
    try {
      const result = await cancelScheduledPlanChangeAction();
      if (!result.ok) {
        fail(result.error ?? "The scheduled package change could not be cancelled.");
        return;
      }
      succeed("Scheduled package change cancelled. Your current package is unchanged.");
      router.refresh();
    } catch {
      fail("The scheduled package change could not be cancelled. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  const amountDue = pendingSubscriptionId
    ? selectionIntent?.amount ?? selectionAmount ?? overview.amountDueNow ?? overview.nextAmount
    : selectionAmount ?? null;
  // With a pending intent, the payable plan is the source of truth. A card the
  // owner is merely browsing must never relabel the amount that is actually due.
  const payingForName = pendingSubscriptionId
    ? selectionIntent?.planName ?? overview.plan?.name ?? selectedPlan?.name ?? null
    : selectedPlan?.name ?? overview.plan?.name ?? null;

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
            {payingForName ?? "Select a package to see the price"}
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
            className="mt-2 inline-flex items-center gap-2 text-xs font-medium text-indigo-800 underline disabled:opacity-60"
            disabled={busy !== null}
          >
            {busy === "cancel" && <Loader2 size={12} className="animate-spin" aria-hidden />}
            Cancel scheduled change
          </button>
        </section>
      )}

      {overview.renewalNotice && (
        <section
          className="rounded-xl border border-sky-200 bg-sky-50 p-5"
          data-testid="renewal-price-notice"
        >
          <h2 className="text-sm font-semibold text-sky-900">Your renewal price</h2>
          <p className="mt-1 text-sm text-sky-900">
            You are paying {money(overview.renewalNotice.currentAmount)}{" "}
            {overview.plan?.billingInterval === "year" ? "a year" : "a month"}. From{" "}
            {overview.renewalNotice.effectiveAt
              ? new Date(overview.renewalNotice.effectiveAt).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })
              : "your next renewal"}{" "}
            the catalogue price is{" "}
            {money(overview.renewalNotice.renewalAmount)}. Nothing has been charged, and
            the period you have already paid for is not shortened.
          </p>
          <p className="mt-1 text-xs text-sky-800">
            Zeli now includes an external assistant with every paid package, and the
            platform gained offline MoMo operations, a closed evidence trail, branch
            liquidity forecasting and shared risk intelligence. If you would rather not
            renew at the new price, cancel the renewal from this page before the period
            ends and keep access until then.
          </p>
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
            disabled={busy !== null || !selectedPlan || sameAsCurrent}
            onClick={choosePackage}
            aria-busy={busy === "select" || busy === "schedule"}
          >
            {busy === "select" || busy === "schedule" ? (
              <Loader2 size={15} className="animate-spin" aria-hidden />
            ) : null}
            {sameAsCurrent
              ? "This is your current package"
              : manageable
                ? `Schedule ${selectedPlan?.name ?? "package"} from next renewal`
                : pendingForSelected
                  ? "Continue with the pending payment"
                  : "Continue to payment"}
          </button>
          {overview.payableReference && !manageable && (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => checkStatus(overview.payableReference ?? undefined)}
                disabled={busy !== null}
                aria-busy={busy === "status"}
              >
                {busy === "status" ? <Loader2 size={15} className="animate-spin" aria-hidden /> : null}
                Check payment status
              </button>
              {overview.payableAction?.requiredAction === "otp" && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() =>
                    openOtp(
                      overview.payableAction?.reference ?? "",
                      overview.payableAction?.displayText ?? null
                    )
                  }
                  disabled={busy !== null}
                >
                  Finish earlier direct-charge payment
                </button>
              )}
            </>
          )}
          {!overview.foundingEligible && term === "monthly" && (
            <p className="text-xs text-slate-500">
              The founding-customer price applies only to businesses already assigned one of the five
              founding places. It cannot be combined with annual billing.
            </p>
          )}
        </div>
      </section>

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
        <section className="card bg-white p-5" aria-labelledby="payment-heading">
          <h2 id="payment-heading" className="text-base font-semibold text-slate-900">
            Pay for {payingForName ?? "your package"}
          </h2>
          <p className="mt-1 text-sm text-slate-700">
            Amount due: <strong>{money(amountDue)}</strong>
            {overview.billingTerm === "annual" ? " for one year" : " for one month"}
            {statusReference && (
              <>
                {" · "}Reference <span className="font-mono text-xs">{statusReference}</span>
              </>
            )}
          </p>
          <p className="mt-1 text-sm text-slate-600">
            Payments are processed securely by Paystack. Your subscription will be activated once
            your payment has been successfully verified. You will see the applicable amount before
            confirming your payment.
          </p>

          {!overview.paymentsAvailable ? (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700" role="status">
              <p className="font-medium text-slate-900">Online payments are temporarily unavailable</p>
              <p className="mt-1">
                Your package selection is saved, and no money has been taken. Please try again
                later or contact support if this continues.
              </p>
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="rounded-xl border border-brand-200 bg-brand-50/50 p-4">
                <p className="text-sm font-medium text-slate-900">Pay securely with Paystack</p>
                <PaymentMethodSelector
                  channels={overview.checkoutChannels}
                  value={checkoutChannel}
                  onChange={setCheckoutChannel}
                  disabled={busy !== null || Boolean(checkoutUrl)}
                  lockedReason={
                    checkoutUrl
                      ? "A Paystack checkout is already open for this payment. Continue it with the method already chosen; changing the method would create a second payment."
                      : null
                  }
                />
                <button
                  type="button"
                  className="btn btn-primary mt-3 w-full sm:w-auto"
                  disabled={busy !== null}
                  onClick={() => void payWithPaystack()}
                  aria-busy={busy === "pay"}
                >
                  {busy === "pay" ? (
                    <Loader2 size={15} className="animate-spin" aria-hidden />
                  ) : (
                    <CreditCard size={15} aria-hidden />
                  )}
                  {busy === "pay" ? "Opening Paystack…" : "Pay securely with Paystack"}
                </button>
                <p className="mt-2 flex items-start gap-1.5 text-xs text-slate-600">
                  <ShieldCheck size={13} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
                  The checkout opens in a new tab, so this page stays open. Choose your method on
                  Paystack; any verification code or PIN is entered there, never inside MaaCash.
                </p>
              </div>

              {checkoutUrl && (
                <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                  <p className="font-medium">A Paystack checkout is already open for this payment</p>
                  <p className="mt-1 text-xs">
                    Reopen the same transaction. This never creates a second payment.
                  </p>
                  <a
                    href={checkoutUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-secondary btn-sm mt-2"
                  >
                    <ExternalLink size={14} aria-hidden /> Open Paystack checkout
                  </a>
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  className="text-xs font-medium text-brand-700 underline disabled:opacity-60"
                  onClick={() => checkStatus()}
                  disabled={busy !== null}
                  aria-busy={busy === "status"}
                >
                  Check payment status
                </button>
                {overview.payableAction?.requiredAction === "otp" && (
                  <button
                    type="button"
                    className="text-xs font-medium text-brand-700 underline disabled:opacity-60"
                    onClick={() =>
                      openOtp(
                        overview.payableAction?.reference ?? "",
                        overview.payableAction?.displayText ?? null
                      )
                    }
                    disabled={busy !== null}
                  >
                    Finish an earlier direct-charge payment
                  </button>
                )}
                {pendingSubscriptionId && (
                  <button
                    type="button"
                    className="text-xs font-medium text-brand-700 underline disabled:opacity-60"
                    onClick={() => setShowPay(false)}
                    disabled={busy !== null}
                  >
                    Change the selected package
                  </button>
                )}
              </div>
              <p className="text-xs text-slate-500">
                If a payment result looks uncertain, do not pay again. Check the payment status first
                so MaaCash can reconcile it with Paystack.
              </p>
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

      <Modal
        open={otpOpen}
        onClose={closeOtp}
        title="Enter the verification code"
        description="This form is only for a payment started with the earlier direct mobile-money flow. New payments are completed on Paystack's hosted checkout, which handles any code or PIN itself."
        size="sm"
        safeFocus
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={closeOtp}
              disabled={otpBusy}
            >
              Close
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void submitOtp()}
              disabled={otpBusy || otpValue.replace(/\D/g, "").length < 4}
              aria-busy={otpBusy}
            >
              {otpBusy ? (
                <>
                  <Loader2 size={15} className="animate-spin" aria-hidden /> Verifying…
                </>
              ) : (
                "Submit code"
              )}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Verification code</span>
            <input
              className="input mt-1 w-full text-center font-mono text-lg tracking-[0.4em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={10}
              value={otpValue}
              onChange={(event) =>
                setOtpValue(event.target.value.replace(/\D/g, "").slice(0, 10))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitOtp();
                }
              }}
              disabled={otpBusy}
              data-autofocus="true"
              aria-describedby="otp-hint"
              aria-invalid={otpError ? true : undefined}
            />
          </label>
          <p id="otp-hint" className="text-xs text-slate-600">
            {otpHint ??
              "The code is usually 4 to 6 digits. MaaCash never asks you to share it by email, chat or phone."}
          </p>
          {otpReference && (
            <p className="text-xs text-slate-500">
              Payment reference <span className="font-mono">{otpReference}</span>
            </p>
          )}
          {otpError && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
              {otpError}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              className="text-xs font-medium text-brand-700 underline disabled:opacity-60"
              onClick={() => void checkStatus(otpReference ?? undefined)}
              disabled={otpBusy || busy !== null}
            >
              Check payment status instead
            </button>
            <span className="text-xs text-slate-500">
              Lost the code? Close this form and check the payment status before trying again.
            </span>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={replaceRequest !== null}
        title="Replace the pending payment?"
        description={
          replaceRequest
            ? `${replaceRequest.existing.planName} already has a payment reference ${replaceRequest.existing.reference} for ${money(
                replaceRequest.existing.amount
              )}. Changing to ${replaceRequest.planName} cancels that reference and creates a new one. Nothing has been charged.`
            : undefined
        }
        confirmLabel="Replace and continue"
        cancelLabel="Keep the current reference"
        loading={busy === "replace"}
        safeCancelFocus
        onConfirm={confirmReplacement}
        onClose={keepExistingIntent}
      >
        {replaceRequest && (
          <p className="text-xs text-slate-500">
            Keeping the current reference leaves your pending payment exactly as it is. You can come
            back and change packages later.
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
