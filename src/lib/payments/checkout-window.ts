/**
 * Popup-safe checkout tab helpers (browser-safe).
 *
 * The tab must be opened synchronously inside the real click, before any
 * `await`, or a popup blocker will reject it. These helpers keep that rule
 * testable outside React.
 */

import { isTrustedCheckoutUrl } from "./checkout-url";

export interface CheckoutTab {
  closed: boolean;
  opener: unknown;
  location: { replace(url: string): void };
  close(): void;
}

type OpenWindow = (url?: string, target?: string) => CheckoutTab | null;

/** Open a blank tab and detach it from the opener (reverse tabnabbing). */
export function openBlankCheckoutTab(open?: OpenWindow): CheckoutTab | null {
  const opener =
    open ?? (typeof window !== "undefined" ? (window.open.bind(window) as OpenWindow) : null);
  if (!opener) return null;
  let tab: CheckoutTab | null = null;
  try {
    tab = opener("", "_blank");
  } catch {
    return null;
  }
  if (!tab) return null;
  try {
    tab.opener = null;
  } catch {
    // Some cross-process handles reject the assignment; navigation still works.
  }
  return tab;
}

export type CheckoutNavigation = "opened" | "closed" | "untrusted";

/** Navigate the already-open tab, but only to a trusted Paystack URL. */
export function navigateCheckoutTab(
  tab: CheckoutTab | null,
  url: unknown
): CheckoutNavigation {
  if (!isTrustedCheckoutUrl(url)) return "untrusted";
  if (!tab || tab.closed) return "closed";
  try {
    tab.location.replace(url);
    return "opened";
  } catch {
    return "closed";
  }
}
