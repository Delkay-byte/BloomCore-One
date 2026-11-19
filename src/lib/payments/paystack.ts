import { createHmac, timingSafeEqual } from "crypto";
import {
  evaluateLocalLiveTest,
  localLiveTestEnvironment,
  requiresLocalLiveGuard,
} from "@/lib/payments/local-live-test";
import {
  isHostedCheckoutChannel,
  isTrustedCheckoutUrl,
  type HostedCheckoutChannel,
} from "@/lib/payments/checkout-url";

/**
 * Paystack payment adapter.
 *
 * One fixed, documented endpoint. No caller may supply a URL. The secret key is
 * server-only and is never returned, logged or placed in HTML.
 *
 * Official docs:
 *   https://paystack.com/docs/api/transaction/
 *   https://paystack.com/docs/payments/webhooks/
 */

const PAYSTACK_BASE_URL = "https://api.paystack.co";
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

/** How certain we are that the provider did *not* act on the request. */
export type PaystackFailureKind = "rejected" | "ambiguous";

export interface PaystackErrorOptions {
  providerStatus?: number;
  providerCode?: string | null;
  /** Bounded, sanitized provider explanation. Safe for protected logs. */
  safeMessage?: string | null;
  failureKind?: PaystackFailureKind;
}

export class PaystackError extends Error {
  code: string;
  providerStatus?: number;
  providerCode?: string | null;
  safeMessage?: string | null;
  failureKind: PaystackFailureKind;
  constructor(message: string, code = "paystack_error", options: PaystackErrorOptions = {}) {
    super(message);
    this.name = "PaystackError";
    this.code = code;
    this.providerStatus = options.providerStatus;
    this.providerCode = options.providerCode ?? null;
    this.safeMessage = options.safeMessage ?? null;
    this.failureKind = options.failureKind ?? "ambiguous";
  }
}

/**
 * Reduce a provider explanation to something that is safe to keep.
 *
 * Paystack error messages occasionally echo what was submitted. This strips
 * e-mail addresses, Ghana wallet numbers, long digit runs and anything shaped
 * like an API key, and caps the length so a provider cannot inject a payload
 * into our logs or the UI.
 */
export function sanitizeProviderMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[email]")
    .replace(/\b(?:\+?233|0)\d{9}\b/g, "[phone]")
    .replace(/\b\d{10,}\b/g, "[number]")
    .replace(/\b(?:sk|pk|whsec)_[A-Za-z0-9_]+/g, "[key]")
    .replace(/\s{2,}/g, " ")
    .trim();
  return text.length > 0 ? text.slice(0, 200) : null;
}

/**
 * HTTP statuses that normally mean the provider refused the request outright.
 * `409` is deliberately absent: a conflict can mean a transaction for this
 * reference already exists, which must be reconciled instead of retried.
 */
const DEFINITE_REJECTION_STATUSES = new Set([400, 401, 403, 404, 422]);

/**
 * Provider wording that means "something already exists for this reference".
 * Such an answer never proves no charge exists, whatever status carries it.
 */
const EXISTING_TRANSACTION_HINT =
  /(duplicate|already\s+(exists|been\s+used|paid|processed)|reference\s+(has\s+been\s+used|already\s+exists)|transaction\s+exists)/i;

function indicatesExistingTransaction(fields: { code: string | null; message: string | null }): boolean {
  return EXISTING_TRANSACTION_HINT.test(`${fields.code ?? ""} ${fields.message ?? ""}`);
}

function providerErrorFields(body: unknown): { code: string | null; message: string | null } {
  if (!body || typeof body !== "object") return { code: null, message: null };
  const record = body as Record<string, unknown>;
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof record.error === "string"
        ? record.error
        : null;
  const code =
    typeof record.code === "string"
      ? record.code
      : typeof record.type === "string"
        ? record.type
        : null;
  return { code: sanitizeProviderMessage(code), message: sanitizeProviderMessage(message) };
}

