import Link from "next/link";
import { requireTenantAdmin } from "@/lib/tenant";
import { confirmZeliCheckout } from "@/lib/actions/zeli-billing.actions";

export const dynamic = "force-dynamic";

/**
 * Server-side checkout return. The browser redirect is not trusted: the
 * reference is re-verified with Paystack and the subscription is activated only
 * through the idempotent payment-event path.
 */
export default async function ZeliCheckoutCallbackPage({
  searchParams,
}: {
  searchParams: Promise<{ reference?: string }>;
}) {
  await requireTenantAdmin();
  const params = await searchParams;
  const reference = params.reference ?? "";
  const result = reference
    ? await confirmZeliCheckout(reference)
    : { success: false as const, error: "No payment reference was supplied." };

  return (
    <div className="mx-auto max-w-2xl py-10">
      <div className="card bg-white">
        <p className="text-xs font-semibold uppercase tracking-wider text-gold-600">
          Zeli Business Intelligence
        </p>
        <h1 className="mt-1 text-2xl font-bold text-brand-900">
          {result.success ? "Payment received" : "Payment not confirmed"}
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          {result.success
            ? result.data?.decision === "processed"
              ? "Your subscription is active. The analytics workspace can now be used."
              : "This payment was already processed. Your subscription remains active."
            : result.error ??
              "We could not verify this payment. No entitlement was activated."}
        </p>
        {result.success && (
          <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            Access is linked to the verified payment event, not to this page.
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {result.success && (
            <Link href="/admin/zeli-analytics" className="btn btn-primary btn-sm">
              Open Zeli Business Intelligence
            </Link>
          )}
          <Link href="/admin/zeli-analytics/upgrade" className="btn btn-secondary btn-sm">
            Back to subscription
          </Link>
        </div>
      </div>
    </div>
  );
}
