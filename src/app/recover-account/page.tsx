"use client";

import { useState } from "react";
import Link from "next/link";
import { redeemRecoveryCode } from "@/lib/actions/account-recovery.actions";
import { BrandLockup } from "@/components/brand/Brand";

export default function RecoverAccountPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const form = new FormData(e.currentTarget);
    const result = await redeemRecoveryCode({
      code: String(form.get("code") ?? ""),
      newPassword: String(form.get("newPassword") ?? ""),
      confirmPassword: String(form.get("confirmPassword") ?? ""),
    });
    setLoading(false);
    if (!result.success) {
      setError(result.error || "Recovery failed.");
      return;
    }
    setDone(true);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <BrandLockup size={52} className="justify-center" />
        </div>
        <div className="card">
          {done ? (
            <>
              <h1 className="text-xl font-semibold text-slate-900">Password changed</h1>
              <p className="text-sm text-slate-600 mt-2">
                All previous sessions were signed out. Sign in with your new
                password. If your account uses two-factor authentication, you
                will be asked for your authenticator code.
              </p>
              <Link href="/login" className="btn btn-primary w-full mt-5">
                Go to sign in
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold text-slate-900">Account recovery</h1>
              <p className="text-sm text-slate-500 mt-1 mb-5">
                Enter the one-time code issued by your administrator and choose
                a new password. The code expires after 30 minutes and works once.
              </p>

              {error && (
                <div className="banner banner-error mb-4 text-sm" role="alert">{error}</div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="form-group">
                  <label className="form-label" htmlFor="code">Recovery code</label>
                  <input
                    id="code"
                    name="code"
                    required
                    autoComplete="one-time-code"
                    placeholder="XXXX-XXXX-XXXX-XXXX"
                    className="font-mono"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="newPassword">New password</label>
                  <input
                    id="newPassword"
                    name="newPassword"
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    At least 8 characters, one uppercase letter and one number.
                  </p>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="confirmPassword">Confirm password</label>
                  <input
                    id="confirmPassword"
                    name="confirmPassword"
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                  />
                </div>
                <button type="submit" className="btn btn-primary w-full" disabled={loading}>
                  {loading ? "Changing password..." : "Change password"}
                </button>
              </form>

              <p className="text-center text-xs text-slate-500 mt-5">
                No code? Ask your business administrator. Business owners should
                contact the BloomCore platform administrator.
              </p>
            </>
          )}
        </div>
        <p className="text-center mt-6">
          <Link href="/login" className="text-sm text-brand-700 hover:text-brand-800">
            ← Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
