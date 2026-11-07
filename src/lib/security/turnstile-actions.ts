/**
 * Shared Cloudflare Turnstile action labels.
 *
 * This module is intentionally dependency-free so both client components and
 * server-side verification can import the same string constants. The server
 * remains authoritative: it chooses the expected action for a protected
 * operation and rejects any token whose Cloudflare action differs.
 */
export const TURNSTILE_ACTIONS = {
  customerLogin: "customer_login",
  staffLogin: "login",
  adminLogin: "admin_login",
  platformLogin: "platform_login",
  passwordReset: "password_reset",
} as const;

export type TurnstileAction =
  (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];

/** Non-admin roles accepted by the shared `/login` portal. */
export type SharedLoginRole = "customer" | "momo" | "susu";

/**
 * The widget action for the shared login portal.
 *
 * Customer authentication is verified against `customer_login`; MoMo and Susu
 * staff authentication are both verified against `login`.
 */
export function turnstileActionForRole(role: SharedLoginRole): TurnstileAction {
  return role === "customer"
    ? TURNSTILE_ACTIONS.customerLogin
    : TURNSTILE_ACTIONS.staffLogin;
}

/**
 * Return a token only while it belongs to the currently rendered action.
 *
 * Turnstile tokens are bound to the action they were issued for. Keeping the
 * action alongside the token means a role change can never submit a stale
 * token from the previous role, even before the widget finishes re-rendering.
 */
export function activeTokenForAction(
  tokenAction: string | null,
  token: string,
  currentAction: string
): string {
  return tokenAction === currentAction ? token : "";
}
