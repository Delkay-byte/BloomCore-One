import { notFound } from "next/navigation";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { BrandLockup } from "@/components/brand/Brand";
import {
  attemptExpired,
  oidcEnabled,
  verifyOidcBlob,
  type OidcAttempt,
} from "@/lib/security/oidc";
import { confirmPlatformSsoLink } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  missing_password: "Enter your current platform password to confirm the link.",
  bad_password: "That password is incorrect. Try again.",
  throttled: "Too many failed attempts. Please wait a moment and try again.",
};

/**
 * /platform/login/sso/confirm?attempt=…
 *
 * Shown when the Control Center reports a PENDING association: the platform
 * administrator proves their CURRENT local password to bind the BloomCore
 * Identity subject to this console account. Reachable only when the SSO
 * feature flag is on (404 otherwise, like the rest of the SSO surface).
 */
export default async function SsoConfirmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!oidcEnabled()) notFound();

  const params = await searchParams;
  const attemptToken = typeof params.attempt === "string" ? params.attempt : "";
  const attempt = verifyOidcBlob<OidcAttempt>(attemptToken);
  const errorKey = typeof params.error === "string" ? params.error : "";
  const error = errorKey ? (ERRORS[errorKey] ?? "Something went wrong. Try again.") : "";

  const validAttempt = attempt !== null && !attemptExpired(attempt)
    ? attempt
    : null;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-brand-950 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="text-center mb-7">
          <BrandLockup size={56} tone="dark" className="justify-center" />
          <p className="text-gold-400 mt-3 text-xs font-semibold tracking-[0.2em] uppercase">
            Platform Administration
          </p>
          <p className="text-brand-300 mt-1 text-xs">BloomCore Technologies — restricted access</p>
        </div>

        <div className="card bg-white">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck size={18} className="text-brand-600" aria-hidden />
            <h2 className="text-xl font-semibold text-slate-900">Confirm SSO linking</h2>
          </div>

          {!validAttempt ? (
            <>
              <p className="text-xs text-slate-500 mb-6">
                This linking request is invalid or has expired. Start the sign-in again.
              </p>
              <Link href="/platform/login" className="btn btn-primary w-full">
                Back to sign in
              </Link>
            </>
          ) : (
            <>
              <p className="text-xs text-slate-500 mb-6">
                BloomCore Identity requested access for{" "}
                <span className="font-semibold text-slate-700">{validAttempt.idpEmail}</span>. Enter the
                current password of this console account to link it. This is a one-time step.
              </p>

              {error && (
                <div role="alert" className="banner banner-error mb-4">
                  {error}
                </div>
              )}

              <form action={confirmPlatformSsoLink} className="space-y-4">
                <input type="hidden" name="attempt" value={attemptToken} />
                <div className="form-group">
                  <label className="form-label" htmlFor="password">
                    Current platform password
                  </label>
                  <input
                    type="password"
                    id="password"
                    name="password"
                    placeholder="Enter your current platform password"
                    required
                    autoComplete="current-password"
                  />
                </div>
                <button type="submit" className="btn btn-primary w-full">
                  <ShieldCheck size={15} aria-hidden /> Link account
                </button>
              </form>

              <div className="mt-6 pt-4 border-t border-slate-100 text-center">
                <Link href="/platform/login" className="text-xs text-slate-500 hover:text-slate-700">
                  Cancel and go back
                </Link>
              </div>
            </>
          )}
        </div>

        <p className="text-center text-xs text-brand-400 mt-8">
          Built by BloomCore Technologies
        </p>
      </div>
    </div>
  );
}
