/**
 * Shared, dependency-free checkout helpers.
 *
 * This module is imported by both the server adapter and the browser component,
 * so it must never import environment, crypto or database code.
 */

/** Paystack may only send the customer to these hosts. */
const TRUSTED_CHECKOUT_HOSTS = new Set(["checkout.paystack.com", "paystack.com"]);

/** Methods the hosted page is asked to offer. UnionPay rides on `card`. */
export const HOSTED_CHECKOUT_CHANNELS = [
  "mobile_money",
  "card",
  "bank_transfer",
] as const;

export type HostedCheckoutChannel = (typeof HOSTED_CHECKOUT_CHANNELS)[number];

/** Channel lists supplied by code are checked against this allowlist. */
export function isHostedCheckoutChannel(value: unknown): value is HostedCheckoutChannel {
  return (
    value === "mobile_money" || value === "card" || value === "bank_transfer"
  );
}

/**
 * True only for an absolute HTTPS URL on a trusted Paystack checkout host.
 * User-described example links, lookalike hosts and plain HTTP are rejected
 * before any browser navigation or server response.
 */
export function isTrustedCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    TRUSTED_CHECKOUT_HOSTS.has(url.hostname) &&
    url.username === "" &&
    url.password === ""
  );
}
