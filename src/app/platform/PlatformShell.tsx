"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Building2,
  FileClock,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Settings,
  Sparkles,
  UserPlus,
} from "lucide-react";
import { platformLogout } from "@/lib/actions/platform.actions";
import { clearTabSession } from "@/lib/security/tab-session-client";
import { isRedirectError } from "@/lib/errors";
import type { PlatformSession } from "@/lib/platform-auth";
import { BrandLockup } from "@/components/brand/Brand";

const navItems = [
  { href: "/platform/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/platform/tenants", label: "Businesses", icon: Building2 },
  { href: "/platform/tenants/new", label: "Enroll Business", icon: UserPlus },
  { href: "/platform/zeli", label: "Zeli", icon: Sparkles },
  { href: "/platform/audit", label: "Activity History", icon: FileClock },
  { href: "/platform/recovery", label: "Account Recovery", icon: LifeBuoy },
  { href: "/platform/settings", label: "Platform Settings", icon: Settings },
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
      const result = await platformLogout();
      await clearTabSession();
      window.location.assign(result.redirectTo ?? "/platform/login");
    } catch (err) {
      if (isRedirectError(err)) throw err;
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col">
      {/* Mobile header */}
      <div className="md:hidden bg-brand-900 border-b border-brand-800 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="text-brand-200 hover:text-white p-1 -m-1"
          aria-expanded={sidebarOpen}
          aria-label={sidebarOpen ? "Close navigation" : "Open navigation"}
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="text-sm font-medium text-white">MaaCash · Platform Admin</span>
        <span className="text-xs text-brand-300">{session.fullName}</span>
      </div>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-slate-950/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar — deliberately darker and quieter than the tenant shell so the
          platform control plane reads as a distinct, privileged surface. */}
      <aside
        className={`focus-on-dark fixed left-0 top-0 h-full w-64 bg-brand-950 z-50 flex flex-col transform transition-transform md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-6 border-b border-brand-900 flex-none">
          <BrandLockup size={36} tone="dark" />
          <p className="text-brand-400 text-xs mt-3 uppercase tracking-wider">
            Platform Administration
          </p>
        </div>
        <nav className="p-3 flex-1 overflow-y-auto" aria-label="Primary">
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-brand-800 text-white shadow-inner"
                    : "text-brand-300 hover:bg-brand-900 hover:text-white"
                }`}
              >
                <item.icon
                  size={17}
                  aria-hidden
                  className={active ? "text-gold-400" : "text-brand-500"}
                />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-brand-900 flex-none">
          <div className="px-3 pb-2">
            <p className="text-xs text-brand-400">Signed in as</p>
            <p className="text-sm text-white font-medium truncate">{session.email}</p>
          </div>
          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-brand-300 hover:bg-red-900/40 hover:text-red-300 w-full transition-colors"
          >
            <LogOut size={17} aria-hidden />
            {signingOut ? "Signing out…" : "Sign out"}
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
          <p className="text-xs text-slate-400">MaaCash · Platform Administration · Built by BloomCore Technologies</p>
        </div>
      </footer>
    </div>
  );
}
