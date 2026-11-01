import Link from "next/link";
import { BrandLockup } from "@/components/brand/Brand";
import {
  ALL_ACCESS_PATH,
  BUSINESS_LOGIN_PATH,
  COMPANY_LOCATION,
  COMPANY_NAME,
  LEGAL_ROUTES,
  PLATFORM_LOGIN_PATH,
  PRODUCT_NAME,
  PUBLIC_ROUTES,
} from "@/lib/site";

/**
 * Public site footer. The platform control plane is referenced once, quietly,
 * as "Platform administration" — the marketing site never advertises
 * administrative access.
 */
export default function MarketingFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-line bg-ivory">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-10 md:grid-cols-4">
          <div className="md:col-span-2">
            <BrandLockup size={38} descriptor />
            <p className="mt-4 max-w-sm text-sm text-ink">
              A product by {COMPANY_NAME}. {PRODUCT_NAME} brings business
              operations, collections, people and financial records together in
              one connected platform.
            </p>
            <p className="mt-3 text-sm text-ink-muted">
              {COMPANY_NAME} is a business based in {COMPANY_LOCATION}.
            </p>
          </div>

          <div>
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
              Platform
            </h2>
            <ul className="mt-4 space-y-2.5">
              {PUBLIC_ROUTES.map((route) => (
                <li key={route.path}>
                  <Link
                    href={route.path}
                    className="text-sm text-ink hover:text-brand-700"
                  >
                    {route.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
              Legal &amp; Access
            </h2>
            <ul className="mt-4 space-y-2.5">
              {LEGAL_ROUTES.map((route) => (
                <li key={route.path}>
                  <Link
                    href={route.path}
                    className="text-sm text-ink hover:text-brand-700"
                  >
                    {route.label}
                  </Link>
                </li>
              ))}
              <li>
                <Link
                  href={BUSINESS_LOGIN_PATH}
                  className="text-sm font-medium text-brand-700 hover:text-brand-800"
                >
                  Business sign in
                </Link>
              </li>
              <li>
                <Link
                  href={ALL_ACCESS_PATH}
                  className="text-sm text-ink hover:text-brand-700"
                >
                  All sign-in options
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-ink-muted">
            © {year} {COMPANY_NAME}. {PRODUCT_NAME}™ is a product of{" "}
            {COMPANY_NAME}. All rights reserved.
          </p>
          <Link
            href={PLATFORM_LOGIN_PATH}
            className="text-xs text-ink-faint hover:text-ink-muted"
          >
            Platform administration
          </Link>
        </div>
      </div>
    </footer>
  );
}
