"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import ConfirmSignOutButton from "@/components/ConfirmSignOutButton";
import { AppBrand } from "@/components/brand/AppBrand";

/**
 * Shared sidebar shell for the tenant-administration workspaces.
 * The platform console uses its own dark variant (PlatformShell) so the two
 * security boundaries remain visually distinct while drawing on the same
 * design tokens.
 */

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export default function AppShell({
  sections,
  children,
  subtitle = "Business Management",
  homeHref = "/admin/dashboard",
  tenantName,
}: {
  sections: NavSection[];
  children: React.ReactNode;
  subtitle?: string;
  homeHref?: string;
  /** The signed-in business. Shown under the MaaCash identity. */
  tenantName?: string | null;
}) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  function isActive(href: string) {
    if (href === "/admin/dashboard") return pathname === href;
    if (href === "/susu/admin") return pathname === "/susu/admin";
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col">
      <a
        href="#app-main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[200] focus:bg-white focus:px-3 focus:py-2 focus:rounded-md focus:shadow focus:m-2"
      >
        Skip to content
      </a>

      {/* Mobile header */}
      <div className="md:hidden bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="text-slate-500 hover:text-slate-800 p-1 -m-1"
          aria-expanded={sidebarOpen}
          aria-label={sidebarOpen ? "Close navigation" : "Open navigation"}
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <AppBrand tenantName={tenantName} markSize={30} href={homeHref} />
        <Link href={homeHref} className="text-xs font-medium text-brand-700">
          {subtitle}
        </Link>
      </div>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-slate-950/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar */}
      <aside
        className={`focus-on-dark fixed left-0 top-0 h-full w-64 bg-brand-900 z-50 flex flex-col transform transition-transform md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-6 border-b border-brand-800 flex-none">
          <AppBrand tenantName={tenantName} tone="dark" markSize={38} href={homeHref} />
          <p className="text-brand-300 text-xs mt-3 uppercase tracking-wider">{subtitle}</p>
        </div>
        <nav className="p-3 flex-1 overflow-y-auto" aria-label="Primary">
          {sections.map((section) => (
            <div key={section.title || "main"} className="mb-3">
              {section.title && (
                <h3 className="text-[0.6875rem] font-semibold text-brand-400 uppercase tracking-wider mb-1.5 px-3">
                  {section.title}
                </h3>
              )}
              {section.items.map((item) => {
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setSidebarOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 text-sm font-medium transition-colors ${
                      active
                        ? "bg-brand-700 text-white shadow-inner"
                        : "text-brand-200 hover:bg-brand-800 hover:text-white"
                    }`}
                  >
                    <item.icon
                      size={17}
                      aria-hidden
                      className={active ? "text-gold-400" : "text-brand-400"}
                    />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="p-3 border-t border-brand-800 flex-none">
          <ConfirmSignOutButton
            icon={null}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-brand-200 hover:bg-brand-800 hover:text-white w-full transition-colors"
          />
        </div>
      </aside>

      {/* Main content */}
      <main id="app-main" className="md:ml-64 flex-1">
        <div className="p-4 md:p-8 max-w-7xl mx-auto">{children}</div>
      </main>

      {/* Footer */}
      <footer className="md:ml-64 border-t border-slate-200 bg-white">
        <div className="p-4 text-center">
          <p className="text-xs text-slate-400">
            MaaCash{tenantName ? ` · ${tenantName}` : ""} · Built by BloomCore
            Technologies
          </p>
        </div>
      </footer>
    </div>
  );
}
