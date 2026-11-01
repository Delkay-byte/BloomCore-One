"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X, ArrowRight } from "lucide-react";
import { BrandLockup } from "@/components/brand/Brand";
import { PUBLIC_ROUTES } from "@/lib/site";

/**
 * Public site navigation. Accessible by keyboard, closes on Escape and on
 * navigation, and never renders an administrative control in the main bar.
 */
export default function MarketingNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // The path the menu was opened on. A navigation closes the menu without an
  // effect: the state is adjusted during render, which React recommends over
  // calling setState from inside an effect.
  const [openedAt, setOpenedAt] = useState(pathname);

  if (open && openedAt !== pathname) {
    setOpen(false);
    setOpenedAt(pathname);
  }

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <header className="sticky top-0 z-50 border-b border-line bg-ivory">
      <nav aria-label="Main" className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <Link href="/" className="rounded-md" aria-label="BloomCore One home">
          <BrandLockup size={34} />
        </Link>

        <div className="hidden items-center gap-1 md:flex">
          {PUBLIC_ROUTES.filter((route) => route.path !== "/").map((route) => {
            const active = pathname === route.path || pathname.startsWith(`${route.path}/`);
            return (
              <Link
                key={route.path}
                href={route.path}
                aria-current={active ? "page" : undefined}
                className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "text-brand-700"
                    : "text-ink hover:text-brand-700"
                }`}
              >
                {route.label}
              </Link>
            );
          })}
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <Link
            href="/workspace"
            className="rounded-control px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
          >
            Sign In
          </Link>
          <Link
            href="/contact"
            className="inline-flex items-center gap-1.5 rounded-control bg-brand-700 px-4 py-2 text-sm font-semibold text-white shadow-card transition-colors hover:bg-brand-800"
          >
            Request a Demonstration
            <ArrowRight size={15} aria-hidden />
          </Link>
        </div>

        <button
          type="button"
          onClick={() => {
            setOpen((value) => !value);
            setOpenedAt(pathname);
          }}
          className="rounded-md p-2 text-ink hover:bg-ivory-deep md:hidden"
          aria-expanded={open}
          aria-controls="marketing-mobile-nav"
          aria-label={open ? "Close menu" : "Open menu"}
        >
          {open ? <X size={22} aria-hidden /> : <Menu size={22} aria-hidden />}
        </button>
      </nav>

      {open ? (
        <div id="marketing-mobile-nav" className="border-t border-line bg-ivory md:hidden">
          <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6">
            <ul className="space-y-1">
              {PUBLIC_ROUTES.map((route) => (
                <li key={route.path}>
                  <Link
                    href={route.path}
                    className="block rounded-control px-3 py-2.5 text-sm font-medium text-ink hover:bg-white hover:text-brand-700"
                  >
                    {route.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
              <Link
                href="/contact"
                className="rounded-control bg-brand-700 px-4 py-2.5 text-center text-sm font-semibold text-white"
              >
                Request a Demonstration
              </Link>
              <Link
                href="/workspace"
                className="rounded-control border border-line-strong bg-white px-4 py-2.5 text-center text-sm font-semibold text-brand-700"
              >
                Sign In
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
