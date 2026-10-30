"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { platformLogout } from "@/lib/actions/platform.actions";
import { isRedirectError } from "@/lib/errors";
import type { PlatformSession } from "@/lib/platform-auth";

const navItems = [
  { href: "/platform/dashboard", label: "Overview", icon: "📊" },
  { href: "/platform/tenants", label: "Businesses", icon: "🏢" },
  { href: "/platform/tenants/new", label: "Enroll Business", icon: "➕" },
  { href: "/platform/audit", label: "Activity History", icon: "📝" },
  { href: "/platform/settings", label: "Platform Settings", icon: "⚙️" },
];

export default function PlatformShell({
  session,
  children,
}: {
  session: PlatformSession;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  function isActive(href: string) {
    if (href === "/platform/tenants") {
      return pathname === "/platform/tenants" || /^\/platform\/tenants\/[^/]+$/.test(pathname);
    }
    return pathname === href || pathname.startsWith(href + "/");
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await platformLogout();
    } catch (err) {
      if (isRedirectError(err)) throw err;
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col">
      {/* Mobile header */}
      <div className="md:hidden bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center justify-between">
        <button onClick={() => setSidebarOpen(!sidebarOpen)} className="text-slate-300 hover:text-white">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="text-sm font-medium text-white">Platform Admin</span>
        <span className="text-xs text-slate-400">{session.fullName}</span>
      </div>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed left-0 top-0 h-full w-64 bg-slate-900 z-50 flex flex-col transform transition-transform md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-6 border-b border-slate-800 flex-none">
          <img
            src="/branding/bik-prestige-logo.svg"
            alt="BIK Prestige Enterprise"
            className="h-9 w-auto rounded bg-white p-1.5"
            width={180}
            height={90}
          />
          <p className="text-slate-400 text-xs mt-3 uppercase tracking-wider">
            BloomCore Platform Console
          </p>
        </div>
        <nav className="p-4 flex-1 overflow-y-auto">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setSidebarOpen(false)}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 text-sm font-medium transition-colors ${
                isActive(item.href)
                  ? "bg-slate-700 text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="p-4 border-t border-slate-800 flex-none">
          <div className="px-3 pb-2">
            <p className="text-xs text-slate-400">Signed in as</p>
            <p className="text-sm text-white font-medium truncate">{session.email}</p>
          </div>
          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-300 hover:bg-red-900/40 hover:text-red-300 w-full transition-colors"
          >
            <span className="text-base">⎋</span>
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="md:ml-64 flex-1">
        <div className="p-4 md:p-8 max-w-7xl mx-auto">{children}</div>
      </main>

      {/* Footer */}
      <footer className="md:ml-64 border-t border-slate-200 bg-white">
        <div className="p-4 text-center">
          <p className="text-xs text-slate-400">BIK Prestige Enterprise Platform · Built by BloomCore Technologies</p>
        </div>
      </footer>
    </div>
  );
}
