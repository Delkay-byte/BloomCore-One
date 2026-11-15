"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, MailCheck, ShieldAlert } from "lucide-react";
import { BrandLockup } from "@/components/brand/Brand";
import {
  confirmEmailVerification,
  requestVerificationEmail,
} from "@/lib/actions/email-verification.actions";
import { isRedirectError } from "@/lib/errors";

type State = "checking" | "verified" | "failed" | "pending";

export default function VerifyEmailClient({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; email?: string }>;
}) {
  const params = use(searchParams);
  const token = params.token?.trim() ?? "";
  const [state, setState] = useState<State>(token ? "checking" : "pending");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState(params.email?.trim() ?? "");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await confirmEmailVerification(token);
        if (cancelled) return;
        if (result.success) {
          setState("verified");
        } else {
          setState("failed");
          setMessage(result.error || "This verification link could not be used.");
        }
      } catch (error) {
        if (isRedirectError(error)) throw error;
        if (!cancelled) {
          setState("failed");
          setMessage("This verification link could not be used. Request a new one.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function resend(formData: FormData) {
    setSending(true);
    setMessage("");
    setSent(false);
    try {
      const result = await requestVerificationEmail(
        String(formData.get("email") ?? "")
      );
      if (result.success) {
        setSent(true);
      } else {
        setMessage(result.error || "The verification email could not be sent.");
      }
    } catch (error) {
      if (isRedirectError(error)) throw error;
      setMessage("The verification email could not be sent right now.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-green-50 to-green-100 px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <BrandLockup size={56} className="justify-center" />
        </div>

        <div className="card">
          {state === "checking" && (
            <div aria-busy="true">
              <h1 className="text-xl font-semibold text-slate-900">Verifying your email</h1>
              <p className="mt-2 text-sm text-slate-600">Please wait a moment.</p>
            </div>
          )}

          {state === "verified" && (
            <div role="status">
              <CheckCircle2 className="text-emerald-600" size={28} aria-hidden />
              <h1 className="mt-3 text-xl font-semibold text-slate-900">
                Email verified
              </h1>
              <p className="mt-2 text-sm text-slate-600">
                Your address is confirmed. You can now sign in with your MaaCash
                password.
              </p>
              <Link href="/login" className="btn btn-primary mt-5 w-full text-center">
                Continue to sign in
              </Link>
            </div>
          )}

          {state === "failed" && (
            <div role="alert">
              <ShieldAlert className="text-red-600" size={28} aria-hidden />
              <h1 className="mt-3 text-xl font-semibold text-slate-900">
                Verification link not accepted
              </h1>
              <p className="mt-2 text-sm text-slate-600">{message}</p>
            </div>
          )}

          {state !== "verified" && (
            <div className={state === "failed" ? "mt-5 border-t border-slate-200 pt-5" : ""}>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <MailCheck size={16} aria-hidden /> Request another verification email
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Enter the address used for your MaaCash account. For security, the same
                response is shown whether or not an account exists.
              </p>
              <form action={resend} className="mt-3 space-y-3">
                <label className="form-label" htmlFor="verify-email">
                  Email address
                </label>
                <input
                  id="verify-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"
                />
                <button
                  type="submit"
                  className="btn btn-primary w-full"
                  disabled={sending}
                  aria-busy={sending}
                >
                  {sending ? "Sending…" : "Send verification email"}
                </button>
              </form>
              {sent && (
                <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">
                  If that address needs verification, a new email is on its way.
                </p>
              )}
              {message && state !== "failed" && (
                <p className="mt-3 text-sm text-red-700" role="alert">
                  {message}
                </p>
              )}
            </div>
          )}

          <p className="mt-5 text-center">
            <Link href="/login" className="text-sm text-brand-700 hover:text-brand-800">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
