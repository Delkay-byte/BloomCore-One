import Link from "next/link";
import { SearchX } from "lucide-react";
import { BrandLockup } from "@/components/brand/Brand";

/**
 * Public-site 404. Kept separate from the application's 404 so a visitor who
 * mistypes a marketing URL never sees authenticated-application wording.
 */
export default function MarketingNotFound() {
  return (
    <section className="bg-white">
      <div className="mx-auto flex min-h-[60vh] w-full max-w-3xl flex-col items-center justify-center px-4 py-20 text-center">
        <BrandLockup size={40} className="justify-center" />
        <SearchX size={34} className="mt-8 text-brand-300" aria-hidden />
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-ink-deep">
          Page not found
        </h1>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-ink">
          The page you are looking for does not exist or has moved. The platform
          pages below cover what BloomCore One does and how a business joins.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-control bg-brand-700 px-5 py-3 text-sm font-semibold text-white hover:bg-brand-800"
          >
            Back to home
          </Link>
          <Link
            href="/features"
            className="inline-flex items-center justify-center rounded-control border border-line-strong bg-white px-5 py-3 text-sm font-semibold text-ink hover:border-brand-300 hover:text-brand-700"
          >
            See the features
          </Link>
        </div>
      </div>
    </section>
  );
}
