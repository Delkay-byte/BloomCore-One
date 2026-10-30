"use client";

import { useState } from "react";
import { platformLogin } from "@/lib/actions/platform.actions";
import PasswordInput from "@/components/PasswordInput";
import { isRedirectError } from "@/lib/errors";

export default function PlatformLoginForm() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError("");
    try {
      const result = await platformLogin(formData);
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
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-900 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="text-center mb-7">
          <img
            src="/branding/bik-prestige-logo.svg"
            alt="BIK Prestige Enterprise"
            className="h-14 w-auto mx-auto rounded-lg bg-white p-2"
            width={224}
            height={112}
          />
          <p className="text-slate-300 mt-3 text-sm font-medium tracking-wide uppercase">
            Platform Administration
          </p>
          <p className="text-slate-500 mt-1 text-xs">BloomCore Technologies — restricted access</p>
        </div>

        <div className="card bg-white">
          <h2 className="text-xl font-semibold text-gray-900 mb-1">Platform Sign In</h2>
          <p className="text-xs text-gray-500 mb-6">
            This console manages enrolled businesses. Business staff sign in from the
            standard login instead.
          </p>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
              {error}
            </div>
          )}

          <form action={handleSubmit} className="space-y-4">
            <div className="form-group">
              <label className="form-label" htmlFor="email">Operator email</label>
              <input
                type="email"
                id="email"
                name="email"
                placeholder="Enter your platform operator email"
                required
                autoComplete="email"
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
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
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
              />
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

          <div className="mt-6 pt-4 border-t border-gray-100 text-center">
            <a href="/login" className="text-xs text-gray-500 hover:text-gray-700">
              Business staff &amp; customer login →
            </a>
          </div>
        </div>

        <p className="text-center text-xs text-slate-500 mt-8">
          Built by BloomCore Technologies
        </p>
      </div>
    </div>
  );
}
