"use client";

import { KeyRound, ShieldCheck, Smartphone, UserRound } from "lucide-react";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import ChangePasswordForm from "@/components/ChangePasswordForm";
import OfflineDevicesSettings from "@/components/OfflineDevicesSettings";

interface UserProfile {
  id: string;
  fullName: string;
  email: string;
  role: string;
  location?: { id: string; name: string; code: string } | null;
  phone?: string | null;
}

const DASHBOARD_BY_MODULE: Record<string, string> = {
  admin: "/admin/dashboard",
  momo: "/worker/dashboard",
  susu: "/collector/dashboard",
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator",
  worker: "MoMo Worker",
  collector: "Susu Collector",
};

/**
 * Shared account settings (Profile + Change Password) rendered inside each
 * module's own authenticated area:
 *   /admin/settings, /worker/settings, /collector/settings
 */
export default function SettingsView({ module }: { module: "admin" | "momo" | "susu" }) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"profile" | "password" | "devices">("profile");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadProfile() {
    try {
      const authRes = await fetch(`/api/auth/me?module=${module === "momo" ? "momo" : module === "susu" ? "susu" : "admin"}`);
      if (!authRes.ok) {
        router.push("/login");
        return;
      }
      const authUser = await authRes.json();

      if (authUser?.userId) {
        const userRes = await fetch(`/api/user/${authUser.userId}`);
        if (userRes.ok) {
          const userData = await userRes.json();
          setProfile(userData);
        }
      }
    } catch {
      setError("Failed to load profile");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Honor the ?tab=password deep link (used by first-login force-reset redirect).
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get("tab");
    if (tabParam === "password") {
      setActiveTab("password");
    } else if (tabParam === "devices" && module === "admin") {
      setActiveTab("devices");
    }
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="spinner"></div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="card text-center">
          <p className="text-gray-500">Unable to load profile</p>
          <button onClick={() => router.push("/login")} className="btn btn-primary mt-4">
            Sign In
          </button>
        </div>
      </div>
    );
  }

  function handlePasswordChanged() {
    router.push(DASHBOARD_BY_MODULE[module] || "/login");
  }

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-500 mt-1">Manage your account settings and preferences</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-6">
          {error}
        </div>
      )}

      {/* Tab Navigation */}
      <div className="card mb-6">
        <div className="border-b border-gray-200">
          <nav className="flex gap-1 px-4 overflow-x-auto" role="tablist" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch' }}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "profile"}
              onClick={() => setActiveTab("profile")}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "profile"
                  ? "border-brand-600 text-brand-700"
                  : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
              }`}
            >
              <UserRound size={15} className="inline mr-1.5 -mt-0.5" aria-hidden />Profile
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "password"}
              onClick={() => setActiveTab("password")}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "password"
                  ? "border-brand-600 text-brand-700"
                  : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
              }`}
            >
              <KeyRound size={15} className="inline mr-1.5 -mt-0.5" aria-hidden />Change Password
            </button>
            {module === "admin" && (
              <button
                type="button"
                onClick={() => router.push("/admin/security/mfa")}
                className="px-4 py-3 text-sm font-medium border-b-2 border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
              >
                <ShieldCheck size={15} className="inline mr-1.5 -mt-0.5" aria-hidden />
                Two-factor
              </button>
            )}
            {module === "admin" && (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "devices"}
                onClick={() => setActiveTab("devices")}
                className={`px-3 sm:px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === "devices"
                    ? "border-brand-600 text-brand-700"
                    : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
                }`}
              >
                <Smartphone size={15} className="inline mr-1.5 -mt-0.5" aria-hidden /><span className="hidden sm:inline">Offline </span>Devices
              </button>
            )}
          </nav>
        </div>

        {/* Profile Tab */}
        {activeTab === "profile" && (
          <div className="p-6" role="tabpanel">
            <div className="space-y-6">
              <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg">
                <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
                  <span className="text-2xl font-bold text-green-700">
                    {profile.fullName.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-gray-900">{profile.fullName}</h2>
                  <p className="text-sm text-gray-500">
                    {ROLE_LABELS[profile.role] || profile.role}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Full Name
                  </label>
                  <p className="text-gray-900 mt-1 font-medium">{profile.fullName}</p>
                </div>
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Email
                  </label>
                  <p className="text-gray-900 mt-1 font-medium">{profile.email}</p>
                </div>
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Phone
                  </label>
                  <p className="text-gray-900 mt-1 font-medium">
                    {profile.phone || <span className="text-gray-400">Not provided</span>}
                  </p>
                </div>
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Role
                  </label>
                  <p className="text-gray-900 mt-1 font-medium">
                    {ROLE_LABELS[profile.role] || profile.role}
                  </p>
                </div>
              </div>

              {profile.location && (
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Assigned Location
                  </label>
                  <p className="text-gray-900 mt-1 font-medium">
                    {profile.location.name} ({profile.location.code})
                  </p>
                </div>
              )}

              {module !== "admin" && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <p className="text-sm text-blue-800">
                    <strong>Note:</strong> Profile information is read-only. Contact your administrator
                    to update your name, email, phone, or assigned location.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Change Password Tab */}
        {activeTab === "password" && (
          <div className="p-6" role="tabpanel">
            <ChangePasswordForm onSuccess={handlePasswordChanged} module={module} />
          </div>
        )}

        {/* Offline Devices Tab (admin only) */}
        {activeTab === "devices" && module === "admin" && (
          <div className="p-6" role="tabpanel">
            <OfflineDevicesSettings />
          </div>
        )}
      </div>

      {/* Footer attribution — shown only if parent layout doesn't already render it */}
      {/* Intentionally removed to avoid duplicate when parent layout provides it */}
    </div>
  );
}
