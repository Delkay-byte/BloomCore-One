"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Banknote,
  ClipboardList,
  Landmark,
  Loader2,
  LogOut,
  Settings,
  ShieldCheck,
  UserRound,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AppBrand } from "@/components/brand/AppBrand";
import { customerLogout } from "@/lib/actions/auth.actions";
import { isRedirectError } from "@/lib/errors";
import { clearTabSession } from "@/lib/security/tab-session-client";

const NAV_ITEMS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/customer/dashboard", label: "My Savings", icon: Wallet },
  { href: "/customer/payments", label: "My Payments", icon: Banknote },
  { href: "/customer/withdrawals", label: "My Withdrawals", icon: Landmark },
  { href: "/customer/statement", label: "My Statement", icon: ClipboardList },
  { href: "/customer/profile", label: "My Profile", icon: UserRound },
  { href: "/customer/settings", label: "Settings", icon: Settings },
];

/**
 * Customer portal shell.
 *
 * Identity and business name are server-resolved props. Sign-out uses the
 * product's confirmation card rather than a browser-native `confirm()`; it
 * still revokes this tab's server session and clears only this tab's key.
 */
export default function CustomerShell({
  children,
  fullName,
  tenantName,
}: {
  children: React.ReactNode;
  fullName: string;
  tenantName: string | null;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!showMenu) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowMenu(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showMenu]);

  useEffect(() => {
    if (!confirming) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !signingOut) setConfirming(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirming, signingOut]);

  async function handleLogout() {
    setSigningOut(true);
    setSignOutError("");
    try {
      const result = await customerLogout();
      await clearTabSession();
      window.location.assign(result.redirectTo ?? "/login?role=customer");
    } catch (err) {
      if (isRedirectError(err)) throw err;
      setSignOutError("Your session could not be closed. Check your connection and try again.");
      setSigningOut(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <AppBrand tenantName={tenantName} markSize={30} href="/customer/dashboard" />
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-slate-500 sm:inline">
              <span className="font-medium text-slate-700">{fullName}</span>
            </span>
            <div className="relative">
              <button
                ref={triggerRef}
                type="button"
                onClick={() => setShowMenu((value) => !value)}
                className="rounded-control p-2 text-slate-600 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                aria-label="Open menu"
                aria-haspopup="menu"
                aria-expanded={showMenu}
                aria-controls="customer-menu"
              >
                <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              {showMenu && (
                <>
                  <button
                    type="button"
                    className="fixed inset-0 z-40 cursor-default"
                    aria-label="Close menu"
                    tabIndex={-1}
                    onClick={() => setShowMenu(false)}
                  />
                  <div
                    id="customer-menu"
                    role="menu"
                    className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
                  >
                    {NAV_ITEMS.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        role="menuitem"
                        onClick={() => setShowMenu(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
                      >
                        <item.icon size={16} aria-hidden />
                        {item.label}
                      </Link>
                    ))}
                    <hr className="my-1 border-slate-100" />
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowMenu(false);
                        setConfirming(true);
                      }}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-red-600 hover:bg-red-50"
                    >
                      <LogOut size={16} aria-hidden />
                      Sign Out
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-5">{children}</main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="px-4 py-4 text-center">
          <p className="text-xs text-slate-400">
            MaaCash{tenantName ? ` · ${tenantName}` : ""} · Built by BloomCore Technologies
          </p>
        </div>
      </footer>

      {confirming && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="customer-signout-title"
          aria-describedby="customer-signout-body"
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <span className="inline-flex rounded-full bg-amber-50 p-2 text-amber-700">
              <ShieldCheck size={20} aria-hidden />
            </span>
            <h2 id="customer-signout-title" className="mt-3 text-lg font-semibold text-slate-900">
              Sign out of MaaCash?
            </h2>
            <p id="customer-signout-body" className="mt-1 text-sm text-slate-600">
              You will need your customer ID, phone or email and your password to sign in again.
            </p>
            {signOutError && (
              <div role="alert" className="banner banner-error mt-3 text-sm">
                {signOutError}
              </div>
            )}
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="btn btn-secondary flex-1"
                disabled={signingOut}
              >
                Stay signed in
              </button>
              <button
                type="button"
                onClick={handleLogout}
                className="btn btn-danger flex-1"
                disabled={signingOut}
                aria-busy={signingOut}
              >
                {signingOut ? (
                  <>
                    <Loader2 size={15} className="animate-spin" aria-hidden /> Signing out…
                  </>
                ) : (
                  "Sign out"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
