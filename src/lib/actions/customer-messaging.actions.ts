"use server";

import { db } from "@/lib/db";
import { requireTenantCustomer } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import { normalizeE164 } from "@/lib/messaging/outbox";
import {
  confirmConsentChallenge,
  issueConsentChallenge,
  type ConsentChannel,
} from "@/lib/messaging/consent";

export interface MessagingPreferenceView {
  whatsappNumber: string | null;
  whatsappOptedIn: boolean;
  /** False when a number is saved but ownership has not been proven yet. */
  whatsappVerified: boolean;
  whatsappOptOutAt: string | null;
  smsNumber: string | null;
  smsOptedIn: boolean;
  smsVerified: boolean;
  smsOptOutAt: string | null;
  preferredChannel: "whatsapp" | "sms" | null;
  /** Channels waiting for a confirmation code, so the card can ask for it. */
  awaitingCode: ConsentChannel[];
  /** Whether a receipt would actually be sent with the current settings. */
  deliveryReady: boolean;
}

export interface MessagingPreferenceResponse {
  success: boolean;
  error?: string;
  data?: MessagingPreferenceView;
  /** A sentence the card shows after a save or a verification. */
  notice?: string;
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
  const [row, pending] = await Promise.all([
    db.customerMessagingPreference.findUnique({ where: { customerId: ctx.userId } }),
    db.messagingConsentChallenge.findMany({
      where: { customerId: ctx.userId, status: "pending" },
      orderBy: { createdAt: "desc" },
      select: { channel: true },
    }),
  ]);
  const awaitingCode: ConsentChannel[] = [];
  for (const challenge of pending) {
    const channel: ConsentChannel = challenge.channel === "sms" ? "sms" : "whatsapp";
    if (!awaitingCode.includes(channel)) awaitingCode.push(channel);
  }
  return {
    success: true,
    data: {
      whatsappNumber: row?.whatsappNumber ?? null,
      whatsappOptedIn: row
        ? active(row.whatsappOptInAt, row.whatsappOptOutAt, row.whatsappStatus)
        : false,
      whatsappVerified: Boolean(row?.whatsappStatus === "verified" && row.whatsappVerifiedAt),
      whatsappOptOutAt: row?.whatsappOptOutAt?.toISOString() ?? null,
      smsNumber: row?.smsNumber ?? null,
      smsOptedIn: row ? active(row.smsOptInAt, row.smsOptOutAt, row.smsStatus) : false,
      smsVerified: Boolean(row?.smsStatus === "verified" && row.smsVerifiedAt),
      smsOptOutAt: row?.smsOptOutAt?.toISOString() ?? null,
      preferredChannel:
        row?.preferredChannel === "whatsapp" || row?.preferredChannel === "sms"
          ? row.preferredChannel
          : null,
      awaitingCode,
      deliveryReady: Boolean(
        (row && active(row.whatsappOptInAt, row.whatsappOptOutAt, row.whatsappStatus)) ||
          (row && active(row.smsOptInAt, row.smsOptOutAt, row.smsStatus))
      ),
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
  // Filled inside the transaction; read afterwards to decide what to verify.
  let whatsappAlreadyVerified = false;
  let smsAlreadyVerified = false;
  await db.$transaction(async (tx) => {
    const existing = await tx.customerMessagingPreference.findUnique({
      where: { customerId: ctx.userId },
    });
    // Opting in saves the number and asks for proof; it never marks the channel
    // verified by assertion. A number that was already verified keeps its proof
    // only while it does not change.
    const whatsappSameNumber =
      Boolean(whatsappNumber) && whatsappNumber === existing?.whatsappNumber;
    const smsSameNumber = Boolean(smsNumber) && smsNumber === existing?.smsNumber;
    whatsappAlreadyVerified = Boolean(
      whatsappSameNumber && existing?.whatsappStatus === "verified" && existing.whatsappVerifiedAt
    );
    smsAlreadyVerified = Boolean(
      smsSameNumber && existing?.smsStatus === "verified" && existing.smsVerifiedAt
    );
    const data = {
      tenantId: ctx.tenantId,
      whatsappNumber: whatsappNumber ?? existing?.whatsappNumber ?? null,
      whatsappStatus: input.whatsappOptIn
        ? whatsappAlreadyVerified
          ? "verified"
          : "unverified"
        : "unverified",
      whatsappVerifiedAt: whatsappAlreadyVerified ? existing?.whatsappVerifiedAt ?? null : null,
      whatsappVerificationMethod: whatsappAlreadyVerified
        ? existing?.whatsappVerificationMethod ?? null
        : null,
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
      smsStatus: input.smsOptIn ? (smsAlreadyVerified ? "verified" : "unverified") : "unverified",
      smsVerifiedAt: smsAlreadyVerified ? existing?.smsVerifiedAt ?? null : null,
      smsVerificationMethod: smsAlreadyVerified
        ? existing?.smsVerificationMethod ?? null
        : null,
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
        whatsappStatus: data.whatsappStatus,
        smsStatus: data.smsStatus,
        financialMutation: false,
      },
    });
  });

