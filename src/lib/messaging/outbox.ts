import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/security/crypto";
import { maskPhone } from "@/lib/messaging/provider";
import {
  getWhatsAppProvider,
  type WhatsAppProvider,
} from "@/lib/messaging/whatsapp";
import { getSmsProvider, type SmsProvider } from "@/lib/messaging/sms";
import {
  buildReceiptContent,
  type ReceiptInput,
} from "@/lib/messaging/receipts";
import {
  decideMessagingDelivery,
  resolveTenantMessagingConfig,
  type MessagingPurpose,
} from "@/lib/messaging/config";

/**
 * Durable customer receipt outbox.
 *
 * A row is written inside the same transaction that confirms the financial
 * event. A duplicate confirmation therefore hits the unique event key and
 * cannot create a second message. Delivery is a separate, bounded step; a
 * provider failure never rolls back a confirmed contribution or withdrawal and
 * is never mistaken for proof of delivery.
 */

export type CustomerMessageChannel = "whatsapp" | "sms";
export type CustomerMessageStatus =
  | "pending"
  | "sending"
  | "simulated"
  | "accepted"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "rejected";

const MAX_ATTEMPTS = 5;

export function normalizeE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^\+[1-9]\d{6,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.startsWith("0") && digits.length === 10) return `+233${digits.slice(1)}`;
  if (digits.startsWith("233") && digits.length === 12) return `+${digits}`;
  if (digits.length === 9) return `+233${digits}`;
  return null;
}

interface ConsentRow {
  whatsappNumber: string | null;
  whatsappStatus: string;
  whatsappOptInAt: Date | null;
  whatsappOptOutAt: Date | null;
  smsNumber: string | null;
  smsStatus: string;
  smsOptInAt: Date | null;
  smsOptOutAt: Date | null;
  preferredChannel: string | null;
}

export function channelConsented(
  preference: ConsentRow,
  channel: CustomerMessageChannel
): boolean {
  if (channel === "whatsapp") {
    return (
      normalizeE164(preference.whatsappNumber) !== null &&
      preference.whatsappStatus === "verified" &&
      preference.whatsappOptInAt !== null &&
      (preference.whatsappOptOutAt === null ||
        preference.whatsappOptInAt > preference.whatsappOptOutAt)
    );
  }
  return (
    normalizeE164(preference.smsNumber) !== null &&
    preference.smsStatus === "verified" &&
    preference.smsOptInAt !== null &&
    (preference.smsOptOutAt === null || preference.smsOptInAt > preference.smsOptOutAt)
  );
}

export function selectReceiptChannel(
  preference: ConsentRow
): CustomerMessageChannel | null {
  const preferred =
    preference.preferredChannel === "whatsapp" || preference.preferredChannel === "sms"
      ? preference.preferredChannel
      : null;
  if (preferred && channelConsented(preference, preferred)) return preferred;
  if (channelConsented(preference, "whatsapp")) return "whatsapp";
  if (channelConsented(preference, "sms")) return "sms";
  return null;
}

function recipientFor(
  preference: ConsentRow,
  channel: CustomerMessageChannel
): string | null {
  return normalizeE164(
    channel === "whatsapp" ? preference.whatsappNumber : preference.smsNumber
  );
}

export interface ReceiptEventInput {
  tenantId: string;
  customerId: string;
  subjectType: "contribution" | "withdrawal" | "reversal";
  subjectId: string;
  receipt: ReceiptInput;
}

/**
 * Queue one receipt for the customer's consented channel. Must be called with
 * the transaction that commits the financial event.
 */
