"use client";

import { useState } from "react";
import Link from "next/link";
import { MailCheck, ShieldCheck } from "lucide-react";
import { BrandLockup } from "@/components/brand/Brand";
import { requestPasswordReset } from "@/lib/actions/password-recovery.actions";
import { isRedirectError } from "@/lib/errors";

export default function ForgotPasswordClient() {
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function submit(formData: FormData) {
    setSubmitting(true);
    setError("");
    try {
      const result = await requestPasswordReset(String(formData.get("email") ?? ""));
      if (result.success) {
        setSent(true);
      } else {
        setError(result.error || "The request could not be completed.");
      }
    } catch (err) {
      if (isRedirectError(err)) throw err;
      setError("The request could not be completed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-green-50 to-green-100 px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <BrandLockup size={56} className="justify-center" />
        </div>

        <div className="card">
          <h1 className="text-xl font-semibold text-slate-900">Forgot password</h1>
          <p className="mt-2 text-sm text-slate-600">
            Enter the email address on your MaaCash account. If the address is
            verified, we will send a single-use reset link.
          </p>

          {sent ? (
            <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4" role="status">
              <p className="flex items-center gap-2 text-sm font-semibold text-emerald-950">
                <MailCheck size={16} aria-hidden /> Check your inbox
              </p>
              <p className="mt-1 text-sm text-emerald-900">
                If that address belongs to a verified MaaCash account, a reset link
                is on its way. The link expires after 30 minutes and works once.
              </p>
            </div>
          ) : (
            <form action={submit} className="mt-5 space-y-3">
              <label className="form-label" htmlFor="reset-email">
                Email address
              </label>
              <input
                id="reset-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"
              />
              {error && (
                <p className="text-sm text-red-700" role="alert">
                  {error}
                </p>
              )}
              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={submitting}
                aria-busy={submitting}
              >
                {submitting ? "Sending…" : "Send reset link"}
              </button>
            </form>
          )}

          <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
            <p className="flex items-center gap-2 font-semibold text-slate-900">
              <ShieldCheck size={15} aria-hidden /> No email access?
            </p>
            <p className="mt-1 text-slate-600">
              Your business administrator can issue a one-time recovery code after
              verifying your identity. Recovery codes are never sent by email.
            </p>
            <Link
              href="/recover-account"
              className="mt-2 inline-block text-brand-700 underline hover:text-brand-800"
            >
              I have a recovery code
            </Link>
          </div>

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
