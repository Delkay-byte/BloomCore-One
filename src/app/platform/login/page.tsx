import { redirect } from "next/navigation";
import { getPlatformAdminOrNull } from "@/lib/platform-auth";
import { oidcEnabled } from "@/lib/security/oidc";
import PlatformLoginForm from "./PlatformLoginForm";

export const dynamic = "force-dynamic";

const SSO_ERRORS: Record<string, string> = {
  sso_not_authorised:
    "BloomCore Identity did not authorise this console account. Sign in with your password or contact the platform owner.",
  sso_denied:
    "Sign-in was cancelled or denied by the identity provider.",
  sso_mfa_required:
    "Your BloomCore Identity account must complete a second factor before it can be used for single sign-on.",
  sso_failed:
    "Single sign-on failed. Please try again or sign in with your password.",
  sso_attempt_expired:
    "The account linking request expired. Start the sign-in again.",
  sso_link_failed:
    "Account linking could not be completed. Please try again.",
};

const SSO_NOTICES: Record<string, string> = {
  sso_linked:
    "Account linked successfully. Use “Sign in with BloomCore Identity” from now on.",
};

// The platform login is its own security boundary. An operator with a valid
// platform session goes straight to the dashboard; tenant sessions are never
// consulted here and can never authenticate this route.
export default async function PlatformLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getPlatformAdminOrNull();
  if (session) {
    redirect(
      session.forcePasswordReset
        ? "/platform/first-login"
        : "/platform/dashboard"
    );
  }

  const params = await searchParams;
  const errorKey = typeof params.error === "string" ? params.error : "";
  const noticeKey = typeof params.notice === "string" ? params.notice : "";
  const ssoError = SSO_ERRORS[errorKey] ?? "";
  const ssoNotice = SSO_NOTICES[noticeKey] ?? "";

  return (
    <PlatformLoginForm
      ssoEnabled={oidcEnabled()}
      ssoError={ssoError}
      ssoNotice={ssoNotice}
    />
  );
}