export function paystackConfigured(): boolean {
  return Boolean(process.env.PAYSTACK_SECRET_KEY);
}

/**
 * Whether the configured key is a live key. The prefix is not a secret, but it
 * is read from the key itself so no separate flag can drift out of sync.
 */
export function paystackKeyMode(): "live" | "test" | "unknown" {
  const key = process.env.PAYSTACK_SECRET_KEY ?? "";
  if (key.startsWith("sk_live_")) return "live";
  if (key.startsWith("sk_test_")) return "test";
  return key ? "unknown" : "unknown";
}

/**
 * Checkout is only offered when the environment can legally take the payment.
 *
 *   * A test key is safe anywhere and is used for local previews.
 *   * A live key in production is normal commerce.
 *   * A live key anywhere else moves real money from a developer machine, so it
 *     requires the explicit `PAYSTACK_LOCAL_LIVE_TEST=true` opt-in plus a
 *     development process. The per-request guard (origin, database, tenant)
 *     is enforced again when a charge is actually started.
 *   * An unrecognised prefix is never offered: we do not guess about money.
 */
export function paystackReadyForCheckout(): boolean {
  if (!paystackConfigured()) return false;
  const mode = paystackKeyMode();
  if (mode === "test") {
    // A production bundle still allows an explicit test-key preview. Test keys
    // cannot move real money, and the default remains closed.
    return process.env.NODE_ENV !== "production" || process.env.PAYSTACK_MODE === "test";
  }
  if (mode !== "live") return false;
  if (!requiresLocalLiveGuard(process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? null)) {
    // Hosted production, or a production build served on a real origin: the
    // live key works exactly as it always has.
    return true;
  }
  return isLocalLiveProcess();
}

/** The owner's opt-in, as read by the checkout gate (no request context). */
function isLocalLiveProcess(): boolean {
  return (
    (process.env.PAYSTACK_LOCAL_LIVE_TEST ?? "").trim().toLowerCase() === "true" &&
    process.env.NODE_ENV === "development"
  );
}

/**
 * Full per-request guard for a genuine live charge.
 *
 * Called immediately before a provider charge is created. Throws a
 * `PaystackError` with a sanitized code when the environment is not the
 * explicitly designated local test setup.
 */
export function assertLiveChargePermitted(input: {
  origin: string | null;
  tenantId: string;
  tenantCode: string | null;
}): void {
  if (paystackKeyMode() !== "live") return;
  if (!requiresLocalLiveGuard(input.origin)) return;
  const decision = evaluateLocalLiveTest(
    localLiveTestEnvironment({
      keyMode: paystackKeyMode(),
      origin: input.origin,
      tenantId: input.tenantId,
      tenantCode: input.tenantCode,
    })
  );
  if (!decision.allowed) {
    throw new PaystackError(
      "Live payments are only enabled for the designated local test tenant.",
      `live_test_blocked:${decision.reasons.join(",")}`
    );
  }
}

function secretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new PaystackError("Payment provider is not configured.", "not_configured");
  return key;
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) {
    throw new PaystackError("Payment provider response was too large.", "oversized_response");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new PaystackError("Payment provider response was too large.", "oversized_response");
  }
  return text;
}

async function request<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  if (!/^\/[a-z0-9_./:-]+$/i.test(path)) {
    throw new PaystackError("Invalid payment provider path.", "invalid_path");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
      ...init,
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${secretKey()}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await readBounded(response);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new PaystackError("Payment provider returned an invalid response.", "invalid_response", {
        failureKind: "ambiguous",
      });
    }
    if (!response.ok) {
      const provider = providerErrorFields(body);
      // Only a plain refusal with no hint of an existing transaction is a
      // definite rejection. A duplicate-reference conflict, or a 409, could
      // mean a charge already exists, so it stays reconciliation-required.
      const rejected =
        DEFINITE_REJECTION_STATUSES.has(response.status) &&
        !indicatesExistingTransaction(provider);
      throw new PaystackError(
        `Payment provider rejected the request (${response.status}).`,
        rejected ? "provider_rejected" : "provider_unavailable",
        {
          providerStatus: response.status,
          providerCode: provider.code,
          safeMessage: provider.message,
          failureKind: rejected ? "rejected" : "ambiguous",
        }
      );
    }
    return body as T;
  } catch (error) {
    if (error instanceof PaystackError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new PaystackError("Payment provider timed out.", "timeout", { failureKind: "ambiguous" });
    }
    throw new PaystackError("Payment provider is unavailable.", "unavailable", {
      failureKind: "ambiguous",
    });
  } finally {
    clearTimeout(timer);
  }
}

function approvedCheckoutUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new PaystackError("Payment provider did not return a checkout URL.", "invalid_checkout");
  }
  if (!isTrustedCheckoutUrl(value)) {
    throw new PaystackError(
      "Payment provider returned an unapproved checkout URL.",
      "invalid_checkout"
    );
  }
  return new URL(value).toString();
}

export interface PaystackInitialization {
  authorizationUrl: string;
  reference: string;
}

export async function initializeTransaction(input: {
  email: string;
  amountSubunit: number;
  currency: string;
  reference: string;
  callbackUrl: string;
  metadata: Record<string, string>;
  /** Payment methods the hosted page should offer. Omitted = provider default. */
  channels?: HostedCheckoutChannel[];
}): Promise<PaystackInitialization> {
  if (!Number.isInteger(input.amountSubunit) || input.amountSubunit < 1) {
    throw new PaystackError("Invalid payment amount.", "invalid_amount");
  }
  if (!/^[A-Za-z0-9._=-]{6,120}$/.test(input.reference)) {
    throw new PaystackError("Invalid payment reference.", "invalid_reference");
  }
  if (input.channels && input.channels.some((channel) => !isHostedCheckoutChannel(channel))) {
    throw new PaystackError("Unsupported payment channel.", "invalid_channel");
  }
  const body = await request<{
    status?: boolean;
    data?: { authorization_url?: string; reference?: string };
  }>("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      amount: String(input.amountSubunit),
      currency: input.currency,
      reference: input.reference,
      callback_url: input.callbackUrl,
      ...(input.channels && input.channels.length > 0
        ? { channels: Array.from(new Set(input.channels)) }
        : {}),
      metadata: JSON.stringify(input.metadata),
    }),
  });
  if (!body.status || !body.data) {
    throw new PaystackError("Payment initialization failed.", "initialization_failed");
  }
  return {
    authorizationUrl: approvedCheckoutUrl(body.data.authorization_url),
    reference: body.data.reference || input.reference,
  };
}

export interface PaystackTransaction {
  status: string;
  reference: string;
  amount: number;
  currency: string;
  paidAt: string | null;
  customerCode: string | null;
  metadata: Record<string, unknown>;
  id: number | null;
}

