"use client";

import { useState } from "react";
import { requestPasswordReset } from "@/lib/actions/password-recovery.actions";
import { isRedirectError } from "@/lib/errors";
import Link from "next/link";
import { BrandLockup } from "@/components/brand/Brand";
import TurnstileWidget from "@/components/security/TurnstileWidget";

export default function ForgotPasswordPage() {
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [challenge, setChallenge] = useState(0);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const formData = new FormData(e.currentTarget);
    const email = String(formData.get("email") ?? "");
    const token = formData.get("cf-turnstile-response");

    try {
      const result = await requestPasswordReset(
        email,
        typeof token === "string" ? token : null
      );
      if (result.success) {
        setSubmitted(true);
      } else {
        setError(result.error || "Something went wrong. Please try again.");
        setChallenge((value) => value + 1);
      }
    } catch (err) {
      if (isRedirectError(err)) throw err;
      setError("Something went wrong. Please try again.");
      setChallenge((value) => value + 1);
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
                <div className="banner banner-error mb-4 text-sm" role="alert">
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
                    placeholder="Enter your email"
                    required
                    autoComplete="email"
                  />
                </div>

                <TurnstileWidget action="password_reset" resetSignal={challenge} />

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
                <h2 className="text-xl font-semibold mb-2">Check Your Email</h2>
                <p className="text-sm text-slate-500">
                  If an account with this email exists, recovery instructions will be sent.
                </p>
              </div>

              <Link
                href="/reset-password"
                className="btn btn-primary w-full mt-4"
              >
                I have a recovery link
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
