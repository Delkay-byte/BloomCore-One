"use client";

import { useState } from "react";
import { requestPasswordReset } from "@/lib/actions/password-recovery.actions";
import { isRedirectError } from "@/lib/errors";
import Link from "next/link";
import { BrandLockup } from "@/components/brand/Brand";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [pilotToken, setPilotToken] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const result = await requestPasswordReset(email);
      if (result.success) {
        setSubmitted(true);
        // Pilot mode: show the token since no email is configured yet
        if (result._pilotToken) {
          setPilotToken(result._pilotToken);
        }
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-green-100 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <BrandLockup size={56} className="justify-center" />
        </div>

        <div className="card">
          {!submitted ? (
            <>
              <h2 className="text-xl font-semibold mb-2">Forgot Password</h2>
              <p className="text-sm text-slate-500 mb-6">
                Enter your email address and we&apos;ll help you reset your password.
              </p>

              {error && (
                <div className="banner banner-error mb-4 text-sm">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label className="form-label" htmlFor="email">Email</label>
                  <input
                    type="email"
                    id="email"
                    name="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Enter your email"
                    required
                    autoComplete="email"
                  />
                </div>
                <button
                  type="submit"
                  className="btn btn-primary w-full mt-2"
                  disabled={loading}
                >
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <span className="spinner"></span>
                      Sending...
                    </span>
                  ) : "Send Recovery Instructions"}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="text-center mb-6">
                <p className="text-3xl mb-3">📧</p>
                <h2 className="text-xl font-semibold mb-2">Check Your Email</h2>
                <p className="text-sm text-slate-500">
                  If an account with this email exists, recovery instructions will be sent.
                </p>
              </div>

              {/* Pilot mode: show the recovery token directly */}
              {pilotToken && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
                  <p className="text-xs font-semibold text-yellow-800 mb-2">
                    ⚠️ Pilot Mode — No Email Configured
                  </p>
                  <p className="text-xs text-yellow-700 mb-2">
                    Copy this recovery token and paste it on the reset password page:
                  </p>
                  <div className="bg-white rounded border border-yellow-300 p-2 font-mono text-xs break-all">
                    {pilotToken}
                  </div>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(pilotToken);
                    }}
                    className="btn btn-secondary btn-sm w-full mt-2"
                  >
                    Copy Token
                  </button>
                </div>
              )}

              <Link
                href="/reset-password"
                className="btn btn-primary w-full mt-4"
              >
                Reset Password →
              </Link>
            </>
          )}
        </div>

        <p className="text-center mt-6">
          <Link href="/login" className="text-sm text-brand-700 hover:text-brand-800">
            ← Back to Sign In
          </Link>
        </p>
      </div>
    </div>
  );
}
