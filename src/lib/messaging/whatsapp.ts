import { createHmac, timingSafeEqual } from "crypto";

/**
 * Meta WhatsApp Cloud API configuration and adapter.
 *
 * Real delivery is OFF unless ALL of the following are true:
 *   * a token, Phone Number ID and WABA ID are configured;
 *   * WHATSAPP_DELIVERY_ENABLED=true;
 *   * the recipient appears in WHATSAPP_DELIVERY_ALLOWLIST.
 *
 * Even then the adapter only sends approved utility templates. No plain-text
 * business-initiated message is attempted outside a template.
 */

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  graphVersion: string;
  templateName: string;
  languageCode: string;
  appSecret: string;
  verifyToken: string;
  deliveryEnabled: boolean;
  allowlist: string[];
  configured: boolean;
}

export function getWhatsAppConfig(env: NodeJS.ProcessEnv = process.env): WhatsAppConfig {
  const accessToken = (env.WHATSAPP_ACCESS_TOKEN ?? "").trim();
  const phoneNumberId = (env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
  const businessAccountId = (env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? "").trim();
  const allowlist = (env.WHATSAPP_DELIVERY_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    accessToken,
    phoneNumberId,
    businessAccountId,
    graphVersion: (env.WHATSAPP_GRAPH_VERSION ?? "v23.0").trim(),
    templateName: (env.WHATSAPP_RECEIPT_TEMPLATE ?? "maacash_receipt").trim(),
    languageCode: (env.WHATSAPP_TEMPLATE_LANGUAGE ?? "en_US").trim(),
    appSecret: (env.WHATSAPP_APP_SECRET ?? "").trim(),
    verifyToken: (env.WHATSAPP_VERIFY_TOKEN ?? "").trim(),
    deliveryEnabled:
      (env.WHATSAPP_DELIVERY_ENABLED ?? "").trim().toLowerCase() === "true",
    allowlist,
    configured: Boolean(accessToken && phoneNumberId && businessAccountId),
  };
}

export interface WhatsAppTemplateMessage {
  to: string;
  templateName: string;
  languageCode: string;
  parameters: string[];
}

export type MessageProviderOutcome =
  | {
      status: "accepted";
      providerId: string;
      providerMessageId: string | null;
      error: null;
      retryable: false;
    }
  | {
      status: "simulated";
      providerId: string;
      providerMessageId: null;
      error: null;
      retryable: false;
    }
  | {
      status: "retryable";
      providerId: string;
      providerMessageId: null;
      error: string;
      retryable: true;
    }
  | {
      status: "rejected";
      providerId: string;
      providerMessageId: null;
      error: string;
      retryable: false;
    };

export interface WhatsAppProvider {
  readonly id: string;
  readonly delivers: boolean;
  sendTemplate(message: WhatsAppTemplateMessage): Promise<MessageProviderOutcome>;
}

export function sanitizeMessagingError(value: unknown): string {
  if (typeof value !== "string") return "provider_error";
  return (
    value
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[email]")
      .replace(/\b(?:\+?233|0)\d{9}\b/g, "[phone]")
      .replace(/\b\d{10,}\b/g, "[number]")
      .replace(/\bEAA[A-Za-z0-9_-]+/g, "[token]")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 200) || "provider_error"
  );
}

const E164 = /^\+[1-9]\d{6,14}$/;

export class MetaWhatsAppCloudProvider implements WhatsAppProvider {
  readonly id = "meta_cloud";
  private readonly config: WhatsAppConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: WhatsAppConfig = getWhatsAppConfig(),
    fetchImpl: typeof fetch = fetch
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  get delivers(): boolean {
    return this.config.deliveryEnabled && this.config.configured;
  }

  async sendTemplate(message: WhatsAppTemplateMessage): Promise<MessageProviderOutcome> {
    if (!this.config.configured) {
      return {
        status: "rejected",
        providerId: this.id,
        providerMessageId: null,
        error: "WhatsApp Cloud API is not configured.",
        retryable: false,
      };
    }
    if (!E164.test(message.to)) {
      return {
        status: "rejected",
        providerId: this.id,
        providerMessageId: null,
        error: "A valid E.164 WhatsApp number is required.",
        retryable: false,
      };
    }
    if (!this.config.deliveryEnabled || !this.config.allowlist.includes(message.to)) {
      return {
        status: "simulated",
        providerId: this.id,
        providerMessageId: null,
        error: null,
        retryable: false,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchImpl(
        `https://graph.facebook.com/${this.config.graphVersion}/${this.config.phoneNumberId}/messages`,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.config.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: message.to,
            type: "template",
            template: {
              name: message.templateName,
              language: { code: message.languageCode },
              components: [
                {
                  type: "body",
                  parameters: message.parameters.map((text) => ({
                    type: "text",
                    text,
                  })),
                },
              ],
            },
          }),
        }
      );
      const body = (await response.json().catch(() => null)) as
        | {
            messages?: Array<{ id?: string }>;
            error?: { message?: string; code?: number };
          }
        | null;
      if (response.ok && body?.messages?.[0]?.id) {
        return {
          status: "accepted",
          providerId: this.id,
          providerMessageId: body.messages[0].id,
          error: null,
          retryable: false,
        };
      }
      const error = sanitizeMessagingError(
        body?.error?.message ?? `http_${response.status}`
      );
      if (response.status === 429 || response.status >= 500) {
        return {
          status: "retryable",
          providerId: this.id,
          providerMessageId: null,
          error,
          retryable: true,
        };
      }
      return {
        status: "rejected",
        providerId: this.id,
        providerMessageId: null,
        error,
        retryable: false,
      };
    } catch (error) {
      return {
        status: "retryable",
        providerId: this.id,
        providerMessageId: null,
        error:
          (error as Error).name === "AbortError"
            ? "provider_timeout"
            : "provider_unavailable",
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function getWhatsAppProvider(): WhatsAppProvider {
  return new MetaWhatsAppCloudProvider();
}

/** Verify Meta's `X-Hub-Signature-256` over the exact raw body. */
export function verifyWhatsAppSignature(
  rawBody: string,
  signature: string | null,
  appSecret: string
): boolean {
  if (!signature || !appSecret) return false;
  const expected = `sha256=${createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex")}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}
