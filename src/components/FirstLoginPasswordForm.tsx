"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, KeyRound, ShieldCheck } from "lucide-react";
import {
  changePassword,
  customerChangePassword,
} from "@/lib/actions/auth.actions";
import { platformChangePassword } from "@/lib/actions/platform.actions";
import PasswordInput from "@/components/PasswordInput";
import { BrandLockup } from "@/components/brand/Brand";
import { completeTabLogin } from "@/lib/security/tab-session-client";
import { isRedirectError } from "@/lib/errors";

export type FirstLoginMode = "staff" | "customer" | "platform";
export type StaffModule = "admin" | "momo" | "susu";

/**
 * Forced first-login password change.
 *
 * This screen is deliberately NOT rendered inside any workspace shell. A
 * person holding a one-time password has not entered the workspace yet, so the
 * navigation, tenant name and sign-out chrome must not appear. Identity still
 * comes only from the server-validated session; the browser cannot choose which
 * role is changed.
 */
export default function FirstLoginPasswordForm({
  mode,
  module,
  fullName,
  email,
  roleLabel,
  dashboardPath,
  businessName,
}: {
  mode: FirstLoginMode;
  /** Required for staff sessions so the correct module cookie is changed. */
  module?: StaffModule;
  fullName: string;
  email: string;
  roleLabel: string;
  dashboardPath: string;
  businessName?: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError("");

    try {
      if (mode === "staff" && module) {
        // Bind the change to the module this screen was opened for. Without
        // this, a browser holding more than one tenant cookie could change a
        // different account's password.
        formData.set("module", module);
      }

      const result =
        mode === "platform"
          ? await platformChangePassword(formData)
          : mode === "customer"
            ? await customerChangePassword(formData)
            : await changePassword(formData);

      if (result && !result.success) {
        setError(result.error || "Could not change your password");
        return;
      }

      // Password change rotates the session handle. Register the new handle
      // with this tab before navigating, or the next request would use the
      // revoked one.
      if (result?.sessionToken) {
        const ready = await completeTabLogin(
          result.sessionToken,
          result.redirectTo ?? dashboardPath
        );
        if (!ready) {
          setError(
            "This browser could not establish an isolated tab session. Reload the page and sign in again."
          );
        }
        return;
      }

      router.replace(dashboardPath);
      router.refresh();
    } catch (err) {
      if (isRedirectError(err)) throw err;
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-ivory">
      {/* Brand atmosphere only. No workspace navigation is rendered here. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -left-40 -top-48 h-[34rem] w-[34rem] rounded-full bg-brand-200/55 blur-3xl" />
        <div className="absolute -bottom-56 -right-40 h-[38rem] w-[38rem] rounded-full bg-gold-200/50 blur-3xl" />
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(14, 77, 52, 0.055) 1px, transparent 1px), linear-gradient(to bottom, rgba(14, 77, 52, 0.055) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
      </div>

      <div className="relative mx-auto flex min-h-screen w-full max-w-xl flex-col items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full overflow-hidden rounded-3xl border border-line bg-white shadow-[0_28px_90px_-38px_rgba(5,33,23,0.55)]">
          <div className="border-b border-line bg-brand-950 px-6 py-7 text-white sm:px-9">
            <BrandLockup size={38} tone="dark" />
            <div className="mt-6 flex items-center gap-2 text-gold-300">
              <ShieldCheck size={16} aria-hidden />
              <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.2em]">
                Secure first sign-in
              </p>
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-[1.7rem]">
              Choose a new password
            </h1>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-brand-200">
              Your temporary password must be replaced before the workspace
              opens. Signing in again will use the new password.
            </p>
          </div>

          <div className="px-6 py-7 sm:px-9 sm:py-8">
            <div className="flex items-start gap-3 rounded-xl border border-brand-100 bg-brand-50/70 px-4 py-3">
              <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-brand-700 text-xs font-semibold text-white">
                {fullName.trim().charAt(0).toUpperCase() || "?"}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-deep">{fullName}</p>
                <p className="truncate text-xs text-ink-muted">
                  {roleLabel}
                  {businessName ? ` · ${businessName}` : ""}
                </p>
                <p className="truncate text-xs text-ink-faint">{email}</p>
              </div>
            </div>

            {error && (
              <div role="alert" className="banner banner-error mt-5 text-sm">
                {error}
              </div>
            )}

            <form action={handleSubmit} className="mt-6 space-y-5">
              <div className="form-group">
                <label className="form-label" htmlFor="currentPassword">
                  Current or temporary password
                </label>
                <PasswordInput
                  id="currentPassword"
                  name="currentPassword"
                  placeholder="Enter the password you just used"
                  required
                  autoComplete="current-password"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="newPassword">
                  New password
                </label>
                <PasswordInput
                  id="newPassword"
                  name="newPassword"
                  placeholder="Choose a new password"
                  required
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
                />
                <p className="mt-1.5 text-xs text-ink-muted">
                  At least 8 characters
                  {mode === "platform"
                    ? ", including one uppercase letter and one number."
                    : "."}
                </p>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="confirmPassword">
                  Confirm new password
                </label>
                <PasswordInput
                  id="confirmPassword"
                  name="confirmPassword"
                  placeholder="Re-enter the new password"
                  required
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={loading}
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="spinner" />
                    Saving password...
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    <KeyRound size={16} aria-hidden />
                    Save password and continue
                  </span>
                )}
              </button>
            </form>

            <div className="mt-6 flex items-start gap-2 border-t border-line pt-5 text-xs text-ink-muted">
              <CheckCircle2 size={14} className="mt-0.5 flex-none text-brand-600" aria-hidden />
              <p>
                This password replaces the temporary one immediately. Other
                sessions for this account are signed out.
              </p>
            </div>
          </div>
        </div>

        <p className="relative mt-6 text-center text-xs text-ink-faint">
          MaaCash · Built by BloomCore Technologies
        </p>
      </div>
    </div>
  );
}
