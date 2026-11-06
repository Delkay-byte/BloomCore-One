"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  confirmMfaEnrollmentAction,
  finishMfaEnrollmentAction,
  startMfaEnrollmentAction,
} from "@/lib/security/mfa.actions";
import { isRedirectError } from "@/lib/errors";
import {
  clearMfaChallenge,
  completeTabLogin,
  getMfaChallenge,
} from "@/lib/security/tab-session-client";
import { BrandLockup } from "@/components/brand/Brand";

export default function MfaEnrollFlow() {
  const router = useRouter();
  const [qr, setQr] = useState("");
  const [manualKey, setManualKey] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [challenge, setChallenge] = useState("");
  const [starting, startTransition] = useTransition();

  useEffect(() => {
    const token = getMfaChallenge();
    if (!token) {
      router.replace("/login");
      return;
    }
    setChallenge(token);
    startTransition(async () => {
      const result = await startMfaEnrollmentAction(token);
      if (result.success) {
        setQr(result.qrDataUrl ?? "");
        setManualKey(result.manualKey ?? "");
      } else {
        setError(result.error ?? "Could not start enrolment.");
      }
    });
  }, [router]);

  async function handleConfirm(formData: FormData) {
    setLoading(true);
    setError("");
    try {
      const result = await confirmMfaEnrollmentAction(formData);
      if (result.success) {
        setRecoveryCodes(result.recoveryCodes ?? []);
      } else {
        setError(result.error || "Verification failed");
      }
    } catch (err) {
      if (isRedirectError(err)) throw err;
      setError("Verification failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleFinish() {
    setLoading(true);
    setError("");
    try {
      const payload = new FormData();
      payload.set("challenge", challenge);
      const result = await finishMfaEnrollmentAction(payload);
      if (!result.success || !result.sessionToken || !result.redirectTo) {
        setError(result.error || "Could not finish enrolment.");
        return;
      }
      clearMfaChallenge();
      const ready = await completeTabLogin(result.sessionToken, result.redirectTo);
      if (!ready) {
        setError(
          "This browser could not establish an isolated tab session. Reload the page and sign in again."
        );
      }
    } catch (err) {
      if (isRedirectError(err)) throw err;
      setError("Could not finish enrolment. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="text-center mb-6">
          <BrandLockup size={52} className="justify-center" />
        </div>
        <div className="card">
          {recoveryCodes.length > 0 ? (
            <>
              <h1 className="text-xl font-semibold text-slate-900">
                Save your recovery codes
              </h1>
              <p className="text-sm text-slate-500 mt-1 mb-4">
                Each code works once. Store them somewhere safe — they are the
                only way back in if you lose your authenticator.
              </p>
              <ul className="grid grid-cols-2 gap-2 font-mono text-sm bg-slate-50 border border-slate-200 rounded-lg p-4">
                {recoveryCodes.map((code) => (
                  <li key={code}>{code}</li>
                ))}
              </ul>
              <form action={handleFinish} className="mt-5">
                <input type="hidden" name="challenge" value={challenge} />
                <button type="submit" className="btn btn-primary w-full" disabled={loading}>
                  {loading ? "Opening your workspace…" : "I have saved my codes — continue"}
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold text-slate-900">
                Set up two-factor authentication
              </h1>
              <p className="text-sm text-slate-500 mt-1 mb-4">
                Administrator accounts must use an authenticator app. Scan the
                code, then enter the 6-digit code to finish.
              </p>

              {error && (
                <div role="alert" className="banner banner-error mb-4 text-sm">
                  {error}
                </div>
              )}

              {starting || !qr ? (
                <div className="text-center py-8 text-sm text-slate-500">
                  Preparing your authenticator setup...
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 mb-5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={qr}
                    alt="QR code for authenticator app enrolment"
                    width={220}
                    height={220}
                  />
                  <p className="text-xs text-slate-500 text-center">
                    Cannot scan? Enter this key manually:
                  </p>
                  <code className="text-xs break-all bg-slate-100 rounded px-2 py-1">
                    {manualKey}
                  </code>
                </div>
              )}

              <form action={handleConfirm} className="space-y-4">
                <input type="hidden" name="challenge" value={challenge} />
                <div className="form-group">
                  <label className="form-label" htmlFor="code">
                    6-digit code
                  </label>
                  <input
                    id="code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    maxLength={6}
                    placeholder="123456"
                  />
                </div>
                <button
                  type="submit"
                  className="btn btn-primary w-full"
                  disabled={loading || !qr}
                >
                  {loading ? "Verifying..." : "Enable two-factor authentication"}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
