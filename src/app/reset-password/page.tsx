"use client";

import { useState } from "react";
import { completePasswordReset } from "@/lib/actions/password-recovery.actions";
import { isRedirectError } from "@/lib/errors";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PasswordInput from "@/components/PasswordInput";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const result = await completePasswordReset({
        token,
        newPassword,
        confirmPassword,
      });

      if (result.success) {
        setSuccess(true);
        // Redirect to login after a short delay
        setTimeout(() => {
          router.push("/login?reason=password_reset");
        }, 2000);
      } else {
        setError(result.error || "Something went wrong. Please try again.");
      }
    } catch (err) {
      if (isRedirectError(err)) throw err;
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-green-100 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img
            src="/branding/bik-prestige-logo.svg"
            alt="BIK Prestige Enterprise"
            className="h-16 w-auto mx-auto"
            width={256}
            height={128}
          />
        </div>

        <div className="card">
          {!success ? (
            <>
              <h2 className="text-xl font-semibold mb-2">Reset Password</h2>
              <p className="text-sm text-slate-500 mb-6">
                Enter your recovery token and create a new password.
              </p>

              {error && (
                <div className="banner banner-error mb-4 text-sm">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label className="form-label" htmlFor="token">Recovery Token</label>
                  <input
                    type="text"
                    id="token"
                    name="token"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Paste your recovery token"
                    required
                    className="font-mono text-sm"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="newPassword">New Password</label>
                  <PasswordInput
                    id="newPassword"
                    name="newPassword"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new password"
                    required
                    autoComplete="new-password"
                  />
                  <p className="form-hint">
                    At least 8 characters, with an uppercase letter and a number.
                  </p>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="confirmPassword">Confirm New Password</label>
                  <PasswordInput
                    id="confirmPassword"
                    name="confirmPassword"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm new password"
                    required
                    autoComplete="new-password"
                  />
                </div>

                <button
                  type="submit"
                  className="btn btn-primary w-full mt-2"
                  disabled={loading}
                >
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <span className="spinner"></span>
                      Resetting...
                    </span>
                  ) : "Reset Password"}
                </button>
              </form>
            </>
          ) : (
            <div className="text-center py-4">
              <p className="text-3xl mb-3">✅</p>
              <h2 className="text-xl font-semibold mb-2">Password Reset Successful</h2>
              <p className="text-sm text-slate-500 mb-4">
                Your password has been updated. You can now sign in with your new password.
              </p>
              <p className="text-xs text-slate-400">
                Redirecting to sign in...
              </p>
            </div>
          )}
        </div>

        <p className="text-center mt-6">
          <Link href="/login" className="text-sm text-brand-700 hover:text-brand-800">
            ← Back to Sign In
          </Link>
        </p>
      </div>
    </div>
  );
}
