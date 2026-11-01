"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { verifyMfaLoginAction } from "@/lib/security/mfa.actions";
import { isRedirectError } from "@/lib/errors";
import { BrandLockup } from "@/components/brand/Brand";

export default function MfaVerifyForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError("");
    try {
      const result = await verifyMfaLoginAction(formData);
      if (result && !result.success) {
        setError(result.error || "Verification failed");
      }
    } catch (err) {
      if (isRedirectError(err)) throw err;
      setError("Verification failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <BrandLockup size={52} className="justify-center" />
        </div>
        <div className="card">
          <h1 className="text-xl font-semibold text-slate-900">
            Two-factor verification
          </h1>
          <p className="text-sm text-slate-500 mt-1 mb-5">
            Enter the 6-digit code from your authenticator app. You can also use
            one of your saved recovery codes.
          </p>

          {error && (
            <div className="banner banner-error mb-4 text-sm" role="alert">
              {error}
            </div>
          )}

          <form action={handleSubmit} className="space-y-4">
            <div className="form-group">
              <label className="form-label" htmlFor="code">
                Verification code
              </label>
              <input
                id="code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                maxLength={20}
                placeholder="123456"
              />
            </div>
            <button type="submit" className="btn btn-primary w-full" disabled={loading}>
              {loading ? "Verifying..." : "Verify and continue"}
            </button>
          </form>

          <button
            type="button"
            onClick={() => router.push("/login")}
            className="mt-5 text-sm text-slate-500 hover:text-slate-700"
          >
            Cancel and sign in again
          </button>
        </div>
      </div>
    </div>
  );
}