export async function enqueueReceiptForTransactionTx(
  tx: Prisma.TransactionClient,
  input: ReceiptEventInput
): Promise<{ queued: boolean; channel: CustomerMessageChannel | null; reason?: string }> {
  const preference = await tx.customerMessagingPreference.findUnique({
    where: { customerId: input.customerId },
    select: {
      id: true,
      whatsappNumber: true,
      whatsappStatus: true,
      whatsappOptInAt: true,
      whatsappOptOutAt: true,
      smsNumber: true,
      smsStatus: true,
      smsOptInAt: true,
      smsOptOutAt: true,
      preferredChannel: true,
      customer: { select: { tenantId: true } },
    },
  });
  if (!preference || (preference.customer.tenantId ?? null) !== input.tenantId) {
    return { queued: false, channel: null, reason: "no_consent" };
  }
  const channel = selectReceiptChannel(preference);
  if (!channel) return { queued: false, channel: null, reason: "no_consent" };
  const recipient = recipientFor(preference, channel);
  if (!recipient) return { queued: false, channel, reason: "invalid_number" };

  const content = buildReceiptContent(input.receipt);
  const eventKey = `receipt:${input.subjectType}:${input.subjectId}:${channel}`;
  try {
    await tx.customerMessageOutbox.create({
      data: {
        eventKey,
        tenantId: input.tenantId,
        customerId: input.customerId,
        channel,
        purpose: "receipt",
        reference: input.receipt.reference,
        recipientEncrypted: encryptSecret(recipient),
        recipientMasked: maskPhone(recipient) ?? "[number]",
        payload: JSON.stringify({
          kind: "receipt",
          title: content.title,
          body: content.body,
          parameters: content.parameters,
          templateName:
            (process.env.WHATSAPP_RECEIPT_TEMPLATE ?? "maacash_receipt").trim(),
          languageCode: (process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "en_US").trim(),
          receipt: {
            businessName: input.receipt.businessName,
            transactionType: input.receipt.transactionType,
            amount: input.receipt.amount,
            currency: input.receipt.currency,
            reference: input.receipt.reference,
            occurredAt: input.receipt.occurredAt.toISOString(),
            accountReference: input.receipt.accountReference,
            confirmationStatus: input.receipt.confirmationStatus,
          },
        }),
      },
    });
    return { queued: true, channel };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return { queued: false, channel, reason: "duplicate" };
    }
    throw error;
  }
}

interface OutboxPayload {
  title?: string;
  body?: string;
  parameters?: string[];
  templateName?: string;
  languageCode?: string;
}

function purposeOf(value: string): MessagingPurpose {
  return value === "statement" || value === "dispute_update" ? value : "receipt";
}

function parsePayload(value: string): OutboxPayload | null {
  try {
    const parsed = JSON.parse(value) as OutboxPayload;
    if (!Array.isArray(parsed.parameters)) return null;
    return { ...parsed, parameters: parsed.parameters.map(String) };
  } catch {
    return null;
  }
}

/**
 * Deliver pending customer receipts for both channels. WhatsApp uses approved
 * templates; SMS uses the selected provider (currently a non-delivering mock).
 */
