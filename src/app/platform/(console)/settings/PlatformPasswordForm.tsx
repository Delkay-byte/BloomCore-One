"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { platformChangePassword } from "@/lib/actions/platform.actions";

export default function PlatformPasswordForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError("");
    setSuccess(false);
    try {
      const result = await platformChangePassword(formData);
      if (result && !result.success) {
        setError(result.error || "Could not change password");
      } else {
        setSuccess(true);
        // Refresh server components so the forced-reset banner clears.
        router.refresh();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <form action={handleSubmit} className="space-y-4 max-w-sm">
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
          ✓ Password changed. All other platform sessions were signed out.
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}
      <div className="form-group">
        <label className="form-label" htmlFor="currentPassword">Current password</label>
        <input
          type="password"
          id="currentPassword"
          name="currentPassword"
          required
          autoComplete="current-password"
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5"
        />
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="newPassword">New password</label>
        <input
          type="password"
          id="newPassword"
          name="newPassword"
          required
          minLength={8}
          autoComplete="new-password"
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5"
        />
        <p className="text-xs text-gray-500 mt-1">At least 8 characters with an uppercase letter and a digit.</p>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="confirmPassword">Confirm new password</label>
        <input
          type="password"
          id="confirmPassword"
          name="confirmPassword"
          required
          minLength={8}
          autoComplete="new-password"
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5"
        />
      </div>
      <button type="submit" className="btn btn-primary" disabled={loading}>
        {loading ? "Changing..." : "Change password"}
      </button>
    </form>
  );
}
