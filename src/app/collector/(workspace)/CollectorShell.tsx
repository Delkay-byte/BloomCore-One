"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LayoutDashboard, Settings, Sparkles } from "lucide-react";
import ConfirmSignOutButton from "@/components/ConfirmSignOutButton";
import WorkspaceSwitcher from "@/components/WorkspaceSwitcher";
import { AppBrand } from "@/components/brand/AppBrand";

/**
 * Susu collector shell. Identity and business name arrive as server-resolved
 * props, so the shell never depends on a client `/api/auth/me` round-trip.
 */
export default function CollectorShell({
  children,
  tenantName,
  zeliEnabled,
  bothModules,
}: {
  children: React.ReactNode;
  tenantName: string | null;
  zeliEnabled: boolean;
  bothModules: boolean;
}) {
  const [showMenu, setShowMenu] = useState(false);
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

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-3">
          <AppBrand tenantName={tenantName} markSize={30} href="/collector/dashboard" />
          <div className="relative">
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setShowMenu((value) => !value)}
              className="rounded-control p-2 text-slate-600 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
              aria-label="Open menu"
              aria-haspopup="menu"
              aria-expanded={showMenu}
              aria-controls="collector-menu"
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
                  id="collector-menu"
                  role="menu"
                  className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
                >
                  <Link
                    href="/collector/dashboard"
                    role="menuitem"
                    onClick={() => setShowMenu(false)}
                    className="flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    <LayoutDashboard size={15} aria-hidden /> Dashboard
                  </Link>
                  {zeliEnabled && (
                    <Link
                      href="/zeli"
                      role="menuitem"
                      onClick={() => setShowMenu(false)}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
                    >
                      <Sparkles size={15} aria-hidden /> Zeli Assistant
                    </Link>
                  )}
                  <Link
                    href="/collector/settings"
                    role="menuitem"
                    onClick={() => setShowMenu(false)}
                    className="flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    <Settings size={15} aria-hidden /> Settings
                  </Link>
                  <hr className="my-1 border-slate-100" />
                  <ConfirmSignOutButton
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-red-600 hover:bg-red-50"
                    icon={null}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </header>
      <WorkspaceSwitcher current="susu" bothModules={bothModules} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-5">{children}</main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="px-4 py-4 text-center">
          <p className="text-xs text-slate-400">
            MaaCash{tenantName ? ` · ${tenantName}` : ""} · Built by BloomCore Technologies
          </p>
        </div>
      </footer>
    </div>
  );
}