export async function deliverPendingCustomerMessages(
  limit = 5,
  provider: WhatsAppProvider = getWhatsAppProvider(),
  smsProvider: SmsProvider = getSmsProvider()
): Promise<number> {
  const rows = await db.customerMessageOutbox.findMany({
    where: {
      channel: { in: ["whatsapp", "sms"] },
      status: "pending",
      attempts: { lt: MAX_ATTEMPTS },
      nextAttemptAt: { lte: new Date() },
    },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(limit, 1), 20),
  });

  // One config read per business, reused across that business's rows.
  const configCache = new Map<
    string,
    Awaited<ReturnType<typeof resolveTenantMessagingConfig>>
  >();
  async function configFor(tenantId: string | null) {
    const key = tenantId ?? "";
    const cached = configCache.get(key);
    if (cached) return cached;
    const resolved = await resolveTenantMessagingConfig(tenantId);
    configCache.set(key, resolved);
    return resolved;
  }

  let delivered = 0;
  for (const row of rows) {
    const claimed = await db.customerMessageOutbox.updateMany({
      where: { id: row.id, status: "pending", attempts: row.attempts },
      data: { status: "sending", attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;

    const recipient = decryptSecret(row.recipientEncrypted);
    const payload = parsePayload(row.payload);
    if (!recipient || !payload) {
      await db.customerMessageOutbox.update({
        where: { id: row.id },
        data: {
          status: "failed",
          lastError: "invalid_outbox_payload",
          failedAt: new Date(),
        },
      });
      continue;
    }

    const config = await configFor(row.tenantId ?? null);
    const decision = decideMessagingDelivery({
      channel: row.channel === "sms" ? "sms" : "whatsapp",
      purpose: purposeOf(row.purpose),
      config: config.values,
      templates: config.templates,
      fallbackTemplateName: payload.templateName ?? null,
      fallbackLanguage: payload.languageCode ?? null,
    });
    if (!decision.allowed) {
      // A business decision is not a transient failure: retrying cannot help, so
      // the row stops here with the reason instead of looping until exhausted.
      await db.customerMessageOutbox.update({
        where: { id: row.id },
        data: {
          status: "rejected",
          lastError: decision.reason,
          failedAt: new Date(),
        },
      });
      continue;
    }

    const result =
      row.channel === "sms"
        ? await smsProvider.sendSms({
            to: recipient,
            body: payload.body ?? "",
            reference: row.reference,
          })
        : await provider.sendTemplate({
            to: recipient,
            templateName: decision.templateName ?? "maacash_receipt",
            languageCode: decision.languageCode ?? "en_US",
            parameters: payload.parameters ?? [],
          });

    if (result.status === "accepted") {
      await db.customerMessageOutbox.update({
        where: { id: row.id },
        data: {
          status: "accepted",
          providerId: result.providerId,
          providerMessageId: result.providerMessageId,
          acceptedAt: new Date(),
          lastError: null,
        },
      });
      delivered += 1;
      continue;
    }
    if (result.status === "simulated") {
      await db.customerMessageOutbox.update({
        where: { id: row.id },
        data: {
          status: "simulated",
          providerId: result.providerId,
          lastError: null,
        },
      });
      continue;
    }
    const exhausted = row.attempts + 1 >= MAX_ATTEMPTS;
    await db.customerMessageOutbox.update({
      where: { id: row.id },
      data:
        result.retryable && !exhausted
          ? {
              status: "pending",
              lastError: result.error,
              nextAttemptAt: new Date(
                Date.now() + Math.min(60, 2 ** row.attempts) * 60_000
              ),
            }
          : {
              status: "rejected",
              lastError: result.error,
              failedAt: new Date(),
            },
    });
  }
  return delivered;
}

const STATUS_RANK: Record<string, number> = {
  pending: 0,
  sending: 1,
  simulated: 2,
  accepted: 2,
  sent: 3,
  delivered: 4,
  read: 5,
  failed: 6,
  rejected: 7,
};

/**
 * Apply one provider status event exactly once. Returns `duplicate` when the
 * event id was already recorded, and `ignored` when no message matches.
 */
export async function recordCustomerMessageStatus(input: {
  eventId: string;
  providerMessageId: string;
  status: CustomerMessageStatus;
  occurredAt: Date;
  reason?: string | null;
}): Promise<"applied" | "duplicate" | "ignored"> {
  const row = await db.customerMessageOutbox.findFirst({
    where: { providerMessageId: input.providerMessageId },
    select: { id: true, status: true },
  });
  if (!row) return "ignored";

  try {
    await db.$transaction(async (tx) => {
      await tx.customerMessageStatusEvent.create({
        data: {
          outboxId: row.id,
          eventId: input.eventId,
          status: input.status,
          occurredAt: input.occurredAt,
          reason: input.reason?.slice(0, 200) ?? null,
        },
      });
      const advance =
        (STATUS_RANK[input.status] ?? 0) >= (STATUS_RANK[row.status] ?? 0);
      if (!advance) return;
      await tx.customerMessageOutbox.update({
        where: { id: row.id },
        data: {
          status: input.status,
          ...(input.status === "sent" ? { sentAt: input.occurredAt } : {}),
          ...(input.status === "delivered" ? { deliveredAt: input.occurredAt } : {}),
          ...(input.status === "read" ? { readAt: input.occurredAt } : {}),
          ...(input.status === "failed" || input.status === "rejected"
            ? { failedAt: input.occurredAt, lastError: input.reason ?? "delivery_failed" }
            : {}),
        },
      });
    });
    return "applied";
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return "duplicate";
    }
    throw error;
  }
}

/** Best effort after a committed receipt; never awaited in the financial path. */
export function queueCustomerReceiptDelivery(): void {
  if (process.env.NODE_ENV === "test") return;
  void deliverPendingCustomerMessages(3).catch(() => {
    // The outbox row stays pending and is retried by the next delivery run.
  });
}