export async function verifyTransaction(reference: string): Promise<PaystackTransaction> {
  if (!/^[A-Za-z0-9._=-]{6,120}$/.test(reference)) {
    throw new PaystackError("Invalid payment reference.", "invalid_reference");
  }
  const body = await request<{
    status?: boolean;
    data?: {
      id?: number;
      status?: string;
      reference?: string;
      amount?: number;
      currency?: string;
      paid_at?: string | null;
      customer?: { customer_code?: string };
      metadata?: unknown;
    };
  }>(`/transaction/verify/${encodeURIComponent(reference)}`, { method: "GET" });
  if (!body.status || !body.data) {
    throw new PaystackError("Payment verification failed.", "verification_failed");
  }
  let metadata: Record<string, unknown> = {};
  if (typeof body.data.metadata === "string" && body.data.metadata.length <= 4096) {
    try {
      const parsed = JSON.parse(body.data.metadata);
      if (parsed && typeof parsed === "object") metadata = parsed as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  } else if (body.data.metadata && typeof body.data.metadata === "object") {
    metadata = body.data.metadata as Record<string, unknown>;
  }
  return {
    status: String(body.data.status ?? ""),
    reference: String(body.data.reference ?? reference),
    amount: Number(body.data.amount ?? 0),
    currency: String(body.data.currency ?? ""),
    paidAt: body.data.paid_at ?? null,
    customerCode: body.data.customer?.customer_code ?? null,
    metadata,
    id: typeof body.data.id === "number" ? body.data.id : null,
  };
}

/**
 * Read-only reconciliation lookup.
 *
 * `found: false` is a definitive "Paystack has no transaction for this
 * reference" only when the provider answers 400/404 for the lookup itself. Any
 * other failure (timeout, 5xx, malformed body) is rethrown as ambiguous so a
 * caller never mistakes "we could not ask" for "no charge exists".
 */
export async function lookupTransaction(
  reference: string
): Promise<{ found: boolean; transaction: PaystackTransaction | null }> {
  try {
    return { found: true, transaction: await verifyTransaction(reference) };
  } catch (error) {
    if (
      error instanceof PaystackError &&
      error.failureKind === "rejected" &&
      (error.providerStatus === 400 || error.providerStatus === 404)
    ) {
      return { found: false, transaction: null };
    }
    throw error;
  }
}

/** HMAC SHA-512 over the exact raw body, as documented by Paystack. */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  if (!process.env.PAYSTACK_SECRET_KEY) return false;
  const expected = createHmac("sha512", secretKey()).update(rawBody).digest("hex");
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

/* ------------------------------------------------------------------------- *
 * Webhook signing secrets
 *
 * Paystack now signs events with a dedicated webhook signing secret and sends
 * them in `Paystack-Signature`:
 *
 *   Paystack-Signature: t=<unix seconds>,v1=<key id>:<128 hex chars>[,v1=...]
 *
 * The MAC is HMAC-SHA512 over `${t}.${rawBody}` keyed with the whole signing
 * secret. The event is genuine when any `v1` matches. During a rotation the
 * dashboard emits one `v1` per active secret, so both are accepted.
 *
 * The legacy `x-paystack-signature` header stays supported until the account
 * starts delivering the new header. Once `Paystack-Signature` is present it is
 * the only accepted proof: a failing new signature is never rescued by the
 * legacy header.
 * ------------------------------------------------------------------------- */

const SIGNATURE_TOLERANCE_SECONDS = 300;
const HEX_SHA512 = /^[0-9a-f]{128}$/;

/**
 * Every configured signing secret, newest first.
 *
 * Only values with Paystack's documented `whsec_` prefix are trusted. A stale or
 * malformed value must not cause genuine, correctly signed events to be
 * rejected, so anything else is ignored and the legacy header stays in use.
 */
export function paystackSigningSecrets(): string[] {
  return [
    process.env.PAYSTACK_WEBHOOK_SIGNING_SECRET,
    process.env.PAYSTACK_WEBHOOK_SIGNING_SECRET_PREVIOUS,
  ]
    .map((value) => (value ?? "").trim())
    .filter((value) => value.startsWith("whsec_"));
}

export function paystackSignatureHeaderConfigured(): boolean {
  return paystackSigningSecrets().length > 0;
}

interface ParsedSignatureHeader {
  timestamp: number;
  signatures: string[];
}

function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") {
      if (!/^[0-9]+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === "v1") {
      const colon = value.indexOf(":");
      if (colon === -1) continue;
      const hex = value.slice(colon + 1).trim().toLowerCase();
      if (HEX_SHA512.test(hex)) signatures.push(hex);
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * Verify a `Paystack-Signature` header. Returns false for a malformed header,
 * an out-of-window timestamp, a missing signing secret or no matching v1.
 */
export function verifyPaystackSignatureHeader(
  rawBody: string,
  header: string | null,
  options: { secrets?: string[]; nowSeconds?: number } = {}
): boolean {
  if (!header) return false;
  const secrets = options.secrets ?? paystackSigningSecrets();
  if (secrets.length === 0) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const macInput = `${parsed.timestamp}.${rawBody}`;
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac("sha512", secret).update(macInput).digest("hex");
    const expectedBuffer = Buffer.from(expected);
    for (const candidate of parsed.signatures) {
      const given = Buffer.from(candidate);
      // Compare every candidate so timing does not reveal which one matched.
      if (
        given.length === expectedBuffer.length &&
        timingSafeEqual(given, expectedBuffer)
      ) {
        matched = true;
      }
    }
  }
  return matched;
}

export type PaystackSignatureScheme = "signature-header" | "legacy" | "none";

export interface PaystackWebhookVerification {
  ok: boolean;
  scheme: PaystackSignatureScheme;
  reason?: string;
}

/**
 * Verify a webhook delivery from the headers Paystack actually sent.
 *
 * Precedence: if `Paystack-Signature` is present it must verify. The legacy
 * header is used only when the new header is absent, which is exactly the
 * transition Paystack documents.
 */
export function verifyWebhookRequest(
  rawBody: string,
  headers: {
    paystackSignature?: string | null;
    legacySignature?: string | null;
  },
  options: { secrets?: string[]; nowSeconds?: number } = {}
): PaystackWebhookVerification {
  const paystackSignature = headers.paystackSignature?.trim();
  // Paystack sends both headers today. The new header can only be verified
  // when its keyed signing secret (whsec_…) is configured; without it the
  // delivery is still authenticated by the legacy header, which is an HMAC of
  // the same raw body keyed by the API secret key. There is no downgrade once a
  // signing secret exists: an invalid new header is then rejected outright.
  const canVerifyNewHeader = (options.secrets ?? paystackSigningSecrets()).length > 0;
  if (paystackSignature && canVerifyNewHeader) {
    const ok = verifyPaystackSignatureHeader(rawBody, paystackSignature, options);
    return ok
      ? { ok: true, scheme: "signature-header" }
      : { ok: false, scheme: "signature-header", reason: "invalid_signature_header" };
  }
  if (verifyWebhookSignature(rawBody, headers.legacySignature ?? null)) {
    return { ok: true, scheme: "legacy" };
  }
  return { ok: false, scheme: "none", reason: "missing_or_invalid_signature" };
}

/* ------------------------------------------------------------------------- *
 * Ghana mobile money charge
 * ------------------------------------------------------------------------- */

export type MobileMoneyProvider = "mtn" | "atl" | "vod";

export const MOBILE_MONEY_PROVIDERS: Record<MobileMoneyProvider, string> = {
  mtn: "MTN Mobile Money",
  atl: "ATMoney / Airtel Money",
  vod: "Telecel Cash",
};

export interface MobileMoneyCharge {
  reference: string;
  status: string;
  displayText: string | null;
  message: string | null;
}

/**
 * Start a Ghana mobile money charge (POST /charge).
 *
 * The customer authorises on their phone, so a `pay_offline` response only
 * means the prompt was delivered. Nothing may be treated as paid here; the
 * subscription is activated by the verified `charge.success` event or by a
 * server-side transaction verification.
 */
export async function chargeMobileMoney(input: {
  email: string;
  amountSubunit: number;
  currency: string;
  phone: string;
  provider: MobileMoneyProvider;
  reference: string;
  metadata: Record<string, string>;
}): Promise<MobileMoneyCharge> {
  if (input.currency.toUpperCase() !== "GHS") {
    throw new PaystackError("Mobile money is only available in GHS.", "invalid_currency");
  }
  if (!Number.isInteger(input.amountSubunit) || input.amountSubunit < 1) {
    throw new PaystackError("Invalid payment amount.", "invalid_amount");
  }
  if (!/^[A-Za-z0-9._=-]{6,120}$/.test(input.reference)) {
    throw new PaystackError("Invalid payment reference.", "invalid_reference");
  }
  if (!(input.provider in MOBILE_MONEY_PROVIDERS)) {
    throw new PaystackError("Unsupported mobile money network.", "invalid_provider");
  }
  if (!/^0\d{9}$/.test(input.phone)) {
    throw new PaystackError("Enter a valid Ghana mobile money number.", "invalid_phone");
  }

  const body = await request<{
    status?: boolean;
    message?: string;
    data?: { reference?: string; status?: string; display_text?: string; message?: string };
  }>("/charge", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      amount: String(input.amountSubunit),
      currency: "GHS",
      reference: input.reference,
      mobile_money: { phone: input.phone, provider: input.provider },
      metadata: JSON.stringify(input.metadata),
    }),
  });
  if (!body.status || !body.data) {
    throw new PaystackError("Mobile money charge could not be started.", "charge_failed");
  }
  return {
    reference: String(body.data.reference ?? input.reference),
    status: String(body.data.status ?? "pending").toLowerCase(),
    displayText: body.data.display_text ?? null,
    message: body.data.message ?? body.message ?? null,
  };
}

