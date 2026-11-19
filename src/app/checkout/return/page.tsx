import Link from "next/link";
import { CheckCircle2, Clock, ShieldAlert } from "lucide-react";
import { confirmHostedCheckoutReturn } from "@/lib/payments/checkout-return";
import CheckoutReturnSignal from "@/components/payments/CheckoutReturnSignal";

export const dynamic = "force-dynamic";

/**
 * Public Paystack return page.
 *
 * The checkout opens in a new tab, so this page must not depend on the
 * workspace tab session. It renders only the provider-verified outcome and the
 * public reference; the original billing tab is notified through a
 * same-origin storage signal.
 */
export default async function HostedCheckoutReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ reference?: string; trxref?: string }>;
}) {
  const params = await searchParams;
  const reference = String(params.reference ?? params.trxref ?? "").trim();
  const result = await confirmHostedCheckoutReturn(reference);

  const succeeded = result.status === "success";
  const invalid = result.status === "invalid";
  const Icon = succeeded ? CheckCircle2 : invalid ? ShieldAlert : Clock;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-4 py-12">
      <div className="card w-full bg-white p-6">
        <CheckoutReturnSignal reference={result.reference} status={result.status} />
        <div
          className={`flex items-center gap-2 text-sm font-semibold ${
            succeeded ? "text-emerald-700" : invalid ? "text-red-700" : "text-amber-700"
          }`}
        >
          <Icon size={18} aria-hidden />
          {succeeded ? "Payment confirmed" : invalid ? "Payment not recognised" : "Payment not confirmed yet"}
        </div>
        <h1 className="mt-2 text-2xl font-bold text-brand-900">
          {succeeded ? "Your subscription is active" : "Return to MaaCash"}
        </h1>
        <p className="mt-2 text-sm text-slate-600" role="status">
          {result.message}
        </p>
        {result.reference && (
          <p className="mt-3 text-xs text-slate-500">
            Payment reference <span className="font-mono">{result.reference}</span>
          </p>
        )}
        <p className="mt-4 text-xs text-slate-500">
          Payments are processed securely by Paystack. Access is activated only after the payment has
          been successfully verified.
        </p>
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          You can close this tab and return to the MaaCash billing page. It stays open the whole time.
          If it has not refreshed, use <strong>Check payment status</strong> there.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link href="/admin/billing" className="btn btn-primary btn-sm">
            Open Billing
          </Link>
          <Link href="/admin/dashboard" className="btn btn-secondary btn-sm">
            Go to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
