import {
  evaluateLocalLiveTest,
  liveTestAllowlist,
  localLiveTestEnvironment,
  requiresLocalLiveGuard,
  type LocalLiveTestDecision,
} from "./local-live-test";
import { paystackConfigured, paystackKeyMode } from "./paystack";

/**
 * ============================================================================
 * LIVE CHECKOUT READINESS — ONE HONEST ANSWER
 * ============================================================================
 *
 * The local live-payment guard answers a security question: may this process
 * move real money, for this tenant, right now? The billing page needs the same
 * answer in a form the owner can act on, without ever reading a secret.
 *
 * `liveCheckoutReadiness` is that single translation layer. It is used by:
 *
 *   * the billing overview, so the page can truthfully say whether live mobile
 *     money is available instead of showing one generic sentence;
 *   * the charge path, so a blocked attempt explains the actual missing
 *     condition instead of pretending the whole integration is off.
 *
 * The decision itself is still taken by `evaluateLocalLiveTest`; nothing here
 * relaxes it. This module only names the reason.
 */

export type LiveCheckoutCode =
  | "live_ready"
  | "not_configured"
  | "key_invalid"
  | "test_key"
  | "local_live_not_enabled"
  | "not_development"
  | "hosted_environment"
  | "payments_disabled"
  | "currency_not_ghs"
  | "origin_not_local"
  | "database_not_isolated"
  | "workspace_not_approved";

export interface LiveCheckoutReadiness {
  /** True only when a genuine live charge may be started for this workspace. */
  enabled: boolean;
  code: LiveCheckoutCode;
  /** Safe for the page and for logs. Never contains a credential. */
  message: string;
  keyMode: "live" | "test" | "unknown";
  /** True when this exact workspace is on the local live allowlist. */
  workspaceApproved: boolean;
  /** Allowlist size, for the operator; identifiers themselves stay server-side. */
  allowlistedTenants: number;
  /** Sanitized guard reason codes, for operator logs and tests. */
  reasons: string[];
}

const MESSAGES: Record<LiveCheckoutCode, string> = {
  live_ready: "Live mobile-money checkout is available for this workspace.",
  not_configured:
    "Online payments are not connected yet: the Paystack secret key is missing on this environment.",
  key_invalid:
    "Live payments are not enabled: the configured Paystack key is neither a live nor a test key.",
  test_key:
    "Live payments are not enabled: this process uses a Paystack test key, which cannot move real money.",
  local_live_not_enabled:
    "Live payments are disabled by local configuration. Enable PAYSTACK_LOCAL_LIVE_TEST=true on this machine to opt in.",
  not_development:
    "Live payments are only available in a local development process (NODE_ENV=development).",
  hosted_environment:
    "Live payments are disabled for this hosted environment. Local live testing never runs on a deployment.",
  payments_disabled: "Live payments are switched off on this environment (PAYSTACK_ENABLED).",
  currency_not_ghs: "Live payments require GHS pricing.",
  origin_not_local:
    "Live payments are only available over localhost or loopback on this machine.",
  database_not_isolated:
    "Live payments are blocked because this process is not confirmed to use an isolated local database.",
  workspace_not_approved:
    "This workspace is not approved for live local testing. Add its tenant id to PAYSTACK_LOCAL_LIVE_ALLOWED_TENANT_IDS on this machine.",
};

const REASON_TO_CODE: Record<string, LiveCheckoutCode> = {
  hosted_deployment: "hosted_environment",
  not_development: "not_development",
  local_live_test_not_enabled: "local_live_not_enabled",
  payments_disabled: "payments_disabled",
  currency_not_ghs: "currency_not_ghs",
  origin_not_loopback: "origin_not_local",
  database_not_local: "database_not_isolated",
  no_designated_tenant: "workspace_not_approved",
  tenant_not_designated: "workspace_not_approved",
  key_not_live: "test_key",
};

/** Reasons are ordered by how actionable they are for the owner. */
const REASON_PRIORITY: string[] = [
  "hosted_deployment",
  "not_development",
  "local_live_test_not_enabled",
  "payments_disabled",
  "currency_not_ghs",
  "origin_not_loopback",
  "database_not_local",
  "no_designated_tenant",
  "tenant_not_designated",
  "key_not_live",
];

/**
 * Customer-safe sentence for any checkout that the environment cannot start.
 * The detailed guard reason stays in server logs and operator diagnostics.
 */
export const PAYMENTS_UNAVAILABLE_CUSTOMER_MESSAGE =
  "Payments are temporarily unavailable. Your package selection is saved and nothing has been charged.";

