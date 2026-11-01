"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { changePassword } from "@/lib/actions/auth.actions";
import PasswordInput from "@/components/PasswordInput";

const DASHBOARD_BY_ROLE: Record<string, string> = {
  admin: "/admin/dashboard",
  worker: "/worker/dashboard",
  collector: "/collector/dashboard",
};

export default function ChangePasswordForm({
  onSuccess,
  dashboardPath,
  module,
}: {
  onSuccess?: () => void;
  /** Where to go after a successful change when no onSuccess handler is given. */
  dashboardPath?: string;
  /** Bind the change to the settings page's module cookie. */
  module?: "admin" | "momo" | "susu";
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError("");
    setSuccess("");

    const newPassword = (formData.get("newPassword") as string) || "";
    const confirmPassword = (formData.get("confirmPassword") as string) || "";

    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters");
      setLoading(false);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match");
      setLoading(false);
      return;
    }

    try {
      if (module) formData.set("module", module);
      const result = await changePassword(formData);
      if (result.success) {
        setSuccess("Password changed successfully");
        if (onSuccess) {
          onSuccess();
          return;
        }
        if (dashboardPath) {
          setTimeout(() => router.push(dashboardPath), 1200);
          return;
        }
        // Determine the workspace from the refreshed session.
        try {
          const meRes = await fetch("/api/auth/me");
          if (meRes.ok) {
            const me = await meRes.json();
            const target =
              DASHBOARD_BY_ROLE[me.role] || (me.role === "admin" ? "/admin/dashboard" : "/login");
            setTimeout(() => router.push(target), 1200);
            return;
          }
        } catch {
          /* fall through to default */
        }
        setTimeout(() => router.push("/login"), 1200);
      } else {
        setError(result.error || "Failed to change password");
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-gray-600">
        For security, please enter your current password and then your new password twice.
      </p>
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
          {success}
        </div>
      )}
      <form action={handleSubmit} className="space-y-4">
        <div className="form-group">
          <label className="form-label" htmlFor="currentPassword">
            Current Password
          </label>
          <PasswordInput
            id="currentPassword"
            name="currentPassword"
            required
            autoComplete="current-password"
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="newPassword">
            New Password
          </label>
          <PasswordInput
            id="newPassword"
            name="newPassword"
            required
            autoComplete="new-password"
            placeholder="Min 8 characters"
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="confirmPassword">
            Confirm New Password
          </label>
          <PasswordInput
            id="confirmPassword"
            name="confirmPassword"
            required
            autoComplete="new-password"
          />
        </div>
        <div className="flex gap-3 mt-4">
          <button type="submit" className="btn btn-primary flex-1" disabled={loading}>
            {loading ? "Changing..." : "Change Password"}
          </button>
        </div>
      </form>
    </div>
  );
}
