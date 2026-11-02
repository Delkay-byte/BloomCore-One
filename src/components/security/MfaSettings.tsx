"use client";

import { useEffect, useState } from "react";
import {
  selfConfirmAction,
  selfDisableAction,
  selfEnrollmentAction,
} from "@/lib/security/mfa.actions";

export default function MfaSettings() {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [qr, setQr] = useState("");
  const [manualKey, setManualKey] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/mfa", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { enabled: false }))
      .then((data) => {
        if (!cancelled) {
          setEnabled(Boolean(data.enabled));
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function start() {
    setBusy(true);
    setError("");
    setMessage("");
    const result = await selfEnrollmentAction();
    setBusy(false);
    if (!result.success) {
      setError(result.error ?? "Could not start enrolment.");
      return;
    }
    setQr(result.qrDataUrl ?? "");
    setManualKey(result.manualKey ?? "");
  }

  async function confirm(formData: FormData) {
    setBusy(true);
    setError("");
    const result = await selfConfirmAction(formData);
    setBusy(false);
    if (!result.success) {
      setError(result.error ?? "Verification failed.");
      return;
    }
    setRecoveryCodes(result.recoveryCodes ?? []);
    setQr("");
    setMessage("Two-factor authentication is enabled.");
  }

  async function disable(formData: FormData) {
    setBusy(true);
    setError("");
    const result = await selfDisableAction(formData);
    setBusy(false);
    if (!result.success) {
      setError(result.error ?? "Could not disable MFA.");
      return;
    }
    setMessage("Two-factor authentication is disabled.");
    setRecoveryCodes([]);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-900">
            Authenticator app (TOTP)
          </p>
          <p className="text-xs text-slate-500">
            {enabled
              ? "Enabled — a code is required at every sign-in."
              : "Not enabled."}
          </p>
        </div>
        {!enabled && !qr && loaded && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={start} disabled={busy}>
            {busy ? "Starting..." : "Set up MFA"}
          </button>
        )}
      </div>

      {message && <div role="status" className="banner banner-success text-sm">{message}</div>}
      {error && <div role="alert" className="banner banner-error text-sm">{error}</div>}

      {qr && (
        <div className="rounded-lg border border-slate-200 p-4">
          <p className="text-sm text-slate-700 mb-3">
            Scan this code with your authenticator app, then enter the 6-digit code.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} alt="Authenticator enrolment QR code" width={200} height={200} />
          <p className="text-xs text-slate-500 mt-2 break-all">Manual key: {manualKey}</p>
          <form action={confirm} className="mt-3 flex items-end gap-2">
            <div className="form-group flex-1">
              <label className="form-label" htmlFor="code">6-digit code</label>
              <input id="code" name="code" inputMode="numeric" maxLength={6} required />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Verify
            </button>
          </form>
        </div>
      )}

      {recoveryCodes.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900 mb-2">
            Save these recovery codes now. They are shown once.
          </p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
            {recoveryCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
        </div>
      )}

      {enabled && (
        <form action={disable} className="rounded-lg border border-slate-200 p-4 space-y-3">
          <p className="text-sm font-medium text-slate-900">Disable MFA</p>
          <p className="text-xs text-slate-500">
            Re-enter your password and a current code to disable protection.
          </p>
          <div className="form-group">
            <label className="form-label" htmlFor="disable-password">Password</label>
            <input id="disable-password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="disable-code">Current code or recovery code</label>
            <input id="disable-code" name="code" required />
          </div>
          <button type="submit" className="btn btn-danger btn-sm" disabled={busy}>
            Disable MFA
          </button>
        </form>
      )}
    </div>
  );
}