/** Map an internal payment error to text that is safe to render. */
export function customerPaymentMessage(error: {
  code?: string | null;
  message: string;
}): string {
  return error.code === "live_test_blocked"
    ? PAYMENTS_UNAVAILABLE_CUSTOMER_MESSAGE
    : error.message;
}

export function readinessMessage(code: LiveCheckoutCode): string {
  return MESSAGES[code];
}

/** First actionable reason from a guard decision, if any. */
export function primaryReason(reasons: string[]): string | null {
  for (const reason of REASON_PRIORITY) {
    if (reasons.includes(reason)) return reason;
  }
  return reasons[0] ?? null;
}

export function codeForReason(reason: string | null): LiveCheckoutCode {
  if (!reason) return "workspace_not_approved";
  return REASON_TO_CODE[reason] ?? "workspace_not_approved";
}

/**
 * Explain a per-charge refusal using the sanitized codes emitted by
 * `assertLiveChargePermitted` (`live_test_blocked:reason,reason`).
 *
 * The sentence keeps the stable "not enabled for this workspace" framing that
 * the billing page and the payment tests rely on, then names the real cause.
 */
export function liveBlockedExplanation(paystackCode: string): string {
  const reasons = paystackCode.includes(":")
    ? paystackCode.slice(paystackCode.indexOf(":") + 1).split(",")
    : [];
  const code = codeForReason(primaryReason(reasons));
  if (code === "workspace_not_approved") {
    return (
      "Live payments are not enabled for this workspace in this environment. " +
      "This workspace is not approved for live local testing on this machine."
    );
  }
  if (code === "live_ready") {
    return "Live payments are not enabled for this workspace in this environment.";
  }
  // Every other message already reads as a complete explanation.
  return MESSAGES[code];
}

/**
 * Origin of the current request, for the loopback condition. Server actions and
 * route handlers can read headers; background work and unit tests fall back to
 * the configured SITE_URL.
 */
export async function currentRequestOrigin(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const headerBag = await headers();
    const origin = headerBag.get("origin");
    if (origin) return origin;
    const host = headerBag.get("x-forwarded-host") ?? headerBag.get("host");
    if (!host) return null;
    const proto =
      headerBag.get("x-forwarded-proto") ??
      (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  } catch {
    return null;
  }
}

export interface LiveReadinessInput {
  tenantId: string | null;
  tenantCode: string | null;
  /** Request origin when known; `null` falls back to SITE_URL. */
  origin?: string | null;
}

/**
 * The complete readiness answer for one workspace.
 *
 * A test key is never reported as live-ready: it is safe, but it cannot take a
 * real payment, and the billing page labels it separately.
 */
export function liveCheckoutReadiness(input: LiveReadinessInput): LiveCheckoutReadiness {
  const keyMode = paystackKeyMode();
  const allowlist = liveTestAllowlist();
  const tenantId = (input.tenantId ?? "").trim();
  const tenantCode = (input.tenantCode ?? "").trim();
  const workspaceApproved =
    allowlist.length > 0 &&
    (allowlist.includes(tenantId) || (tenantCode.length > 0 && allowlist.includes(tenantCode)));

  const base = {
    keyMode,
    workspaceApproved,
    allowlistedTenants: allowlist.length,
  };

  if (!paystackConfigured()) {
    return {
      ...base,
      enabled: false,
      code: "not_configured",
      message: MESSAGES.not_configured,
      reasons: ["not_configured"],
    };
  }
  if (keyMode === "unknown") {
    return {
      ...base,
      enabled: false,
      code: "key_invalid",
      message: MESSAGES.key_invalid,
      reasons: ["key_invalid"],
    };
  }
  if (keyMode === "test") {
    return {
      ...base,
      enabled: false,
      code: "test_key",
      message: MESSAGES.test_key,
      reasons: ["key_not_live"],
    };
  }

  const origin = input.origin ?? null;
  if (!requiresLocalLiveGuard(origin)) {
    // Hosted production commerce: the local guard does not apply, exactly as
    // `assertLiveChargePermitted` decides at charge time.
    return {
      ...base,
      enabled: true,
      code: "live_ready",
      message: "Live mobile-money checkout is available for this workspace.",
      reasons: [],
    };
  }

  const decision: LocalLiveTestDecision = evaluateLocalLiveTest(
    localLiveTestEnvironment({
      keyMode,
      origin,
      tenantId,
      tenantCode,
    })
  );
  if (decision.allowed) {
    return {
      ...base,
      enabled: true,
      code: "live_ready",
      message: "Live mobile-money checkout is available for this workspace.",
      reasons: [],
    };
  }
  const code = codeForReason(primaryReason(decision.reasons));
  return {
    ...base,
    enabled: false,
    code,
    message: MESSAGES[code],
    reasons: decision.reasons,
  };
}
