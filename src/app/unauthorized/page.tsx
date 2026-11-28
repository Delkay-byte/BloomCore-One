import Link from "next/link";

/**
 * A denied page is not always an expired login. The reason is set by the
 * server guard that refused the request, so this page never has to guess and
 * never sends a signed-in person back to the login form without explaining
 * whether the problem is a role, a branch, a module or a package.
 */
const REASONS = {
  payment_required: {
    title: "Package payment required",
    message:
      "The business's paid package has ended, is awaiting payment or is suspended. The business owner can review and renew it in Billing & Plan. Existing records are safe.",
  },
  role_denied: {
    title: "This page is outside your role",
    message:
      "You are signed in, but this workspace is reserved for a different role. Sign in with the account that holds that role, or return to your own dashboard.",
  },
  branch_denied: {
    title: "This branch is outside your access",
    message:
      "Your account is limited to specific branches. This record belongs to a branch you are not authorised to open.",
  },
  feature_unavailable: {
    title: "This module is not enabled",
    message:
      "This business is not entitled to the module you requested. The business owner can review entitlements in Billing & Plan.",
  },
  session_expired: {
    title: "Your session expired",
    message: "Sign in again to continue. Nothing you saved has been lost.",
  },
  workspace_unavailable: {
    title: "Business workspace unavailable",
    message:
      "This business workspace is not open for operations. Contact your platform administrator.",
  },
} as const;

export default async function UnauthorizedPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const params = await searchParams;
  const reason =
    params.reason && params.reason in REASONS
      ? (params.reason as keyof typeof REASONS)
      : "role_denied";
  const copy = REASONS[reason];
  const isSession = reason === "session_expired";

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="max-w-lg text-center">
        <h1 className="mb-4 text-6xl font-bold text-red-500">403</h1>
        <h2 className="mb-2 text-2xl font-semibold text-slate-800">{copy.title}</h2>
        <p className="mb-6 text-slate-600">{copy.message}</p>
        <div className="flex flex-wrap justify-center gap-3">
          {reason === "payment_required" && (
            <Link href="/admin/billing?payment=required" className="btn btn-primary">
              Open Billing &amp; Plan
            </Link>
          )}
          <Link href="/login" className="btn btn-secondary">
            {isSession ? "Sign in again" : "Switch account"}
          </Link>
        </div>
        <p className="mt-6 text-xs text-slate-500">
          Reference: {reason}
        </p>
      </div>
    </div>
  );
}
