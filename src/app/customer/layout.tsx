"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import Link from "next/link";
import { customerLogout } from "@/lib/actions/auth.actions";
import { isRedirectError } from "@/lib/errors";

import { Banknote, ClipboardList, CreditCard, Landmark, Settings, UserRound, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const NAV_ITEMS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/customer/dashboard", label: "My Savings", icon: Wallet },
  { href: "/customer/payments", label: "My Payments", icon: Banknote },
  { href: "/customer/withdrawals", label: "My Withdrawals", icon: Landmark },
  { href: "/customer/statement", label: "My Statement", icon: ClipboardList },
  { href: "/customer/profile", label: "My Profile", icon: UserRound },
  { href: "/customer/settings", label: "Settings", icon: Settings },
];

export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [userName, setUserName] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const [loading, setLoading] = useState(true);

  async function loadUser() {
    try {
      const res = await fetch("/api/auth/me?module=customer");
      if (res.ok) {
        const data = await res.json();
        setUserName(data.fullName || "Customer");
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUser();
  }, []);

  async function handleLogout() {
    if (!confirm("Sign out?\n\nAre you sure you want to sign out?")) return;
    try {
      await customerLogout();
    } catch (err) {
      if (isRedirectError(err)) throw err;
    }
  }

  function getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    return "Good evening";
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="bg-white border-b border-slate-200 px-4 py-3 sticky top-0 z-40">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link href="/customer/dashboard" className="flex items-center gap-2">
            <img
              src="/branding/bik-prestige-logo.svg"
              alt="BIK Prestige Enterprise"
              className="h-8 w-auto"
              width={160}
              height={80}
            />
          </Link>
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="text-slate-600 hover:text-slate-800 p-2"
              aria-label="Open menu"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 top-full mt-1 w-56 bg-white border border-slate-200 rounded-lg shadow-lg z-50">
                  <nav className="py-1">
                    {NAV_ITEMS.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setShowMenu(false)}
                        className="flex items-center gap-3 px-4 py-3 text-sm text-slate-700 hover:bg-slate-50"
                      >
                        <span><item.icon size={16} aria-hidden /></span>
                        {item.label}
                      </Link>
                    ))}
                    <hr className="my-1" />
                    <button
                      onClick={handleLogout}
                      className="w-full text-left flex items-center gap-3 px-4 py-3 text-sm text-red-600 hover:bg-red-50"
                    >
                      <span>🚪</span>
                      Sign Out
                    </button>
                  </nav>
                </div>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="p-4 max-w-4xl mx-auto flex-1">{children}</main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="p-4 text-center">
          <p className="text-xs text-slate-400">Built by BloomCore Technologies</p>
        </div>
      </footer>
    </div>
  );
}