"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { Check, ShieldCheck } from "lucide-react";
import ChangePasswordForm from "@/components/ChangePasswordForm";
import PasswordInput from "@/components/PasswordInput";
import { BrandLockup } from "@/components/brand/Brand";
import { completeRequiredPasswordChange } from "@/lib/actions/auth.actions";
import { completeRequiredPlatformPasswordChange } from "@/lib/actions/platform.actions";
import { PASSWORD_CHANGE_CHALLENGE_KEY } from "@/lib/security/password-change-client";
import { PASSWORD_REQUIREMENTS } from "@/lib/security/password-policy";
import { isRedirectError } from "@/lib/errors";

export default function ChangePasswordPageClient({
  searchParams,
}: {
  searchParams: Promise<{ required?: string }>;
}) {
  const params = use(searchParams);
  const required = params.required === "1";

  if (!required) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-md">
          <div className="card">
            <h1 className="mb-6 text-xl font-bold">Change Password</h1>
            <ChangePasswordForm />
          </div>
        </div>
      </div>
    );
  }

  return <RequiredPasswordChange />;
}

function RequiredPasswordChange() {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [redirectTo, setRedirectTo] = useState("/login");
  const [challengeToken, setChallengeToken] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setChallengeToken(
      window.sessionStorage.getItem(PASSWORD_CHANGE_CHALLENGE_KEY) ?? ""
    );
    setReady(true);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.set("challengeToken", challengeToken);
      formData.set("newPassword", newPassword);
      formData.set("confirmPassword", confirmPassword);
      // The action verifies the signed token. Reading the unverified subject is
      // only a routing hint and cannot grant anything.
      const result =
        challengeSubjectType(challengeToken) === "platform"
          ? await completeRequiredPlatformPasswordChange(formData)
          : await completeRequiredPasswordChange(formData);
      if (!result.success) {
        setError(result.error || "The password could not be changed.");
        return;
      }
      window.sessionStorage.removeItem(PASSWORD_CHANGE_CHALLENGE_KEY);
      setRedirectTo(result.redirectTo ?? "/login");
      setDone(true);
    } catch (err) {
      if (isRedirectError(err)) throw err;
      setError("The password could not be changed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (!ready) {
    return (
      <Standalone>
        <p className="text-sm text-slate-600" aria-busy="true">
          Checking your password-change session…
        </p>
      </Standalone>
    );
  }

  if (!challengeToken && !done) {
    return (
      <Standalone>
        <h1 className="text-xl font-semibold text-slate-900">
          Password change session expired
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Sign in again with your current password to continue the required upgrade.
        </p>
        <Link href="/login" className="btn btn-primary mt-5 w-full text-center">
          Back to sign in
        </Link>
      </Standalone>
    );
  }

  if (done) {
    return (
      <Standalone>
        <ShieldCheck className="text-emerald-600" size={28} aria-hidden />
        <h1 className="mt-3 text-xl font-semibold text-slate-900">Password updated</h1>
        <p className="mt-2 text-sm text-slate-600">
          Your account meets the new password policy. Sign in again with the new
          password to open your workspace.
        </p>
        <Link
          href={redirectTo}
          className="btn btn-primary mt-5 w-full text-center"
        >
          Sign in
        </Link>
      </Standalone>
    );
  }

  return (
    <Standalone>
      <h1 className="text-xl font-semibold text-slate-900">
        Set a new password to continue
      </h1>
      <p className="mt-2 text-sm text-slate-600">
        Your current password still works, but MaaCash now requires the stronger
        password policy for every account. Enter a new password to finish signing in.
      </p>

      {error && (
        <div className="banner banner-error mt-4 text-sm" role="alert">
          {error}
        </div>
      )}

      <form onSubmit={submit} className="mt-4 space-y-4">
        <div>
          <label className="form-label" htmlFor="required-new-password">
            New password
          </label>
          <PasswordInput
            id="required-new-password"
            name="newPassword"
            autoComplete="new-password"
            required
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="required-confirm-password">
            Confirm new password
          </label>
          <PasswordInput
            id="required-confirm-password"
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
          {loading ? "Updating…" : "Update password and continue"}
        </button>
      </form>
    </Standalone>
  );
}

function challengeSubjectType(token: string): string {
  try {
    const payload = token.split(".")[1];
    if (!payload) return "";
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(payload.length / 4) * 4,
      "="
    );
    const json = JSON.parse(atob(padded)) as { subjectType?: string };
    return json.subjectType ?? "";
  } catch {
    return "";
  }
}

function Standalone({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-green-50 to-green-100 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <BrandLockup size={56} className="justify-center" />
        </div>
        <div className="card">{children}</div>
      </div>
    </div>
  );
}
