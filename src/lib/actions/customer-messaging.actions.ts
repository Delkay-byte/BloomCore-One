"use server";

import { db } from "@/lib/db";
import { requireTenantCustomer } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import { normalizeE164 } from "@/lib/messaging/outbox";

export interface MessagingPreferenceView {
  whatsappNumber: string | null;
  whatsappOptedIn: boolean;
  whatsappOptOutAt: string | null;
  smsNumber: string | null;
  smsOptedIn: boolean;
  smsOptOutAt: string | null;
  preferredChannel: "whatsapp" | "sms" | null;
}

export interface MessagingPreferenceResponse {
  success: boolean;
  error?: string;
  data?: MessagingPreferenceView;
}

function active(
  optInAt: Date | null,
  optOutAt: Date | null,
  status: string
): boolean {
  return Boolean(
    optInAt &&
      status === "verified" &&
      (optOutAt === null || optInAt > optOutAt)
  );
}

export async function getMyMessagingPreference(): Promise<MessagingPreferenceResponse> {
  const ctx = await requireTenantCustomer();
  const row = await db.customerMessagingPreference.findUnique({
    where: { customerId: ctx.userId },
  });
  return {
    success: true,
    data: {
      whatsappNumber: row?.whatsappNumber ?? null,
      whatsappOptedIn: row
        ? active(row.whatsappOptInAt, row.whatsappOptOutAt, row.whatsappStatus)
        : false,
      whatsappOptOutAt: row?.whatsappOptOutAt?.toISOString() ?? null,
      smsNumber: row?.smsNumber ?? null,
      smsOptedIn: row ? active(row.smsOptInAt, row.smsOptOutAt, row.smsStatus) : false,
      smsOptOutAt: row?.smsOptOutAt?.toISOString() ?? null,
      preferredChannel:
        row?.preferredChannel === "whatsapp" || row?.preferredChannel === "sms"
          ? row.preferredChannel
          : null,
    },
  };
}

export async function saveMyMessagingPreference(input: {
  whatsappNumber: string;
  whatsappOptIn: boolean;
  smsNumber: string;
  smsOptIn: boolean;
  preferredChannel: "whatsapp" | "sms" | "none";
}): Promise<MessagingPreferenceResponse> {
  const ctx = await requireTenantCustomer();
  const whatsappNumber = normalizeE164(input.whatsappNumber);
  const smsNumber = normalizeE164(input.smsNumber);
  if (input.whatsappOptIn && !whatsappNumber) {
    return { success: false, error: "Enter a valid WhatsApp number with country code." };
  }
  if (input.smsOptIn && !smsNumber) {
    return { success: false, error: "Enter a valid SMS number with country code." };
  }
  if (
    input.preferredChannel !== "whatsapp" &&
    input.preferredChannel !== "sms" &&
    input.preferredChannel !== "none"
  ) {
    return { success: false, error: "Choose a valid preferred channel." };
  }

  const customer = await db.customer.findFirst({
    where: { id: ctx.userId, tenantId: ctx.tenantId },
    select: { id: true },
  });
  if (!customer) return { success: false, error: "Customer account not found." };

  const now = new Date();
  const source = "customer_portal";
  await db.$transaction(async (tx) => {
    const existing = await tx.customerMessagingPreference.findUnique({
      where: { customerId: ctx.userId },
    });
    const data = {
      tenantId: ctx.tenantId,
      whatsappNumber: whatsappNumber ?? existing?.whatsappNumber ?? null,
      whatsappStatus: input.whatsappOptIn ? "verified" : "unverified",
      whatsappOptInAt: input.whatsappOptIn
        ? now
        : existing?.whatsappOptOutAt
          ? existing.whatsappOptInAt
          : existing?.whatsappOptInAt ?? null,
      whatsappOptInSource: input.whatsappOptIn
        ? source
        : existing?.whatsappOptInSource ?? null,
      whatsappOptOutAt: input.whatsappOptIn
        ? null
        : existing?.whatsappOptInAt
          ? now
          : null,
      smsNumber: smsNumber ?? existing?.smsNumber ?? null,
      smsStatus: input.smsOptIn ? "verified" : "unverified",
      smsOptInAt: input.smsOptIn
        ? now
        : existing?.smsOptOutAt
          ? existing.smsOptInAt
          : existing?.smsOptInAt ?? null,
      smsOptInSource: input.smsOptIn ? source : existing?.smsOptInSource ?? null,
      smsOptOutAt: input.smsOptIn
        ? null
        : existing?.smsOptInAt
          ? now
          : null,
      preferredChannel:
        input.preferredChannel === "none" ? null : input.preferredChannel,
    };
    await tx.customerMessagingPreference.upsert({
      where: { customerId: ctx.userId },
      create: { customerId: ctx.userId, ...data },
      update: data,
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "customer.messaging_preferences_updated",
      entityType: "customer",
      entityId: ctx.userId,
      details: {
        whatsappOptIn: input.whatsappOptIn,
        smsOptIn: input.smsOptIn,
        preferredChannel: input.preferredChannel,
        financialMutation: false,
      },
    });
  });

  return getMyMessagingPreference();
}
