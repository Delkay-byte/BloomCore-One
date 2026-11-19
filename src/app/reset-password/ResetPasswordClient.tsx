"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ShieldAlert } from "lucide-react";
import PasswordInput from "@/components/PasswordInput";
import Notice from "@/components/ui/Notice";
import { BrandLockup } from "@/components/brand/Brand";
import { completePasswordReset } from "@/lib/actions/password-recovery.actions";
import { PASSWORD_REQUIREMENTS } from "@/lib/security/password-policy";
import { isRedirectError } from "@/lib/errors";

export default function ResetPasswordClient({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = use(searchParams);
  const token = params.token?.trim() ?? "";
  const router = useRouter();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
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
        setTimeout(() => router.push("/login?reason=password_reset"), 1600);
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
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-green-50 to-green-100 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <BrandLockup size={56} className="justify-center" />
        </div>

        <div className="card">
          {!token ? (
            <div role="alert">
              <ShieldAlert className="text-red-600" size={28} aria-hidden />
              <h1 className="mt-3 text-xl font-semibold text-slate-900">
                Reset link missing
              </h1>
              <p className="mt-2 text-sm text-slate-600">
                Open the link from your password reset email, or request a new one.
              </p>
              <Link href="/forgot-password" className="btn btn-primary mt-5 w-full text-center">
                Request a new link
              </Link>
            </div>
          ) : success ? (
            <div role="status">
              <h1 className="text-xl font-semibold text-slate-900">Password updated</h1>
              <p className="mt-2 text-sm text-slate-600">
                Your password has been changed and existing sessions were revoked. Sign
                in with the new password.
              </p>
              <Link href="/login" className="btn btn-primary mt-5 w-full text-center">
                Sign in
              </Link>
            </div>
          ) : (
            <>
              <h1 className="text-xl font-semibold text-slate-900">Choose a new password</h1>
              <p className="mt-2 text-sm text-slate-500">
                This link expires after 30 minutes and works once.
              </p>

              {error && (
                <Notice type="error" className="mt-4 text-sm" message={error}>
                  {error}
                </Notice>
              )}

              <form onSubmit={handleSubmit} className="mt-4 space-y-4">
                <div>
                  <label className="form-label" htmlFor="new-password">
                    New password
                  </label>
                  <PasswordInput
                    id="new-password"
                    name="newPassword"
                    autoComplete="new-password"
                    required
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                </div>
                <div>
                  <label className="form-label" htmlFor="confirm-password">
                    Confirm new password
                  </label>
                  <PasswordInput
                    id="confirm-password"
                    name="confirmPassword"
                    autoComplete="new-password"
                    required
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                  />
                </div>

                <ul className="space-y-1 text-xs" aria-label="Password requirements">
                  {PASSWORD_REQUIREMENTS.map((requirement) => {
                    const met = requirement.test(newPassword);
                    return (
                      <li key={requirement.id} className={met ? "text-emerald-700" : "text-slate-500"}>
                        <Check size={12} className="mr-1 inline" aria-hidden />
                        {requirement.label}
                      </li>
                    );
                  })}
                </ul>

                <button
                  type="submit"
                  className="btn btn-primary w-full"
                  disabled={loading || !newPassword || newPassword !== confirmPassword}
                  aria-busy={loading}
                >
                  {loading ? "Updating…" : "Update password"}
                </button>
              </form>
            </>
          )}

          <p className="mt-6 text-center">
            <Link href="/login" className="text-sm text-brand-700 hover:text-brand-800">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
