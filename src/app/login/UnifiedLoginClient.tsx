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
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  Footprints,
  Lock,
  ShieldCheck,
  Smartphone,
  UserRound,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { BrandLockup } from "@/components/brand/Brand";

type RoleKey = "customer" | "momo" | "susu";

interface RoleConfig {
  key: RoleKey;
  Icon: LucideIcon;
  label: string;
  shortLabel: string;
  blurb: string;
  heading: string;
  support: string;
  identifierLabel: string;
  identifierPlaceholder: string;
  identifierHint: string;
  bullets: { icon: LucideIcon; text: string }[];
  panelNote: string;
  accent: string;
  iconTone: string;
}

const ROLES: RoleConfig[] = [
  {
    key: "momo",
    Icon: Smartphone,
    label: "MoMo Agent",
    shortLabel: "MoMo Agent",
    blurb: "Daily MoMo operations and account reconciliation",
    heading: "MoMo Agent Login",
    support:
      "Sign in to manage your daily MoMo operations and account reconciliation.",
    identifierLabel: "Email or phone",
    identifierPlaceholder: "Enter your email or phone",
    identifierHint: "Use the contact your business administrator registered for you.",
    bullets: [
      { icon: Wallet, text: "Open and close today's MoMo account" },
      { icon: BadgeCheck, text: "Record cash, float, commission and expenses" },
      { icon: ShieldCheck, text: "See the reconciliation difference before you submit" },
    ],
    panelNote: "Agent sessions are separate from administrator and collector sessions.",
    accent: "border-brand-200 hover:border-brand-500 hover:bg-brand-50",
    iconTone: "bg-brand-50 text-brand-700",
  },
  {
    key: "susu",
    Icon: Footprints,
    label: "Susu Collector",
    shortLabel: "Susu Collector",
    blurb: "Customer collections and your daily collection records",
    heading: "Susu Collector Login",
    support: "Sign in to manage customer collections and your daily collection records.",
    identifierLabel: "Email or phone",
    identifierPlaceholder: "Enter your email or phone",
    identifierHint: "Use the contact your business administrator registered for you.",
    bullets: [
      { icon: Footprints, text: "Record collections against the right customer" },
      { icon: UserRound, text: "Work from your assigned customer list" },
      { icon: Wallet, text: "Keep your daily collection records together" },
    ],
    panelNote: "Designed for field use: large tap targets and clear labels.",
    accent: "border-amber-200 hover:border-amber-500 hover:bg-amber-50",
    iconTone: "bg-amber-50 text-amber-800",
  },
  {
    key: "customer",
    Icon: UserRound,
    label: "Customer",
    shortLabel: "Customer",
    blurb: "Your Susu savings, contributions and activity",
    heading: "Welcome Back",
    support: "Sign in to view your Susu savings, contributions and account activity.",
    identifierLabel: "Phone Number or Account Number",
    identifierPlaceholder: "Enter your phone number or Account Number",
    identifierHint:
      "Enter the phone number registered to your account or the Account Number given to you by the administrator.",
    bullets: [
      { icon: Wallet, text: "See your savings and contribution history" },
      { icon: CheckCircle2, text: "Review your current Susu cycle" },
      { icon: ShieldCheck, text: "Your account details stay private to you" },
    ],
    panelNote: "This portal shows only your own Susu account. Staff tools are not available here.",
    accent: "border-indigo-200 hover:border-indigo-500 hover:bg-indigo-50",
    iconTone: "bg-indigo-50 text-indigo-700",
  },
];

