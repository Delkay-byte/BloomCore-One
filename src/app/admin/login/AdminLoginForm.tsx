"use client";

import { useState } from "react";
import { adminLogin } from "@/lib/actions/auth.actions";
import PasswordInput from "@/components/PasswordInput";
import { markTabAuthenticated } from "@/components/TabSessionGuard";
import { isRedirectError } from "@/lib/errors";
import Link from "next/link";
import { BrandLockup } from "@/components/brand/Brand";

export default function AdminLoginForm() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [passwordReset] = useState(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search).get("reason") === "password_reset";
    }
    return false;
  });

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError("");
    markTabAuthenticated();
    try {
      const result = await adminLogin(formData);
      if (result && !result.success) {
        setError(result.error || "Login failed");
      }
    } catch (err) {
      if (isRedirectError(err)) throw err;
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-slate-100 via-brand-50 to-gold-50 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="text-center mb-7">
          <BrandLockup size={56} className="justify-center" />
          <p className="text-brand-700 mt-3 text-sm font-medium">Administrator Sign In</p>
        </div>

        <div className="card bg-white">
          <h2 className="text-xl font-semibold text-slate-900 mb-6">Administrator Sign In</h2>

          {passwordReset && (
            <div className="banner banner-success mb-4 text-sm">
              ✓ Password reset successful. Please sign in with your new password.
            </div>
          )}
          {error && (
            <div className="banner banner-error mb-4 text-sm">
              {error}
            </div>
          )}

          <form action={handleSubmit} className="space-y-4">
            <div className="form-group">
              <label className="form-label" htmlFor="email">Email</label>
              <input
                type="email"
                id="email"
                name="email"
                placeholder="Enter your administrator email"
                required
                autoComplete="email"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="password">Password</label>
              <PasswordInput
                id="password"
                name="password"
                placeholder="Enter your password"
                required
                autoComplete="current-password"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
              />
              <div className="text-right mt-1">
                <Link href="/forgot-password" className="text-xs text-brand-700 hover:text-brand-800">
                  Forgot password?
                </Link>
              </div>
            </div>
            <button type="submit" className="btn btn-primary w-full" disabled={loading}>
              {loading ? (
                <span className="flex items-center gap-2 justify-center">
                  <span className="spinner" />
                  Signing in...
                </span>
              ) : (
                "Sign In"
              )}
            </button>
          </form>

          <div className="mt-6 pt-4 border-t border-slate-100 text-center">
            <Link href="/login" className="text-xs text-slate-500 hover:text-slate-700">
              Staff &amp; customer login →
            </Link>
          </div>
        </div>

        <p className="text-center text-xs text-slate-400 mt-8">
          Built by BloomCore Technologies
        </p>
      </div>
    </div>
  );
}
