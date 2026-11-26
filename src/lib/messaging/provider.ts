/**
 * Outbound customer-message foundation.
 *
 * No SMS or WhatsApp provider is configured in this repository. The mock
 * adapter exists so delivery can be wired to an approved provider later without
 * changing callers, templates or tests. It never opens a network connection and
 * never reports a message as sent: it returns `simulated`.
 */

export const MESSAGE_CHANNELS = ["sms", "whatsapp"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export interface OutboundMessage {
  channel: MessageChannel;
  /** E.164 recipient. Never log this value in full. */
  to: string;
  body: string;
  purpose: "receipt" | "statement" | "dispute_update";
  /** Recorded transaction or statement reference this message describes. */
  reference: string;
}

export interface MessageDeliveryResult {
  status: "sent" | "simulated" | "failed";
  providerId: string;
  providerMessageId: string | null;
  error: string | null;
}

export interface MessageProvider {
  readonly id: string;
  /** True only when the adapter can deliver outside MaaCash. */
  readonly delivers: boolean;
  send(message: OutboundMessage): Promise<MessageDeliveryResult>;
}

export const MAX_MESSAGE_LENGTH: Record<MessageChannel, number> = {
  sms: 320,
  whatsapp: 1024,
};

export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.length <= 4) return "••••";
  return `${"•".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

export function validateOutboundMessage(message: OutboundMessage): string | null {
  if (!MESSAGE_CHANNELS.includes(message.channel)) return "Unsupported message channel.";
  if (!/^\+[1-9]\d{6,14}$/.test(message.to)) {
    return "A valid E.164 recipient number is required.";
  }
  const body = message.body.trim();
  if (!body) return "The message body is empty.";
  if (body.length > MAX_MESSAGE_LENGTH[message.channel]) {
    return `The ${message.channel} message exceeds ${MAX_MESSAGE_LENGTH[message.channel]} characters.`;
  }
  if (!message.reference.trim()) return "A reference is required.";
  return null;
}

export class MockMessageProvider implements MessageProvider {
  readonly id = "mock";
  readonly delivers = false;

  async send(message: OutboundMessage): Promise<MessageDeliveryResult> {
    const error = validateOutboundMessage(message);
    if (error) {
      return {
        status: "failed",
        providerId: this.id,
        providerMessageId: null,
        error,
      };
    }
    return {
      status: "simulated",
      providerId: this.id,
      providerMessageId: null,
      error: null,
    };
  }
}

export function getMessageProvider(): MessageProvider {
  // Deliberately fixed to the mock adapter. Replacing this requires an approved
  // provider contract, credentials and delivery monitoring.
  return new MockMessageProvider();
}
