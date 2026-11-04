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
