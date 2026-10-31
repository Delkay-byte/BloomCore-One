"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LayoutDashboard, Settings } from "lucide-react";
import ConfirmSignOutButton from "@/components/ConfirmSignOutButton";
import TabSessionGuard from "@/components/TabSessionGuard";
import WorkspaceSwitcher from "@/components/WorkspaceSwitcher";

export default function WorkerLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [showMenu, setShowMenu] = useState(false);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <TabSessionGuard />
      <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between sticky top-0 z-40">
        <img
          src="/branding/bik-prestige-logo.svg"
          alt="BIK Prestige Enterprise"
          className="h-8 w-auto"
          width={160}
          height={80}
        />
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
          <p className="text-xs text-slate-400">Built by BloomCore Technologies</p>
        </div>
      </footer>
    </div>
  );
}
