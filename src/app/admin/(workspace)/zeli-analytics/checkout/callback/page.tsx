import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Legacy Paystack return path.
 *
 * Checkouts created before the hosted-checkout switch used this URL. It now
 * forwards the reference to the public return page, which verifies the payment
 * and works even when the checkout tab has no workspace session.
 */
export default async function ZeliCheckoutCallbackPage({
  searchParams,
}: {
  searchParams: Promise<{ reference?: string; trxref?: string }>;
}) {
  const params = await searchParams;
  const reference = String(params.reference ?? params.trxref ?? "").trim();
  redirect(
    reference
      ? `/checkout/return?reference=${encodeURIComponent(reference)}`
      : "/checkout/return"
  );
}
