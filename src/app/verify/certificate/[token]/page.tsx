import type { Metadata } from "next";
import { verifyTrainingCertificate } from "@/lib/actions/training.actions";

/**
 * Public certificate verification.
 *
 * Anyone holding a verification link can confirm a certificate without signing
 * in, and sees only what verification needs: the course, the serial, the dates
 * and the state. The holder's name is masked and no contact details appear.
 */
export const metadata: Metadata = {
  title: "Certificate verification — MaaCash",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function VerifyCertificatePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { token: pathToken } = await params;
  const { token: queryToken } = await searchParams;
  const token = (queryToken ?? pathToken ?? "").trim();
  const result = await verifyTrainingCertificate(token);

  const tone =
    result.state === "issued"
      ? "border-emerald-300 bg-emerald-50 text-emerald-900"
      : result.state === "unknown"
        ? "border-slate-300 bg-slate-50 text-slate-800"
        : "border-amber-300 bg-amber-50 text-amber-900";

  return (
    <main className="mx-auto max-w-xl space-y-4 p-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          MaaCash certificate verification
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          {result.stateLabel}
        </h1>
      </header>

      <section className={`rounded-xl border p-4 ${tone}`} aria-live="polite">
        {result.found ? (
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-xs uppercase tracking-wide opacity-70">Course</dt>
              <dd className="font-medium">
                {result.courseTitle} {result.version ? `(v${result.version})` : ""}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-xs uppercase tracking-wide opacity-70">Holder</dt>
              <dd className="font-medium">{result.holder}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-xs uppercase tracking-wide opacity-70">Serial</dt>
              <dd className="font-mono">{result.serial}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-xs uppercase tracking-wide opacity-70">Issued</dt>
              <dd>{new Date(result.issuedAt!).toLocaleDateString("en-GB")}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-xs uppercase tracking-wide opacity-70">Expires</dt>
              <dd>{new Date(result.expiresAt!).toLocaleDateString("en-GB")}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm">
            That reference does not match a certificate issued through MaaCash. Check the
            link with the association that issued it.
          </p>
        )}
      </section>

      <p className="text-xs text-slate-500">
        This page confirms an association training record only. It is not a regulatory
        licence, and it never shows contact details.
      </p>
    </main>
  );
}
