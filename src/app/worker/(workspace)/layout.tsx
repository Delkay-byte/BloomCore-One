"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LayoutDashboard, Settings, Sparkles } from "lucide-react";
import ConfirmSignOutButton from "@/components/ConfirmSignOutButton";
import WorkspaceSwitcher from "@/components/WorkspaceSwitcher";
import { AppBrand } from "@/components/brand/AppBrand";

/**
 * MoMo worker shell. The header shows the BloomCore One identity plus the
 * worker's own business name, resolved server-side from the signed-in session.
 */
export default function WorkerLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [showMenu, setShowMenu] = useState(false);
  const [tenantName, setTenantName] = useState<string | null>(null);
  const [zeliEnabled, setZeliEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me?module=momo")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.tenant?.name) setTenantName(data.tenant.name);
        if (!cancelled) setZeliEnabled(Boolean(data?.tenant?.zeliEnabled));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Authentication is enforced server-side per tab; the shell renders only
  // after middleware and the page guard have accepted this tab's session.
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
        <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between sticky top-0 z-40">
          <AppBrand tenantName={tenantName} markSize={30} href="/worker/dashboard" />
          <WorkspaceSwitcher current="momo" />
          <div className="relative">
            <button onClick={() => setShowMenu(!showMenu)} className="text-slate-600 hover:text-slate-800 p-2" aria-label="Open menu">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 top-full mt-1 w-48 bg-white border border-slate-200 rounded-lg shadow-lg z-50">
                  <button onClick={() => { router.push("/worker/dashboard"); setShowMenu(false); }} className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"><LayoutDashboard size={15} className="inline mr-2 -mt-0.5" aria-hidden />Dashboard</button>
                  {zeliEnabled && (
                    <button onClick={() => { router.push("/zeli"); setShowMenu(false); }} className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"><Sparkles size={15} className="inline mr-2 -mt-0.5" aria-hidden />Zeli Assistant</button>
                  )}
                  <button onClick={() => { router.push("/worker/settings"); setShowMenu(false); }} className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"><Settings size={15} className="inline mr-2 -mt-0.5" aria-hidden />Settings</button>
                  <hr className="my-1" />
                  <ConfirmSignOutButton
                    className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                    icon={null}
                  />
                </div>
              </>
            )}
          </div>
        </div>
        <main className="p-4 max-w-2xl mx-auto flex-1">{children}</main>
        <footer className="border-t border-slate-200 bg-white">
          <div className="p-4 text-center">
            <p className="text-xs text-slate-400">
              BloomCore One{tenantName ? ` · ${tenantName}` : ""} · Built by BloomCore Technologies
            </p>
          </div>
        </footer>
    </div>
  );
}
