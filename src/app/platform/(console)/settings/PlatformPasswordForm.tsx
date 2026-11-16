"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { platformChangePassword } from "@/lib/actions/platform.actions";
import { registerTabSession } from "@/lib/security/tab-session-client";
import { useToast } from "@/components/ui/Toast";
import PasswordPolicyChecklist from "@/components/PasswordPolicyChecklist";

export default function PlatformPasswordForm() {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError("");
    setSuccess(false);
    try {
      const result = await platformChangePassword(formData);
      if (result && !result.success) {
        setError(result.error || "Could not change password");
      } else {
        if (result?.sessionToken) {
          const ready = await registerTabSession(result.sessionToken);
          if (!ready) {
            setError(
              "Password changed, but this tab could not keep its session. Reload and sign in again."
            );
            return;
          }
        }
        setSuccess(true);
        toast.push("success", "Password changed. All other platform sessions were signed out.");
        // Refresh server components so the forced-reset banner clears.
        router.refresh();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <form action={handleSubmit} className="space-y-4 max-w-sm">
      {error && (
        <div role="alert" className="banner banner-error">
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
        />
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="newPassword">New password</label>
        <input
          type="password"
          id="newPassword"
          name="newPassword"
          required
          minLength={12}
          autoComplete="new-password"
          aria-describedby="newPassword-hint"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <div className="mt-2">
          <PasswordPolicyChecklist password={newPassword} />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="confirmPassword">Confirm new password</label>
        <input
          type="password"
          id="confirmPassword"
          name="confirmPassword"
          required
          minLength={12}
          autoComplete="new-password"
        />
      </div>
      <button type="submit" className="btn btn-primary" disabled={loading}>
        {loading ? (
          <>
            <span className="spinner spinner-sm" aria-hidden /> Changing…
          </>
        ) : (
          "Change password"
        )}
      </button>
    </form>
  );
}
