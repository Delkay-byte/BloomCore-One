import Link from "next/link";
import { SearchX } from "lucide-react";
import { BrandLockup } from "@/components/brand/Brand";
import { PRODUCT_NAME } from "@/lib/site";

/**
 * Application 404.
 *
 * Next.js routes every unmatched URL to this file (see the Next.js
 * `not-found` convention), so it must read as a neutral public page: a visitor
 * who mistypes a marketing URL lands here, and a signed-in user who follows a
 * dead application link lands here too. It therefore links to the public home
 * page and to sign-in, and never mentions workspace internals.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center bg-white px-4 py-16">
      <div className="w-full max-w-lg text-center">
        <div className="flex justify-center">
          <BrandLockup size={40} className="justify-center" />
        </div>
        <SearchX className="mx-auto mt-8 text-brand-300" size={32} aria-hidden />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink-deep">
          Page not found
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">
          The page you are looking for does not exist or may have moved.
        </p>
        <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-control bg-brand-700 px-5 py-3 text-sm font-semibold text-white hover:bg-brand-800"
          >
            MaaCash home
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-control border border-line-strong bg-white px-5 py-3 text-sm font-semibold text-ink hover:border-brand-300 hover:text-brand-700"
          >
            Sign in
          </Link>
        </div>
        <p className="mt-6 text-xs text-ink-faint">{PRODUCT_NAME}</p>
      </div>
    </div>
  );
}
