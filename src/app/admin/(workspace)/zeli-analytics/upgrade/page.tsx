import Link from "next/link";
import { redirect } from "next/navigation";
import { LockKeyhole, MessageSquare, Sparkles } from "lucide-react";
import { requireTenantAdmin } from "@/lib/tenant";
import {
  evaluateZeliAccess,
  getZeliEntitlement,
  zeliDenialMessage,
  type ZeliDenialReason,
} from "@/lib/zeli/entitlements";
import {
  listPublicZeliPlans,
  paymentProviderStatus,
} from "@/lib/payments/zeli-subscriptions";
import CheckoutPlans from "./CheckoutPlans";

export const dynamic = "force-dynamic";

/**
 * Denial/upgrade screen. It deliberately contains no pricing and no fake
 * checkout: Zeli Analytics is activated by the platform control centre under an
 * audited entitlement decision. The conversational assistant remains available
 * to every existing role.
 */
export default async function ZeliAnalyticsUpgradePage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const ctx = await requireTenantAdmin();
  const params = await searchParams;
  const entitlement = await getZeliEntitlement(ctx.tenantId);
  const access = evaluateZeliAccess({ role: ctx.role, entitlement });
  if (access.allowed) redirect("/admin/zeli-analytics");

  const reason = (params.reason as ZeliDenialReason | undefined) ?? access.reason;
  const message = zeliDenialMessage(reason ?? null);
  const checkoutAllowed =
    access.reason === "no_entitlement" || access.reason === "expired";
  const [plans, payment] = checkoutAllowed
    ? await Promise.all([listPublicZeliPlans(), Promise.resolve(paymentProviderStatus())])
    : [[], paymentProviderStatus()];

  return (
    <div className="mx-auto max-w-3xl space-y-5 py-6">
      <div className="card bg-white">
        <div className="flex items-start gap-3">
          <span className="rounded-full bg-gold-100 p-2 text-gold-700">
            <LockKeyhole size={20} aria-hidden />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-gold-600">
              Zeli Business Intelligence
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-brand-900">
              Analytics is not enabled for this business
            </h1>
            <p className="mt-2 text-sm text-slate-600">{message}</p>
            <p className="mt-2 text-sm text-slate-600">
              Zeli Business Intelligence is a separate subscription from the Zeli
              conversational assistant. Your existing conversations and business screens are
              unaffected.
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-xl border border-brand-100 bg-brand-50/60 p-4 text-sm text-brand-900">
          <p className="font-semibold">How access is granted</p>
          <p className="mt-1">
            Subscribe below, or ask a BloomCore platform administrator to review the business.
            Subscription access is activated by a verified Paystack payment event, not by the
            browser redirect. Manual platform decisions always require a reason and are audited.
          </p>
          {access.status !== "none" && (
            <p className="mt-2 text-xs">
              Current entitlement status: {access.status}
              {access.expiresAt ? ` · Expires ${access.expiresAt.slice(0, 10)}` : ""}
            </p>
          )}
        </div>

        {checkoutAllowed && (
          <div className="mt-5">
            <h2 className="mb-2 font-semibold text-brand-900">Zeli Analytics packages</h2>
            <CheckoutPlans
              plans={plans}
              paymentConfigured={payment.configured}
              providerMessage={payment.message}
            />
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <Link href="/zeli" className="btn btn-primary btn-sm">
            <MessageSquare size={14} aria-hidden /> Open Zeli Assistant
          </Link>
          <Link href="/admin/dashboard" className="btn btn-secondary btn-sm">
            Back to dashboard
          </Link>
        </div>
      </div>

      <div className="card bg-white">
        <h2 className="flex items-center gap-2 font-semibold text-brand-900">
          <Sparkles size={16} aria-hidden /> What the analytics workspace provides
        </h2>
        <ul className="mt-3 grid gap-2 text-sm text-slate-700 sm:grid-cols-2">
          <li>Server-computed financial and operational KPIs.</li>
          <li>Contributions, withdrawals, income, expenses and net cash flow.</li>
          <li>Branch and collector comparisons.</li>
          <li>Rule-based anomaly detection with calculation and source.</li>
          <li>Remittance and exception review prompts.</li>
          <li>CSV export of aggregate figures.</li>
        </ul>
        <p className="mt-3 text-xs text-slate-500">
          Analytics is calculated inside BloomCore One. External AI processing is currently
          disabled.
        </p>
      </div>
    </div>
  );
}
