/**
 * Browser-only transport for the short-lived password-change challenge.
 * The token is deliberately kept in sessionStorage (tab-scoped) and never in a
 * URL, cookie or localStorage. It is not a session and expires after 10 minutes.
 */
export const PASSWORD_CHANGE_CHALLENGE_KEY = "maacash-password-change-challenge";

export function rememberPasswordChangeChallenge(token: string): void {
  try {
    window.sessionStorage.setItem(PASSWORD_CHANGE_CHALLENGE_KEY, token);
  } catch {
    // A blocked storage API leaves the user on the login screen; they can try
    // again in a browser that permits session storage.
  }
}

export function clearPasswordChangeChallenge(): void {
  try {
    window.sessionStorage.removeItem(PASSWORD_CHANGE_CHALLENGE_KEY);
  } catch {
    // ignore
  }
}
