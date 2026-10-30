"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import ConfirmSignOutButton from "@/components/ConfirmSignOutButton";
import TabSessionGuard from "@/components/TabSessionGuard";
import { navSections } from "@/lib/admin-nav";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Module navigation comes from the TENANT's entitlement (server-resolved via
  // /api/auth/me), never from a browser flag. A business not enrolled for a
  // module must not see — or be invited into — that module's navigation.
  const [modules, setModules] = useState<{ momo: boolean; susu: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me?module=admin")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.tenant) {
          setModules({ momo: !!data.tenant.momoEnabled, susu: !!data.tenant.susuEnabled });
        } else {
          setModules({ momo: true, susu: true });
        }
      })
      .catch(() => !cancelled && setModules({ momo: true, susu: true }));
    return () => {
      cancelled = true;
    };
  }, []);

  // Until the entitlement resolves, show non-module navigation only — the
  // server actions reject disabled modules anyway (fail closed).
  function visibleSections() {
    if (!modules) {
      return navSections.filter((s) => !s.title || s.title === "Administration");
    }
    return navSections.filter((s) => {
      if (s.title === "MoMo") return modules.momo;
      if (s.title === "Susu") return modules.susu;
      return true;
    });
  }

  // The administrator login is a public, standalone page. It must NOT inherit
  // the authenticated dashboard shell (sidebar, navigation, TabSessionGuard).
  // Render it cleanly with only the root layout.
  if (pathname === "/admin/login") {
    return <>{children}</>;
  }

  function isActive(href: string) {
    if (href === "/admin/dashboard") return pathname === href;
    if (href === "/susu/admin") return pathname === "/susu/admin";
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <TabSessionGuard />
      {/* Mobile header */}
      <div className="md:hidden bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button onClick={() => setSidebarOpen(!sidebarOpen)} className="text-gray-600 hover:text-gray-800">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <img
          src="/branding/bik-prestige-logo.svg"
          alt="BIK Prestige Enterprise"
          className="h-8 w-auto"
          width={160}
          height={80}
        />
        <span className="text-sm text-gray-500">Admin</span>
      </div>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-40 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed left-0 top-0 h-full w-64 bg-white border-r border-gray-200 z-50 flex flex-col transform transition-transform md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-6 border-b border-gray-200 flex-none">
          <img
            src="/branding/bik-prestige-logo.svg"
            alt="BIK Prestige Enterprise"
            className="h-9 w-auto"
            width={180}
            height={90}
          />
        </div>
        <nav className="p-4 flex-1 overflow-y-auto">
          {visibleSections().map((section) => (
            <div key={section.title || "main"} className="mb-4">
              {section.title && (
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-3">
                  {section.title}
                </h3>
              )}
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setSidebarOpen(false)}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 text-sm font-medium transition-colors ${
                    isActive(item.href)
                      ? "bg-green-50 text-green-700"
                      : "text-gray-600 hover:bg-gray-50 hover:text-gray-800"
                  }`}
                >
                  <span className="text-base">{item.icon}</span>
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="p-4 border-t border-gray-200 flex-none">
          <ConfirmSignOutButton className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 hover:bg-red-50 hover:text-red-600 w-full transition-colors" />
        </div>
      </aside>

      {/* Main content */}
      <main className="md:ml-64 flex-1">
        <div className="p-4 md:p-8 max-w-7xl mx-auto">{children}</div>
      </main>

      {/* Footer */}
      <footer className="md:ml-64 border-t border-gray-200 bg-white">
        <div className="p-4 text-center">
          <p className="text-xs text-gray-400">Built by BloomCore Technologies</p>
        </div>
      </footer>
    </div>
  );
}
