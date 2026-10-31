"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { selectWorkspace } from "@/lib/actions/auth.actions";
import { markTabAuthenticated } from "@/components/TabSessionGuard";

interface Selection {
  userId: string;
  email: string;
  fullName: string;
  modules: ("momo" | "susu")[];
}

const MODULE_META: Record<string, { label: string; icon: string; path: string; blurb: string }> = {
  momo: {
    label: "MoMo",
    icon: "📱",
    path: "/worker/dashboard",
    blurb: "Daily MoMo accounts and reconciliation",
  },
  susu: {
    label: "Susu",
    icon: "💰",
    path: "/collector/dashboard",
    blurb: "Customer collections and contributions",
  },
};

export default function SelectWorkspacePage() {
  const router = useRouter();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyModule, setBusyModule] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/auth/selection")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Selection | null) => {
        if (data) setSelection(data);
        else router.replace("/login");
      })
      .catch(() => router.replace("/login"))
      .finally(() => setLoading(false));
  }, [router]);

  async function choose(moduleKey: "momo" | "susu") {
    setBusyModule(moduleKey);
    setError("");
    try {
      const result = await selectWorkspace(moduleKey);
      if (result.success) {
        markTabAuthenticated();
        router.push(MODULE_META[moduleKey].path);
        router.refresh();
      } else {
        setError(result.error || "Could not open the selected workspace");
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setBusyModule(null);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="spinner"></div>
      </div>
    );
  }

  if (!selection) return null;

  const firstName = selection.fullName.split(" ")[0];

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img
            src="/branding/bik-prestige-logo.svg"
            alt="BIK Prestige Enterprise"
            className="h-12 w-auto mx-auto mb-4"
            width={192}
            height={96}
          />
          <h1 className="text-xl font-bold text-slate-900">Welcome back, {firstName}</h1>
          <p className="text-slate-500 mt-1">Where would you like to work?</p>
        </div>

        {error && (
          <div className="banner banner-error mb-4 text-sm text-center">
            {error}
          </div>
        )}

        <div className="space-y-3">
          {selection.modules.map((mod) => {
            const meta = MODULE_META[mod];
            if (!meta) return null;
            return (
              <button
                key={mod}
                type="button"
                onClick={() => choose(mod)}
                disabled={busyModule !== null}
                className="w-full card flex items-center gap-4 text-left hover:border-green-300 hover:bg-green-50 transition-colors disabled:opacity-60"
              >
                <span className="text-3xl">{meta.icon}</span>
                <span>
                  <span className="block text-lg font-semibold text-slate-900">{meta.label}</span>
                  <span className="block text-sm text-slate-500">{meta.blurb}</span>
                </span>
                <span className="ml-auto text-green-600 font-bold">
                  {busyModule === mod ? "..." : "→"}
                </span>
              </button>
            );
          })}
        </div>

        <p className="text-center text-xs text-slate-400 mt-8">
          BIK Prestige Enterprise — Built by BloomCore Technologies
        </p>
      </div>
    </div>
  );
}