const ROLE_BY_KEY = ROLES.reduce(
  (acc, role) => ({ ...acc, [role.key]: role }),
  {} as Record<RoleKey, RoleConfig>
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
  const [invalidAdmin, setInvalidAdmin] = useState(requested === "admin");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [challenge, setChallenge] = useState(0);

  const selectedConfig = selectedRole ? ROLE_BY_KEY[selectedRole] : null;
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
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (invalidAdmin) {
    return (
      <Shell>
        <div className="card text-center">
          <div className="mb-3 flex justify-center">
            <span className="rounded-2xl bg-slate-100 p-3 text-slate-600">
              <Lock size={28} aria-hidden />
            </span>
          </div>
          <h1 className="text-xl font-semibold text-slate-900">
            Please use the administrator login.
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            The administrator sign-in is kept separate for security.
          </p>
          <Link href="/admin/login" className="btn btn-primary mt-5 w-full">
            Go to Admin Login
          </Link>
          <button
            type="button"
            onClick={() => {
              setInvalidAdmin(false);
              setSelectedRole(null);
            }}
            className="mt-4 inline-flex items-center gap-1 text-sm text-slate-500 underline hover:text-slate-700"
          >
            <ArrowLeft size={14} aria-hidden /> Back to login
          </button>
        </div>
      </Shell>
    );
  }

  if (!selectedRole) {
    return (
      <Shell>
        <div className="mx-auto w-full max-w-md">
          <div className="mb-6 text-center lg:text-left">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-700">
              Sign in
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-deep">
              Who are you?
            </h1>
            <p className="mt-2 text-sm text-ink-muted">
              Select your role to continue. Each role has its own workspace and
              permissions.
            </p>
          </div>

          <div className="space-y-3">
            {ROLES.map((role) => (
              <button
                key={role.key}
                type="button"
                aria-label={role.label}
                onClick={() => setSelectedRole(role.key)}
                className={`group flex w-full items-center gap-4 rounded-2xl border-2 bg-white p-4 text-left shadow-card transition-colors ${role.accent}`}
              >
                <span className={`flex h-12 w-12 flex-none items-center justify-center rounded-xl ${role.iconTone}`}>
                  <role.Icon size={24} aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-base font-semibold text-ink-deep">
                    {role.label}
                  </span>
                  <span className="mt-0.5 block text-sm leading-snug text-ink-muted">
                    {role.blurb}
                  </span>
                </span>
                <ArrowRight
                  size={18}
                  className="ml-auto flex-none text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-slate-600"
                  aria-hidden
                />
              </button>
            ))}
          </div>

          <p className="mt-6 text-center text-sm text-ink-muted">
            Contact your administrator for account access.
          </p>
        </div>
      </Shell>
    );
  }

  const active = ROLE_BY_KEY[selectedRole];

  return (
    <Shell active={selectedConfig}>
      <div className="mx-auto w-full max-w-md">
        <div className="mb-5">
          <span
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${active.iconTone}`}
          >
            <active.Icon size={14} aria-hidden />
            {active.shortLabel}
          </span>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink-deep sm:text-3xl">
            {active.heading}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">{active.support}</p>
        </div>

        <div className="rounded-2xl border border-line bg-white p-5 shadow-raised sm:p-6">
          {passwordReset && (
            <div role="status" className="banner banner-success mb-4 text-sm">
              Password reset successful. Please sign in with your new password.
            </div>
          )}
          {error && (
            <div role="alert" aria-live="assertive" className="banner banner-error mb-4 text-sm">
              {error}
            </div>
          )}

          <form action={handleSubmit} className="space-y-4">
            <input type="hidden" name="role" value={selectedRole} />

            <div className="form-group">
              <label className="form-label" htmlFor="identifier">
                {active.identifierLabel}
              </label>
              <input
                type="text"
                id="identifier"
                name="identifier"
                autoComplete="username"
                placeholder={active.identifierPlaceholder}
                required
                aria-describedby="identifier-hint"
                className="w-full rounded-lg border border-slate-300 px-3.5 py-3 text-base outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200 sm:text-sm"
              />
              <p id="identifier-hint" className="form-hint">
                {active.identifierHint}
              </p>
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
                className="rounded-lg border border-slate-300 px-3.5 py-3 text-base outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200 sm:text-sm"
              />
              <div className="mt-1 text-right">
                <Link
                  href={selectedRole === "customer" ? "/customer/forgot-password" : "/forgot-password"}
                  className="text-xs font-medium text-brand-700 hover:text-brand-800"
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
              className="btn btn-primary w-full py-3"
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="spinner" aria-hidden />
                  Signing in…
                </span>
              ) : (
                "Sign In"
              )}
            </button>
          </form>

          <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
            <button
              type="button"
              onClick={() => {
                setError("");
                setSelectedRole(null);
              }}
              className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
            >
              <ArrowLeft size={14} aria-hidden /> Change role
            </button>
            <span className="inline-flex items-center gap-1 text-xs text-slate-400">
              <Lock size={12} aria-hidden /> Secure sign-in
            </span>
          </div>
        </div>

        <p className="mt-5 text-center text-xs leading-relaxed text-ink-faint">
          {active.panelNote}
        </p>
        <p className="mt-2 text-center text-xs text-ink-muted">
          {selectedRole === "customer"
            ? "Need help? Contact your Susu collector or the business that manages your account."
            : "Contact your administrator for account access."}
        </p>
      </div>
    </Shell>
  );
}

/**
 * Shared page frame. The forest story panel is a desktop enhancement; on a
 * phone the card carries the heading and supporting text so the form is never
 * pushed below a large decorative block.
 */
function Shell({
  children,
  active,
}: {
  children: React.ReactNode;
  active?: RoleConfig | null;
}) {
  return (
    <div className="min-h-screen bg-ivory">
      <header className="border-b border-line bg-ivory/95">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <Link href="/" aria-label="MaaCash home" className="rounded-md">
            <BrandLockup size={34} />
          </Link>
          <Link
            href="/"
            className="text-sm font-medium text-ink-muted hover:text-brand-700"
          >
            Back to website
          </Link>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-8 px-4 py-8 sm:px-6 sm:py-12 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-14 lg:px-8">
        <section className="focus-on-dark relative hidden overflow-hidden rounded-3xl bg-brand-900 p-9 text-white shadow-overlay lg:block">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full border-[28px] border-brand-800"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-28 -left-16 h-56 w-56 rounded-full border-[22px] border-brand-800"
          />
          <div className="relative">
            <BrandLockup size={40} tone="dark" descriptor />
            <p className="mt-10 text-xs font-semibold uppercase tracking-[0.18em] text-gold-300">
              {active ? active.shortLabel : "MaaCash workspace"}
            </p>
            <p className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-white">
              {active ? active.heading : "One place for the day's work."}
            </p>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-brand-100">
              {active
                ? active.support
                : "MoMo operations and Susu collections, recorded against the person and location that did the work."}
            </p>

            <ul className="mt-8 space-y-4">
              {(active
                ? active.bullets
                : [
                    { icon: Smartphone, text: "Daily MoMo account closing and reconciliation" },
                    { icon: Footprints, text: "Susu customer records and collections" },
                    { icon: ShieldCheck, text: "A separate, permission-scoped sign-in for every role" },
                  ]
              ).map((bullet) => (
                <li key={bullet.text} className="flex items-start gap-3 text-sm text-brand-50">
                  <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-brand-800 text-gold-300">
                    <bullet.icon size={16} aria-hidden />
                  </span>
                  <span className="pt-1.5">{bullet.text}</span>
                </li>
              ))}
            </ul>

            <p className="mt-10 border-t border-brand-800 pt-5 text-xs leading-relaxed text-brand-300">
              {active?.panelNote ??
                "Every sign-in is scoped to one business and one role. Access is decided on the server."}
            </p>
          </div>
        </section>

        <section className="mx-auto w-full max-w-md lg:max-w-none">{children}</section>
      </main>

      <footer className="border-t border-line">
        <p className="mx-auto max-w-6xl px-4 py-5 text-center text-xs text-ink-faint sm:px-6 lg:px-8">
          Built by BloomCore Technologies · MaaCash
        </p>
      </footer>
    </div>
  );
}
