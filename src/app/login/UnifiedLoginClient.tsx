"use client";

import { use, useState } from "react";
import { unifiedLogin } from "@/lib/actions/auth.actions";
import PasswordInput from "@/components/PasswordInput";
import TurnstileWidget from "@/components/security/TurnstileWidget";
import { turnstileActionForRole } from "@/lib/security/turnstile-actions";
import {
  completeTabLogin,
  setMfaChallenge,
  tabSessionsSupported,
} from "@/lib/security/tab-session-client";
import { isRedirectError } from "@/lib/errors";
import Link from "next/link";
import { Footprints, Lock, Smartphone, UserRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { BrandLockup } from "@/components/brand/Brand";

type RoleKey = "customer" | "momo" | "susu";

const ROLES: {
  key: RoleKey;
  Icon: LucideIcon;
  label: string;
  blurb: string;
  accent: string;
}[] = [
  {
    key: "customer",
    Icon: UserRound,
    label: "Customer",
    blurb: "View your Susu savings and account",
    accent: "border-indigo-200 hover:border-indigo-400 hover:bg-indigo-50",
  },
  {
    key: "momo",
    Icon: Smartphone,
    label: "MoMo Agent",
    blurb: "Manage today's MoMo transactions",
    accent: "border-brand-200 hover:border-brand-400 hover:bg-brand-50",
  },
  {
    key: "susu",
    Icon: Footprints,
    label: "Susu Collector",
    blurb: "Manage customer savings collections",
    accent: "border-amber-200 hover:border-amber-400 hover:bg-amber-50",
  },
];

const ROLE_META: Record<RoleKey, (typeof ROLES)[number]> = ROLES.reduce(
  (acc, r) => ({ ...acc, [r.key]: r }),
  {} as Record<RoleKey, (typeof ROLES)[number]>
);

export default function UnifiedLoginClient({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; reason?: string }>;
}) {
  const sp = use(searchParams);
  const requested = sp.role?.trim();

  const [selectedRole, setSelectedRole] = useState<RoleKey | null>(
    requested === "customer" || requested === "momo" || requested === "susu"
      ? (requested as RoleKey)
      : null
  );
  const SelectedIcon = selectedRole ? ROLE_META[selectedRole].Icon : UserRound;
  const [invalidAdmin, setInvalidAdmin] = useState(requested === "admin");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [challenge, setChallenge] = useState(0);

  // Surface the "password reset successful" notice from the ?reason deep link.
  const passwordReset = sp.reason === "password_reset";

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError("");
    if (!tabSessionsSupported()) {
      setError(
        "This browser cannot safely support independent tab sessions. Enable service workers and site storage, or use a current browser."
      );
      setLoading(false);
      return;
    }
    try {
      const result = await unifiedLogin(formData);
      if (!result || !result.success) {
        if (result?.adminLogin) setInvalidAdmin(true);
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
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-slate-100 via-brand-50 to-gold-50 px-4 py-10">
      <div className="w-full max-w-md">
        {/* Brand */}
        <div className="text-center mb-7">
          <BrandLockup size={56} className="justify-center" />
          <p className="text-slate-500 mt-3 text-sm">Mobile Money, Susu & Multi-Branch Operations</p>
        </div>

        {/* Invalid admin role */}
        {invalidAdmin && (
          <div className="card">
            <div className="text-center">
              <div className="mb-3 flex justify-center">
                <Lock size={32} className="text-slate-400" aria-hidden />
              </div>
              <h2 className="text-xl font-semibold text-slate-900">Please use the administrator login.</h2>
              <p className="text-slate-500 mt-2 text-sm">
                The administrator sign-in is kept separate for security.
              </p>
              <Link href="/admin/login" className="btn btn-primary w-full mt-5 inline-block text-center">
                Go to Admin Login
              </Link>
              <button
                type="button"
                onClick={() => {
                  setInvalidAdmin(false);
                  setSelectedRole(null);
                }}
                className="text-sm text-slate-500 hover:text-slate-700 mt-4 underline"
              >
                Back to login
              </button>
            </div>
          </div>
        )}

        {/* Role selection */}
        {!invalidAdmin && !selectedRole && (
          <div className="card">
            <h2 className="text-xl font-semibold text-slate-900 text-center mb-1">Who are you?</h2>
            <p className="text-slate-500 text-center text-sm mb-6">
              Select your role to continue
            </p>
            <div className="space-y-3">
              {ROLES.map((role) => (
                <button
                  key={role.key}
                  type="button"
                  onClick={() => setSelectedRole(role.key)}
                  className={`w-full card flex items-center gap-4 text-left transition-colors border-2 ${role.accent}`}
                >
                  <role.Icon size={30} className="text-slate-700" aria-hidden="true" />
                  <span>
                    <span className="block text-lg font-semibold text-slate-900">{role.label}</span>
                    <span className="block text-sm text-slate-500">{role.blurb}</span>
                  </span>
                  <span className="ml-auto text-slate-400 font-bold text-xl">→</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Selected role + form */}
        {!invalidAdmin && selectedRole && (
          <div className="card">
            {/* Selected banner */}
            <div
              className={`rounded-lg px-4 py-3 mb-5 flex items-center gap-3 ${
                selectedRole === "customer"
                  ? "bg-indigo-50 border border-indigo-100"
                  : selectedRole === "momo"
                  ? "bg-brand-50 border border-brand-100"
                  : "bg-amber-50 border border-amber-100"
              }`}
            >
              <SelectedIcon size={24} className="text-slate-700" aria-hidden="true" />
              <span className="text-sm font-medium text-slate-700">
                You selected: <span className="font-semibold">{ROLE_META[selectedRole].label}</span>
              </span>
            </div>

            <h2 className="text-xl font-semibold text-slate-900 mb-5">
              {selectedRole === "customer" ? "Customer Sign In" : "Sign In"}
            </h2>

            {passwordReset && (
              <div role="status" className="banner banner-success mb-4 text-sm">
                ✓ Password reset successful. Please sign in with your new password.
              </div>
            )}
            {error && (
              <div role="alert" className="banner banner-error mb-4 text-sm">
                {error}
              </div>
            )}

            <form action={handleSubmit} className="space-y-4">
              <input type="hidden" name="role" value={selectedRole} />

              <div className="form-group">
                <label className="form-label" htmlFor="identifier">
                  {selectedRole === "customer"
                    ? "Customer ID, Phone or Email"
                    : "Email or Phone"}
                </label>
                <input
                  type="text"
                  id="identifier"
                  name="identifier"
                  autoComplete={selectedRole === "customer" ? "username" : "username"}
                  placeholder={
                    selectedRole === "customer"
                      ? "Enter your Customer ID, phone or email"
                      : "Enter your email or phone"
                  }
                  required
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
                  <Link
                    href={selectedRole === "customer" ? "/customer/forgot-password" : "/forgot-password"}
                    className="text-xs text-brand-700 hover:text-brand-800"
                  >
                    Forgot password?
                  </Link>
                </div>
              </div>

              <TurnstileWidget
                action={turnstileActionForRole(selectedRole)}
                resetSignal={challenge}
              />

              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={loading}
              >
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

            <button
              type="button"
              onClick={() => {
                setError("");
                setSelectedRole(null);
              }}
              className="text-sm text-slate-500 hover:text-slate-700 mt-5 inline-flex items-center gap-1"
            >
              ← Change role
            </button>
          </div>
        )}

        <p className="text-center text-sm text-slate-500 mt-6">
          Contact your administrator for account access
        </p>
      </div>
      <p className="text-center text-xs text-slate-400 mt-8">
        Built by BloomCore Technologies
      </p>
    </div>
  );
}
