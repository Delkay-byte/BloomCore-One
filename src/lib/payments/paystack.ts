import { createHmac, timingSafeEqual } from "crypto";

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

export class PaystackError extends Error {
  code: string;
  constructor(message: string, code = "paystack_error") {
    super(message);
    this.name = "PaystackError";
    this.code = code;
  }
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
 * Production must use a live key: a test key in production would either fail
 * or take a real order without settling money, so checkout stays closed with
 * an honest message until the owner configures the live key.
 */
export function paystackReadyForCheckout(): boolean {
  if (!paystackConfigured()) return false;
  if (process.env.NODE_ENV !== "production") return true;
  return paystackKeyMode() === "live";
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
      throw new PaystackError("Payment provider returned an invalid response.", "invalid_response");
    }
    if (!response.ok) {
      throw new PaystackError(
        `Payment provider rejected the request (${response.status}).`,
        "provider_rejected"
      );
    }
    return body as T;
  } catch (error) {
    if (error instanceof PaystackError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new PaystackError("Payment provider timed out.", "timeout");
    }
    throw new PaystackError("Payment provider is unavailable.", "unavailable");
  } finally {
    clearTimeout(timer);
  }
}

const CHECKOUT_HOSTS = new Set(["checkout.paystack.com", "paystack.com"]);

function approvedCheckoutUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new PaystackError("Payment provider did not return a checkout URL.", "invalid_checkout");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaystackError("Payment provider returned an invalid checkout URL.", "invalid_checkout");
  }
  if (url.protocol !== "https:" || !CHECKOUT_HOSTS.has(url.hostname)) {
    throw new PaystackError("Payment provider returned an unapproved checkout host.", "invalid_checkout");
  }
  return url.toString();
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
}): Promise<PaystackInitialization> {
  if (!Number.isInteger(input.amountSubunit) || input.amountSubunit < 1) {
    throw new PaystackError("Invalid payment amount.", "invalid_amount");
  }
  if (!/^[A-Za-z0-9._=-]{6,120}$/.test(input.reference)) {
    throw new PaystackError("Invalid payment reference.", "invalid_reference");
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
  if (paystackSignature) {
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
