/**
 * SMS provider foundation.
 *
 * No SMS provider has been selected or contracted. This module therefore
 * exposes the interface and a mock adapter that never opens a network
 * connection and never reports a message as sent. A real adapter must be added
 * only with the selected provider's documented API and credentials.
 */

import { sanitizeMessagingError } from "@/lib/messaging/whatsapp";

export interface SmsMessage {
  to: string;
  body: string;
  reference: string;
}

export type SmsDeliveryOutcome =
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

export interface SmsProvider {
  readonly id: string;
  /** True only for an adapter that can deliver outside MaaCash. */
  readonly delivers: boolean;
  sendSms(message: SmsMessage): Promise<SmsDeliveryOutcome>;
}

export function getSmsProviderConfig(env: NodeJS.ProcessEnv = process.env): {
  provider: string | null;
  deliveryEnabled: boolean;
  allowlist: string[];
  ready: boolean;
} {
  const provider = (env.SMS_PROVIDER ?? "").trim() || null;
  const deliveryEnabled =
    (env.SMS_DELIVERY_ENABLED ?? "").trim().toLowerCase() === "true";
  const allowlist = (env.SMS_DELIVERY_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    provider,
    deliveryEnabled,
    allowlist,
    // A provider name alone is not an implementation. No real adapter exists.
    ready: false,
  };
}

export class MockSmsProvider implements SmsProvider {
  readonly id = "mock_sms";
  readonly delivers = false;

  async sendSms(message: SmsMessage): Promise<SmsDeliveryOutcome> {
    if (!/^\+[1-9]\d{6,14}$/.test(message.to)) {
      return {
        status: "rejected",
        providerId: this.id,
        providerMessageId: null,
        error: sanitizeMessagingError("A valid E.164 number is required."),
        retryable: false,
      };
    }
    if (!message.body.trim()) {
      return {
        status: "rejected",
        providerId: this.id,
        providerMessageId: null,
        error: "The SMS body is empty.",
        retryable: false,
      };
    }
    return {
      status: "simulated",
      providerId: this.id,
      providerMessageId: null,
      error: null,
      retryable: false,
    };
  }
}

export function getSmsProvider(): SmsProvider {
  // Deliberately fixed. Replacing this requires a contracted provider, approved
  // sender ID, delivery monitoring and a written enablement decision.
  return new MockSmsProvider();
}
