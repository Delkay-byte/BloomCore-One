/**
 * One-time SSO handoff.
 *
 * OIDC completes at a cross-origin callback, which cannot call the service
 * worker directly. The callback puts the freshly minted tab session in a
 * 60-second HttpOnly cookie scoped to the SSO paths; the claim action consumes
 * it and returns the handle to the client, which registers it with its worker.
 *
 * This is deliberately not an authentication cookie: it is single-use, expires
 * in 60 seconds, is scoped away from the application, and is deleted on claim.
 */
export const SSO_HANDOFF_COOKIE = "bik-sso-handoff";
export const SSO_HANDOFF_DESTINATION_COOKIE = "bik-sso-destination";
