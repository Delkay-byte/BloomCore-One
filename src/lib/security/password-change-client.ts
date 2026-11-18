/**
 * Browser-only transport for the short-lived password-change challenge.
 * The token is deliberately kept in sessionStorage (tab-scoped) and never in a
 * URL, cookie or localStorage. It is not a session and expires after 10 minutes.
 */
export const PASSWORD_CHANGE_CHALLENGE_KEY = "maacash-password-change-challenge";
export const PASSWORD_CHANGE_SIGNIN_KEY = "maacash-password-change-signin";

/** Sign-in pages the upgrade flow may send the user back to. */
const SIGN_IN_PATHS = new Set(["/admin/login", "/login", "/platform/login"]);

/**
 * Remember where this account signs in so the mandatory-upgrade screen can send
 * them back to the right login even after the challenge itself has expired.
 * This is a routing hint only: it never authorises anything.
 */
export function rememberPasswordChangeChallenge(
  token: string,
  signInPath?: string
): void {
  try {
    window.sessionStorage.setItem(PASSWORD_CHANGE_CHALLENGE_KEY, token);
    if (signInPath && SIGN_IN_PATHS.has(signInPath)) {
      window.sessionStorage.setItem(PASSWORD_CHANGE_SIGNIN_KEY, signInPath);
    }
  } catch {
    // A blocked storage API leaves the user on the login screen; they can try
    // again in a browser that permits session storage.
  }
}

/** Sign-in page for the pending upgrade, defaulting to the shared login. */
export function passwordChangeSignInPath(): string {
  try {
    const stored = window.sessionStorage.getItem(PASSWORD_CHANGE_SIGNIN_KEY);
    return stored && SIGN_IN_PATHS.has(stored) ? stored : "/login";
  } catch {
    return "/login";
  }
}

export function clearPasswordChangeChallenge(): void {
  try {
    window.sessionStorage.removeItem(PASSWORD_CHANGE_CHALLENGE_KEY);
    window.sessionStorage.removeItem(PASSWORD_CHANGE_SIGNIN_KEY);
  } catch {
    // ignore
  }
}
