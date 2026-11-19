/**
 * Internal "payment received" notifications for the Platform Super Admin.
 *
 * Two durable records are written inside the same transaction that grants paid
 * access, so a payment can never be activated without the notification and a
 * duplicate webhook can never create a second one:
 *
 *   * an in-app row in `TenantNotification` with audience "platform";
 *   * one row in `PlatformEmailOutbox`, keyed by the payment reference.
 *
 * Email delivery is a separate, bounded step. A provider outage leaves the
 * unpaid outbox row in place for a later retry; it never rolls back, delays or
 * fails the activation, and the webhook response never waits for Resend.
 */

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { appBaseUrl, sendTransactionalEmail } from "@/lib/email/resend";
import { platformPaymentEmail } from "@/lib/email/templates";

/** The operator inbox. Configured, never invented at runtime. */
const DEFAULT_PLATFORM_PAYMENT_EMAIL = "bloomcoretechnologies@gmail.com";

export function platformPaymentEmailAddress(): string {
  return (
    process.env.PLATFORM_PAYMENT_NOTIFICATION_EMAIL ||
    DEFAULT_PLATFORM_PAYMENT_EMAIL
  ).trim();
}

export interface PlatformPaymentDetails {
  tenantId: string;
  tenantName: string;
  tenantCode: string;
  planName: string;
  billingTerm: string;
  amount: number;
  currency: string;
  reference: string;
  paidAt: string | null;
  periodEnd: string | null;
}

/** Stable, one-per-payment keys. A retry can only ever find the same row. */
export function platformPaymentKeys(reference: string): { notification: string; email: string } {
  return {
    notification: `platform_payment_received:${reference}`,
    email: `platform_payment_received:${reference}`,
  };
}

export function platformPaymentBody(input: PlatformPaymentDetails): string {
  const amount = `${input.currency.toUpperCase() === "GHS" ? "GHS " : `${input.currency} `}${input.amount.toLocaleString(
    "en-GH",
    { minimumFractionDigits: 0, maximumFractionDigits: 2 }
  )}`;
  return `${input.tenantName} (${input.tenantCode}) paid ${amount} for ${input.planName} · ${input.billingTerm}. Reference ${input.reference}.`;
}

/**
 * Write both notification records. Must be called with the transaction client
 * that also updates the subscription, so the two either both exist or neither
 * does. Duplicate keys are ignored, never an error.
 */
export async function recordPlatformPaymentNotification(
  tx: Prisma.TransactionClient,
  input: PlatformPaymentDetails
): Promise<void> {
  const keys = platformPaymentKeys(input.reference);
  const body = platformPaymentBody(input);

  await tx.tenantNotification.upsert({
    where: { dedupeKey: keys.notification.slice(0, 200) },
    create: {
      tenantId: null,
      audience: "platform",
      kind: "system",
      severity: "info",
      title: `Payment received — ${input.tenantName}`.slice(0, 140),
      body: body.slice(0, 600),
      href: `/platform/tenants/${input.tenantId}`,
      dedupeKey: keys.notification.slice(0, 200),
    },
    update: {},
  });

  await tx.platformEmailOutbox.upsert({
    where: { eventKey: keys.email },
    create: {
      eventKey: keys.email,
      kind: "payment_received",
      recipient: platformPaymentEmailAddress(),
      status: "pending",
      payload: JSON.stringify(input),
    },
    update: {},
  });
}

type OutboxPayload = PlatformPaymentDetails;

function parsePayload(value: string): OutboxPayload | null {
  try {
    const parsed = JSON.parse(value) as Partial<OutboxPayload>;
    if (
      typeof parsed.tenantName !== "string" ||
      typeof parsed.tenantCode !== "string" ||
      typeof parsed.planName !== "string" ||
      typeof parsed.reference !== "string" ||
      typeof parsed.amount !== "number" ||
      typeof parsed.currency !== "string"
    ) {
      return null;
    }
    return {
      tenantId: String(parsed.tenantId ?? ""),
      tenantName: parsed.tenantName,
      tenantCode: parsed.tenantCode,
      planName: parsed.planName,
      billingTerm: String(parsed.billingTerm ?? "monthly"),
      amount: parsed.amount,
      currency: parsed.currency,
      reference: parsed.reference,
      paidAt: parsed.paidAt ?? null,
      periodEnd: parsed.periodEnd ?? null,
    };
  } catch {
    return null;
  }
}

const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Deliver pending internal emails, bounded in count and attempts.
 *
 * Safe to call on every payment-related request: the optimistic update means
 * two concurrent callers cannot both send the same row. A row that exhausted
 * its attempts stays in `failed` for an operator to inspect; nothing loops.
 */
export async function deliverPendingPlatformEmails(limit = 3): Promise<number> {
  const recipient = platformPaymentEmailAddress();
  if (!recipient) return 0;

  const rows = await db.platformEmailOutbox.findMany({
    where: { status: "pending", attempts: { lt: MAX_DELIVERY_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(limit, 1), 10),
    select: { id: true, attempts: true, payload: true, recipient: true },
  });

  let delivered = 0;
  for (const row of rows) {
    const claimed = await db.platformEmailOutbox.updateMany({
      where: { id: row.id, status: "pending", attempts: row.attempts },
      data: { attempts: { increment: 1 }, lastError: null },
    });
    if (claimed.count !== 1) continue;

    const payload = parsePayload(row.payload);
    if (!payload) {
      await db.platformEmailOutbox.update({
        where: { id: row.id },
        data: { status: "failed", lastError: "invalid_payload" },
      });
      continue;
    }

    const email = platformPaymentEmail({
      tenantName: payload.tenantName,
      tenantCode: payload.tenantCode,
      planName: payload.planName,
      billingTerm: payload.billingTerm,
      amount: payload.amount,
      currency: payload.currency,
      reference: payload.reference,
      paidAt: payload.paidAt,
      periodEnd: payload.periodEnd,
      dashboardUrl: `${appBaseUrl()}/platform/tenants/${payload.tenantId}`,
    });

    const result = await sendTransactionalEmail({
      to: row.recipient || recipient,
      subject: email.subject,
      html: email.html,
      text: email.text,
      tag: "platform_payment",
    });

    if (result.ok) {
      await db.platformEmailOutbox.update({
        where: { id: row.id },
        data: { status: "sent", sentAt: new Date(), lastError: null },
      });
      delivered += 1;
      continue;
    }

    const exhausted = row.attempts + 1 >= MAX_DELIVERY_ATTEMPTS;
    await db.platformEmailOutbox.update({
      where: { id: row.id },
      data: {
        status: exhausted ? "failed" : "pending",
        lastError: result.status ? `http:${result.status}` : "delivery_failed",
      },
    });
  }
  return delivered;
}

/**
 * Best-effort delivery for a request path. Deliberately not awaited: a slow or
 * failing email provider must never delay or change a payment response. The
 * pending row remains for the next retry either way.
 */
export function queuePlatformPaymentEmailDelivery(): void {
  // The unit suite calls `deliverPendingPlatformEmails` directly so delivery is
  // deterministic; no background promise may outlive a test's database reset.
  if (process.env.NODE_ENV === "test") return;
  void deliverPendingPlatformEmails(2).catch(() => {
    // Delivery failures are recorded on the outbox row; nothing to escalate in
    // the payment path.
  });
}
