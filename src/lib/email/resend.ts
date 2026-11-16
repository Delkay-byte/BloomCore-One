/**
 * MaaCash transactional email delivery through Resend.
 *
 * One provider only. The API key and sender identity come from the environment
 * already configured for the Render service. Nothing here logs the key, the
 * recipient address, the raw token or the full action link.
 */

export interface TransactionalEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  tag?: string;
}

export interface EmailConfigStatus {
  configured: boolean;
  deliveryDisabled: boolean;
  hasApiKey: boolean;
  hasSender: boolean;
  baseUrl: string;
}

/** Safe, non-secret view of transactional-email configuration. */
export function emailConfigStatus(): EmailConfigStatus {
  return {
    configured: Boolean(process.env.RESEND_API_KEY && emailFromAddress()),
    deliveryDisabled:
      process.env.EMAIL_DELIVERY === "disabled" ||
      process.env.RESEND_DISABLED === "true",
    hasApiKey: Boolean(process.env.RESEND_API_KEY),
    hasSender: Boolean(emailFromAddress()),
    baseUrl: appBaseUrl(),
  };
}

/**
 * SEC-16 production preflight. A deliberately disabled or unconfigured
 * transactional email path must fail the deployment, not lock new accounts out
 * silently. Transient provider outages do not call this function.
 */
export function assertEmailConfigurationForProduction(): void {
  if (process.env.NODE_ENV !== "production") return;
  const status = emailConfigStatus();
  if (!status.configured || status.deliveryDisabled) {
    throw new Error(
      "Transactional email is required in production. Set RESEND_API_KEY and EMAIL_FROM_SECURITY (or EMAIL_FROM), and do not disable delivery."
    );
  }
}

export interface EmailDeliveryResult {
  ok: boolean;
  /** True when a retry could reasonably succeed later. */
  retryable?: boolean;
  /** True when delivery was intentionally skipped (test/disabled mode). */
  skipped?: boolean;
  /** Provider status when the request was made. Never includes the body. */
  status?: number;
}

interface OutboxEntry extends TransactionalEmail {
  sentAt: string;
}

const outbox: OutboxEntry[] = [];

const CANONICAL_BASE_URL = "https://maacash.bloomcoretech.com";

export function appBaseUrl(): string {
  const raw =
    process.env.SITE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXTAUTH_URL ||
    (process.env.NODE_ENV === "production" ? CANONICAL_BASE_URL : "http://localhost:3000");
  return raw.replace(/\/+$/, "");
}

export function emailFromAddress(): string {
  return (
    process.env.EMAIL_FROM_SECURITY ||
    process.env.EMAIL_FROM_NOREPLY ||
    process.env.EMAIL_FROM ||
    ""
  ).trim();
}

function deliveryDisabled(): boolean {
  if (process.env.EMAIL_DELIVERY === "disabled") return true;
  // Tests never reach the provider unless a test explicitly forces the failure
  // path with EMAIL_TEST_FORCE_PROVIDER=true and stubs fetch.
  if (process.env.NODE_ENV === "test" && process.env.EMAIL_TEST_FORCE_PROVIDER !== "true") {
    return true;
  }
  return process.env.RESEND_DISABLED === "true";
}

/** Test/diagnostic hook. Never called in production request paths. */
export function getEmailOutbox(): ReadonlyArray<OutboxEntry> {
  return outbox;
}

export function clearEmailOutbox(): void {
  outbox.length = 0;
}

/**
 * Send one transactional email.
 *
 * Test and explicitly disabled environments record the message in memory and do
 * not call the provider, so automated tests never deliver real mail. A missing
 * key or sender is a safe failure: the caller keeps the account pending and the
 * user can request another email later.
 */
export async function sendTransactionalEmail(
  email: TransactionalEmail
): Promise<EmailDeliveryResult> {
  if (deliveryDisabled()) {
    outbox.push({ ...email, sentAt: new Date().toISOString() });
    return { ok: true, skipped: true };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = emailFromAddress();
  if (!apiKey || !from) {
    console.error(
      "[email] Transactional email is not configured. Set RESEND_API_KEY and EMAIL_FROM_SECURITY (or EMAIL_FROM)."
    );
    return { ok: false };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(email.tag ? { tags: [{ name: "type", value: email.tag }] } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // Status only. The provider body can contain recipient data.
      console.error(`[email] Resend rejected a transactional email (status ${response.status}).`);
      return {
      ok: false,
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    };
    }
    return { ok: true, status: response.status };
  } catch {
    console.error("[email] Resend request failed before a response was received.");
    return { ok: false, retryable: true };
  }
}
