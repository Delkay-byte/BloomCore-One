"use client";

import { useState } from "react";
import { adminLogin } from "@/lib/actions/auth.actions";
import PasswordInput from "@/components/PasswordInput";
import TurnstileWidget from "@/components/security/TurnstileWidget";
import {
  completeTabLogin,
  setMfaChallenge,
} from "@/lib/security/tab-session-client";
import { isRedirectError } from "@/lib/errors";
import Link from "next/link";
import { BrandLockup } from "@/components/brand/Brand";
import { CheckCircle2, ShieldCheck } from "lucide-react";

const WORKSPACE_POINTS = [
  "Your business workspace is isolated from every other tenant",
  "Mobile money and Susu records in one connected place",
  "Role-based access with a recorded audit trail",
];

export default function AdminLoginForm() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [challenge, setChallenge] = useState(0);

  const [passwordReset] = useState(() => {
    if (typeof window !== "undefined") {
      return new URLSearchParams(window.location.search).get("reason") === "password_reset";
    }
    return false;
  });

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError("");
    try {
      const result = await adminLogin(formData);
      if (!result || !result.success) {
        setError(result?.error || "Login failed");
        setChallenge((value) => value + 1);
        return;
      }
      if (result.mfaToken && result.redirectTo) {
        setMfaChallenge(result.mfaToken);
        window.location.assign(result.redirectTo);
        return;
      }
      if (result.sessionToken && result.redirectTo) {
        const ready = await completeTabLogin(result.sessionToken, result.redirectTo);
        if (!ready) {
          setError(
            "This browser could not establish an isolated tab session. Reload the page and sign in again."
          );
        }
        return;
      }
      setError("Login could not establish a tab session.");
    } catch (err) {
      if (isRedirectError(err)) throw err;
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-ivory">
      {/* Brand atmosphere: soft forest and gold light over a quiet grid. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -left-40 -top-48 h-[36rem] w-[36rem] rounded-full bg-brand-200/60 blur-3xl" />
        <div className="absolute -bottom-56 -right-40 h-[40rem] w-[40rem] rounded-full bg-gold-200/55 blur-3xl" />
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(14, 77, 52, 0.055) 1px, transparent 1px), linear-gradient(to bottom, rgba(14, 77, 52, 0.055) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
      </div>

      <div className="relative mx-auto flex min-h-screen w-full max-w-5xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
        <div className="w-full overflow-hidden rounded-3xl border border-line bg-white shadow-[0_28px_90px_-38px_rgba(5,33,23,0.55)] lg:grid lg:grid-cols-[1.02fr_0.98fr]">
          {/* Brand panel — desktop only. Keeps the sign-in page from reading as a
              blank form while staying inside the tenant boundary: no platform
              console language, no platform navigation. */}
          <aside className="relative hidden overflow-hidden bg-brand-950 p-10 text-white lg:flex lg:flex-col lg:justify-between xl:p-12">
            <div aria-hidden className="pointer-events-none absolute inset-0">
              <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full border border-brand-700/70" />
              <div className="absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-brand-800/70 blur-2xl" />
              <div className="absolute right-10 top-1/3 h-24 w-24 rounded-full bg-gold-500/10 blur-2xl" />
            </div>

            <div className="relative">
              <BrandLockup size={44} tone="dark" />
              <p className="mt-12 text-[0.6875rem] font-semibold uppercase tracking-[0.24em] text-gold-300">
                Business Administration
              </p>
              <h1 className="mt-3 max-w-sm text-3xl font-semibold leading-tight tracking-tight xl:text-[2.15rem]">
                Clearer control for the business you run.
              </h1>
              <p className="mt-4 max-w-sm text-sm leading-relaxed text-brand-200">
                Sign in to manage mobile money, Susu collections, staff and the
                records behind them — inside your own workspace.
              </p>
            </div>

            <ul className="relative mt-12 space-y-3">
              {WORKSPACE_POINTS.map((point) => (
                <li key={point} className="flex items-start gap-2.5 text-sm text-brand-100">
                  <CheckCircle2
                    size={16}
                    className="mt-0.5 flex-none text-gold-400"
                    aria-hidden
                  />
                  <span>{point}</span>
                </li>
              ))}
            </ul>

            <p className="relative mt-12 text-xs text-brand-300">
              BloomCore One · Business &amp; Financial Operations Platform
            </p>
          </aside>

          {/* Form panel */}
          <div className="p-6 sm:p-10 xl:p-12">
            <div className="mx-auto w-full max-w-sm">
              <div className="mb-8 lg:hidden">
                <BrandLockup size={38} />
                <p className="mt-2 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-ink-muted">
                  Business &amp; Financial Operations Platform
                </p>
              </div>

              <div className="flex items-center gap-2 text-brand-700">
                <ShieldCheck size={17} aria-hidden />
                <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.2em]">
                  Administrator access
                </p>
              </div>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink-deep">
                Sign in to your workspace
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                Use the administrator account issued for your business. Staff and
                customer accounts sign in from the standard login.
              </p>

              {passwordReset && (
                <div role="status" className="banner banner-success mt-6 flex items-start gap-2 text-sm">
                  <CheckCircle2 size={16} className="mt-0.5 flex-none" aria-hidden />
                  Password reset successful. Sign in with your new password.
                </div>
              )}
              {error && (
                <div role="alert" className="banner banner-error mt-6 text-sm">
                  {error}
                </div>
              )}

              <form action={handleSubmit} className="mt-7 space-y-5">
                <div className="form-group">
                  <label className="form-label" htmlFor="email">
                    Email
                  </label>
                  <input
                    type="email"
                    id="email"
                    name="email"
                    placeholder="you@business.com"
                    required
                    autoComplete="email"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="password">
                    Password
                  </label>
                  <PasswordInput
                    id="password"
                    name="password"
                    placeholder="Enter your password"
                    required
                    autoComplete="current-password"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
                  />
                  <div className="mt-1 text-right">
                    <Link
                      href="/forgot-password"
                      className="text-xs text-brand-700 hover:text-brand-800"
                    >
                      Forgot password?
                    </Link>
                  </div>
                </div>
                <TurnstileWidget action="admin_login" resetSignal={challenge} />
                <button type="submit" className="btn btn-primary w-full" disabled={loading}>
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="spinner" />
                      Signing in...
                    </span>
                  ) : (
                    "Sign In"
                  )}
                </button>
              </form>

              <div className="mt-7 border-t border-line pt-5 text-center">
                <Link href="/login" className="text-xs text-ink-muted hover:text-brand-700">
                  Staff &amp; customer login →
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>

      <p className="relative pb-6 text-center text-xs text-ink-faint">
        Built by BloomCore Technologies
      </p>
    </div>
  );
}
