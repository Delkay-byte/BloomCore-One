"use client";

import { AlertTriangle } from "lucide-react";
import { useEffect } from "react";
import Link from "next/link";
import { BrandLockup } from "@/components/brand/Brand";

/**
 * Public-site error boundary. Separate from the application's error screen so
 * a failure on a marketing page never shows authenticated-application
 * wording or a link back into a signed-in workspace.
 */
export default function MarketingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface for monitoring without leaking internals to the UI.
    console.error("[MARKETING PAGE ERROR]", error);
  }, [error]);

  return (
    <section className="bg-white">
      <div className="mx-auto flex min-h-[60vh] w-full max-w-3xl flex-col items-center justify-center px-4 py-20 text-center">
        <BrandLockup size={40} className="justify-center" />
        <AlertTriangle size={34} className="mt-8 text-gold-500" aria-hidden />
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-ink-deep">
          Something went wrong
        </h1>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-ink">
          This page could not be loaded. Try again, or return to the home page.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center justify-center rounded-control bg-brand-700 px-5 py-3 text-sm font-semibold text-white hover:bg-brand-800"
          >
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-control border border-line-strong bg-white px-5 py-3 text-sm font-semibold text-ink hover:border-brand-300 hover:text-brand-700"
          >
            Back to home
          </Link>
        </div>
      </div>
    </section>
  );
}