  // A fresh number needs proof before any receipt may go to it.
  const toVerify: ConsentChannel[] = [];
  if (input.whatsappOptIn && whatsappNumber && !whatsappAlreadyVerified) {
    toVerify.push("whatsapp");
  }
  if (input.smsOptIn && smsNumber && !smsAlreadyVerified) toVerify.push("sms");
  const tenant = await db.businessTenant.findFirst({
    where: { id: ctx.tenantId },
    select: { name: true },
  });
  for (const channel of toVerify) {
    await issueConsentChallenge({
      tenantId: ctx.tenantId,
      customerId: ctx.userId,
      channel,
      number: (channel === "whatsapp" ? whatsappNumber : smsNumber) ?? "",
      businessName: tenant?.name ?? "MaaCash",
    });
  }

  const refreshed = await getMyMessagingPreference();
  if (toVerify.length > 0) {
    refreshed.data = { ...(refreshed.data as MessagingPreferenceView), awaitingCode: toVerify };
    refreshed.notice =
      "Saved. We sent a confirmation code to that number. Enter it to start receiving receipts.";
  }
  return refreshed;
}

/**
 * Send a fresh confirmation code for one channel.
 *
 * Re-issuing replaces the previous code, so an intercepted older code cannot be
 * used after the customer asks for a new one.
 */
export async function requestMessagingVerification(
  channel: ConsentChannel
): Promise<{ success: boolean; error?: string; delivery?: string; masked?: string | null }> {
  const ctx = await requireTenantCustomer();
  const row = await db.customerMessagingPreference.findUnique({
    where: { customerId: ctx.userId },
  });
  if (!row) {
    return { success: false, error: "Save your number first, then request a code." };
  }
  const number = channel === "whatsapp" ? row.whatsappNumber : row.smsNumber;
  if (!number) {
    return { success: false, error: "There is no saved number for that channel." };
  }
  const tenant = await db.businessTenant.findFirst({
    where: { id: ctx.tenantId },
    select: { name: true },
  });
  const result = await issueConsentChallenge({
    tenantId: ctx.tenantId,
    customerId: ctx.userId,
    channel,
    number,
    businessName: tenant?.name ?? "MaaCash",
  });
  if (!result.sent) {
    return { success: false, error: result.error ?? "The code could not be sent." };
  }
  return {
    success: true,
    delivery: result.delivery,
    masked: result.maskedNumber,
  };
}

/** Verify the code and, on success, allow receipts to that number. */
export async function confirmMessagingVerification(input: {
  channel: ConsentChannel;
  code: string;
}): Promise<MessagingPreferenceResponse> {
  const ctx = await requireTenantCustomer();
  if (input.channel !== "whatsapp" && input.channel !== "sms") {
    return { success: false, error: "Choose WhatsApp or SMS." };
  }
  const result = await confirmConsentChallenge({
    tenantId: ctx.tenantId,
    customerId: ctx.userId,
    channel: input.channel,
    code: input.code,
  });
  if (!result.verified) {
    return {
      success: false,
      error: result.error ?? "That code could not be verified.",
    };
  }
  await db.$transaction(async (tx) => {
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "customer.messaging_number_verified",
      entityType: "customer",
      entityId: ctx.userId,
      details: { channel: input.channel, method: "otp", financialMutation: false },
    });
  });
  const refreshed = await getMyMessagingPreference();
  refreshed.notice = "Number confirmed. Receipts will be sent there.";
  return refreshed;
}