/**
 * Submit the verification code Paystack sent to the customer's phone.
 *
 * `otp` is a transient request value. It is validated, sent once and never
 * logged, stored, hashed or returned. The provider's answer decides what
 * happens next; this function never assumes the charge succeeded.
 */
export async function submitChargeOtp(input: {
  reference: string;
  otp: string;
}): Promise<MobileMoneyCharge> {
  if (!/^[A-Za-z0-9._=-]{6,120}$/.test(input.reference)) {
    throw new PaystackError("Invalid payment reference.", "invalid_reference");
  }
  if (!/^\d{4,10}$/.test(input.otp)) {
    throw new PaystackError("Enter the verification code Paystack sent to your phone.", "invalid_otp");
  }
  const body = await request<{
    status?: boolean;
    message?: string;
    data?: { reference?: string; status?: string; display_text?: string; message?: string };
  }>("/charge/submit_otp", {
    method: "POST",
    body: JSON.stringify({ otp: input.otp, reference: input.reference }),
  });
  if (!body.status || !body.data) {
    throw new PaystackError("The verification code could not be submitted.", "otp_failed");
  }
  return {
    reference: String(body.data.reference ?? input.reference),
    status: String(body.data.status ?? "pending").toLowerCase(),
    displayText: body.data.display_text ?? null,
    message: body.data.message ?? body.message ?? null,
  };
}


