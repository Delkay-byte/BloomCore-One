import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenantAdmin } from "@/lib/tenant";
import { db } from "@/lib/db";
import PrintButton from "./PrintButton";

export const dynamic = "force-dynamic";

function money(value: unknown, currency: string) {
  const amount = Number(value);
  return `${currency === "GHS" ? "GH₵" : currency + " "}${amount.toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantAdmin();
  const { id } = await params;
  const subscription = await db.zeliSubscription.findFirst({
    where: { id, tenantId: ctx.tenantId, paidAt: { not: null } },
    include: { plan: true },
  });
  if (!subscription) notFound();

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <Link href="/admin/billing" className="text-sm text-brand-700 underline">
          Back to Billing
        </Link>
        <PrintButton />
      </div>
      <article className="card bg-white p-6">
        <header className="flex items-start justify-between border-b border-slate-200 pb-4">
          <div>
            <p className="text-lg font-semibold text-slate-900">MaaCash</p>
            <p className="text-xs text-slate-500">Mobile money, Susu & multi-branch operations</p>
          </div>
          <div className="text-right text-xs text-slate-500">
            <p>Receipt</p>
            <p className="font-mono">{subscription.providerReference}</p>
          </div>
        </header>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">Business</dt>
            <dd className="font-medium text-slate-900">{ctx.tenantName}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Paid on</dt>
            <dd className="font-medium text-slate-900">
              {subscription.paidAt?.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Package</dt>
            <dd className="font-medium text-slate-900">{subscription.plan.name}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Billing term</dt>
            <dd className="font-medium text-slate-900">{subscription.billingTerm === "annual" ? "Annual" : "Monthly"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Period</dt>
            <dd className="font-medium text-slate-900">
              {subscription.periodStart?.toLocaleDateString("en-GB")} – {subscription.periodEnd?.toLocaleDateString("en-GB")}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Founding price applied</dt>
            <dd className="font-medium text-slate-900">{subscription.foundingAllocationId ? "Yes" : "No"}</dd>
          </div>
        </dl>
        <div className="mt-6 flex items-center justify-between border-t border-slate-200 pt-4">
          <span className="text-sm font-medium text-slate-700">Amount paid</span>
          <span className="text-xl font-semibold text-slate-900">{money(subscription.amount, subscription.currency)}</span>
        </div>
        <p className="mt-4 text-xs text-slate-500">
          This receipt records a payment verified by MaaCash through Paystack. It is not a tax invoice.
        </p>
      </article>
    </div>
  );
}
