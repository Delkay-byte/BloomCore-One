"use client";

import { useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { platformLogin } from "@/lib/actions/platform.actions";
import PasswordInput from "@/components/PasswordInput";
import TurnstileWidget from "@/components/security/TurnstileWidget";
import { isRedirectError } from "@/lib/errors";
import { BrandLockup } from "@/components/brand/Brand";

export default function PlatformLoginForm() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [challenge, setChallenge] = useState(0);

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError("");
    try {
      const result = await platformLogin(formData);
      if (result && !result.success) {
        setError(result.error || "Login failed");
        setChallenge((value) => value + 1);
      }
    } catch (err) {
      if (isRedirectError(err)) throw err;
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-brand-950 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="text-center mb-7">
          <BrandLockup size={56} tone="dark" className="justify-center" />
          <p className="text-gold-400 mt-3 text-xs font-semibold tracking-[0.2em] uppercase">
            Platform Administration
          </p>
          <p className="text-brand-300 mt-1 text-xs">BloomCore Technologies — restricted access</p>
        </div>

        <div className="card bg-white">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck size={18} className="text-brand-600" aria-hidden />
            <h2 className="text-xl font-semibold text-slate-900">Platform Sign In</h2>
          </div>
          <p className="text-xs text-slate-500 mb-6">
            This console manages enrolled businesses. Business staff sign in from the
            standard login instead.
          </p>

          {error && (
            <div role="alert" className="banner banner-error mb-4">
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
              />
            </div>
            <TurnstileWidget action="platform_login" resetSignal={challenge} />
            <button type="submit" className="btn btn-primary w-full" disabled={loading}>
              {loading ? (
                <>
                  <span className="spinner spinner-sm" aria-hidden /> Signing in…
                </>
              ) : (
                <>
                  <KeyRound size={15} aria-hidden /> Sign In
                </>
              )}
            </button>
          </form>

          <div className="mt-6 pt-4 border-t border-slate-100 text-center">
            <a href="/login" className="text-xs text-slate-500 hover:text-slate-700">
              Business staff &amp; customer login →
            </a>
          </div>
        </div>

        <p className="text-center text-xs text-brand-400 mt-8">
          Built by BloomCore Technologies
        </p>
      </div>
    </div>
  );
}