export interface PaystackRefund {
  id: number;
  status: "pending" | "processed" | "failed";
  amount: number;
  currency: string;
}

/**
 * Create a refund for a transaction. Official endpoint: POST /refund with the
 * transaction reference or id in `transaction`.
 *
 * The returned status is the provider's status, never an assumption. A refund
 * is not reported as processed until Paystack says so.
 */
export async function refundTransaction(reference: string): Promise<PaystackRefund> {
  if (!/^[A-Za-z0-9._=-]{6,120}$/.test(reference)) {
    throw new PaystackError("Invalid payment reference.", "invalid_reference");
  }
  const body = await request<{
    status?: boolean;
    data?: { id?: number; status?: string; amount?: number; currency?: string };
    message?: string;
  }>("/refund", {
    method: "POST",
    body: JSON.stringify({ transaction: reference }),
  });
  if (!body.status || !body.data || body.data.id == null) {
    throw new PaystackError("Payment provider rejected the refund.", "refund_failed");
  }
  const status = String(body.data.status ?? "pending").toLowerCase();
  if (status !== "pending" && status !== "processed" && status !== "failed") {
    throw new PaystackError("Payment provider returned an unknown refund state.", "invalid_response");
  }
  return {
    id: Number(body.data.id),
    status,
    amount: Number(body.data.amount ?? 0),
    currency: String(body.data.currency ?? ""),
  };
}
