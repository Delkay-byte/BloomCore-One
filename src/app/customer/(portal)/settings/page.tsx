"use client";
import { SkeletonPage } from "@/components/ui/Skeletons";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { customerChangePassword, customerLogout } from "@/lib/actions/auth.actions";
import { isRedirectError } from "@/lib/errors";
import PasswordInput from "@/components/PasswordInput";

interface UserProfile {
  fullName: string;
  email: string;
  forcePasswordReset: boolean;
}

export default function CustomerSettingsPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"profile" | "password">("profile");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Change password form state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  async function loadProfile() {
    try {
      const res = await fetch("/api/auth/me?module=customer");
      if (res.ok) {
        const data = await res.json();
        setProfile(data);
      }
    } catch {
      setError("Failed to load profile");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get("tab");
    if (tabParam === "password") {
      setActiveTab("password");
    }
    loadProfile();
  }, []);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!currentPassword || !newPassword || !confirmPassword) {
      setError("All fields are required");
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setChangingPassword(true);
    try {
      const formData = new FormData();
      formData.set("currentPassword", currentPassword);
      formData.set("newPassword", newPassword);
      formData.set("confirmPassword", confirmPassword);

      const result = await customerChangePassword(formData);
      if (result.success) {
        setSuccess("Password changed successfully");
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        // If it was a forced password reset, redirect to dashboard
        if (profile?.forcePasswordReset) {
          router.push("/customer/dashboard");
        }
      } else {
        setError(result.error || "Failed to change password");
      }
    } catch (err) {
      if (isRedirectError(err)) throw err;
      setError("An unexpected error occurred");
    } finally {
      setChangingPassword(false);
    }
  }

  async function handleLogout() {
    if (!confirm("Sign out?\n\nAre you sure you want to sign out?")) return;
    try {
      await customerLogout();
    } catch (err) {
      if (isRedirectError(err)) throw err;
    }
  }

  if (loading) return <SkeletonPage variant="form" />;

  if (!profile) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
        <div className="card text-center">
          <p className="text-slate-500">Unable to load profile</p>
          <button onClick={() => router.push("/login?role=customer")} className="btn btn-primary mt-4">
            Sign In
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="text-slate-500 mt-1">Manage your account settings and preferences</p>
      </div>

      {error && (
        <div role="alert" className="banner banner-error mb-6">
          {error}
        </div>
      )}
      {success && (
        <div role="status" className="banner banner-success mb-6">
          {success}
        </div>
      )}

      <div className="card mb-6">
        <div className="border-b border-slate-200">
          <nav className="flex gap-1 px-4 overflow-x-auto" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "profile"}
              onClick={() => setActiveTab("profile")}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "profile"
                  ? "border-blue-500 text-blue-700"
                  : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
              }`}
            >
              👤 Profile
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "password"}
              onClick={() => setActiveTab("password")}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "password"
                  ? "border-blue-500 text-blue-700"
                  : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
              }`}
            >
              🔐 Change Password
            </button>
          </nav>
        </div>

        {/* Profile Tab */}
        {activeTab === "profile" && (
          <div className="p-6" role="tabpanel">
            <div className="space-y-6">
              <div className="flex items-center gap-4 p-4 bg-blue-50 rounded-lg">
                <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center">
                  <span className="text-2xl font-bold text-blue-700">
                    {profile.fullName.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">{profile.fullName}</h2>
                  <p className="text-sm text-slate-500">Susu Customer</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white border border-slate-200 rounded-lg p-4">
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Full Name
                  </label>
                  <p className="text-slate-900 mt-1 font-medium">{profile.fullName}</p>
                </div>
                <div className="bg-white border border-slate-200 rounded-lg p-4">
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Email
                  </label>
                  <p className="text-slate-900 mt-1 font-medium">{profile.email}</p>
                </div>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-sm text-blue-800">
                  <strong>Note:</strong> Profile information is read-only. Contact your administrator
                  to update your name or email.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Change Password Tab */}
        {activeTab === "password" && (
          <div className="p-6" role="tabpanel">
            <form onSubmit={handleChangePassword}>
              <div className="space-y-4">
                <div className="form-group">
                  <label className="form-label">Current Password *</label>
                  <PasswordInput
                    name="currentPassword"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Enter current password"
                    required
                    autoComplete="current-password"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">New Password *</label>
                  <PasswordInput
                    name="newPassword"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Min 8 characters"
                    required
                    autoComplete="new-password"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Confirm New Password *</label>
                  <PasswordInput
                    name="confirmPassword"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm new password"
                    required
                    autoComplete="new-password"
                  />
                </div>
                <div className="flex gap-3 mt-6">
                  <button
                    type="submit"
                    className="btn btn-primary flex-1"
                    disabled={changingPassword}
                  >
                    {changingPassword ? "Changing..." : "Change Password"}
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push("/customer/dashboard")}
                    className="btn btn-secondary flex-1"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </form>
          </div>
        )}

        <div className="p-6 border-t border-slate-200">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 w-full transition-colors"
          >
            🚪 Sign Out
          </button>
        </div>
      </div>
    </div>
  );
}