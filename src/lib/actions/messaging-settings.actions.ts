"use server";

import { db } from "@/lib/db";
import { requireTenantAdmin } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import {
  MESSAGING_PURPOSES,
  TEMPLATE_NAME_PATTERN,
  readTenantMessagingConfig,
  resolveTenantMessagingConfig,
  type MessagingChannel,
  type MessagingPurpose,
  type MessagingTemplateValues,
  type TenantMessagingConfigValues,
} from "@/lib/messaging/config";

/**
 * Per-business messaging settings.
 *
 * A business decides whether it sends WhatsApp or SMS receipts and which
 * approved template it uses. These settings can only narrow the platform
 * configuration: the provider adapter still refuses to send until credentials,
 * the delivery switch and the allowlist all permit it.
 */

export interface MessagingSettingsView extends TenantMessagingConfigValues {
  templates: MessagingTemplateValues[];
  /** Platform-side readiness, shown so an operator is never misled. */
  platform: {
    whatsappConfigured: boolean;
    whatsappDeliveryEnabled: boolean;
    whatsappTemplateName: string;
    smsReady: boolean;
  };
  /** What a receipt would actually do right now, per channel. */
  effective: {
    whatsapp: { allowed: boolean; explanation: string | null };
    sms: { allowed: boolean; explanation: string | null };
  };
}

export interface MessagingSettingsResponse {
  success: boolean;
  error?: string;
  data?: MessagingSettingsView;
}

async function buildView(tenantId: string): Promise<MessagingSettingsView> {
  const resolved = await resolveTenantMessagingConfig(tenantId);
  // Decide readiness with the same function the delivery worker uses, so the
  // screen cannot claim delivery that the queue would refuse.
  const { decideMessagingDelivery } = await import("@/lib/messaging/config");
  const decide = (channel: MessagingChannel) =>
    decideMessagingDelivery({
      channel,
      purpose: "receipt",
      config: resolved.values,
      templates: resolved.templates,
      fallbackTemplateName: resolved.whatsapp.templateName,
      fallbackLanguage: resolved.whatsapp.languageCode,
    });
  const whatsapp = decide("whatsapp");
  const sms = decide("sms");
  return {
    ...resolved.values,
    templates: resolved.templates,
    platform: {
      whatsappConfigured: resolved.whatsapp.configured,
      whatsappDeliveryEnabled: resolved.whatsapp.deliveryEnabled,
      whatsappTemplateName: resolved.whatsapp.templateName,
      smsReady: resolved.smsReady,
    },
    effective: {
      whatsapp: { allowed: whatsapp.allowed, explanation: whatsapp.explanation },
      sms: { allowed: sms.allowed, explanation: sms.explanation },
    },
  };
}

export async function getMessagingSettings(): Promise<MessagingSettingsResponse> {
  const ctx = await requireTenantAdmin();
  return { success: true, data: await buildView(ctx.tenantId) };
}

export async function saveMessagingSettings(input: {
  whatsappEnabled: boolean;
  smsEnabled: boolean;
  whatsappTemplateName: string;
  whatsappTemplateLanguage: string;
  smsSenderId: string;
  note: string;
}): Promise<MessagingSettingsResponse> {
  const ctx = await requireTenantAdmin();
  const templateName = input.whatsappTemplateName.trim();
  const language = input.whatsappTemplateLanguage.trim() || "en_US";
  const senderId = input.smsSenderId.trim();

  if (templateName && !TEMPLATE_NAME_PATTERN.test(templateName)) {
    return {
      success: false,
      error: "A template name uses lowercase letters, digits and underscores only.",
    };
  }
  if (language && !/^[a-z]{2}_[A-Z]{2}$/.test(language)) {
    return { success: false, error: "A language code looks like en_US." };
  }
  if (senderId && !/^[A-Za-z0-9 ]{3,11}$/.test(senderId)) {
    return { success: false, error: "An SMS sender ID is 3–11 letters or digits." };
  }
  if (templateName && !input.whatsappEnabled) {
    return {
      success: false,
      error: "Switch WhatsApp on before naming a receipt template.",
    };
  }

  await db.$transaction(async (tx) => {
    const existing = await tx.tenantMessagingConfig.findFirst({
      where: { tenantId: ctx.tenantId },
    });
    const data = {
      whatsappEnabled: input.whatsappEnabled,
      smsEnabled: input.smsEnabled,
      whatsappTemplateName: templateName || null,
      whatsappTemplateLanguage: templateName ? language : null,
      smsSenderId: senderId || null,
      note: input.note.trim() || null,
      updatedById: ctx.userId,
    };
    if (existing) {
      await tx.tenantMessagingConfig.update({ where: { id: existing.id }, data });
    } else {
      await tx.tenantMessagingConfig.create({
        data: { tenantId: ctx.tenantId, ...data },
      });
    }
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "tenant.messaging_settings_changed",
      entityType: "tenant",
      entityId: ctx.tenantId,
      details: {
        from: readTenantMessagingConfig(existing),
        to: readTenantMessagingConfig({ ...data, note: data.note }),
        financialMutation: false,
      },
    });
  });

  return { success: true, data: await buildView(ctx.tenantId) };
}

/**
 * Register a template and its provider approval state.
 *
 * A business may keep a draft, but the queue only sends with `approved`. Marking
 * a template approved records who did it and when, because that claim is what
 * allows a real message to leave.
 */
export async function saveMessagingTemplate(input: {
  channel: MessagingChannel;
  purpose: MessagingPurpose;
  name: string;
  language: string;
  status: "draft" | "approved" | "rejected";
}): Promise<MessagingSettingsResponse> {
  const ctx = await requireTenantAdmin();
  const name = input.name.trim();
  const language = input.language.trim() || "en_US";
  if (input.channel !== "whatsapp" && input.channel !== "sms") {
    return { success: false, error: "Choose WhatsApp or SMS." };
  }
  if (!MESSAGING_PURPOSES.includes(input.purpose)) {
    return { success: false, error: "Choose a message purpose." };
  }
  if (!TEMPLATE_NAME_PATTERN.test(name)) {
    return {
      success: false,
      error: "A template name uses lowercase letters, digits and underscores only.",
    };
  }
  if (!/^[a-z]{2}_[A-Z]{2}$/.test(language)) {
    return { success: false, error: "A language code looks like en_US." };
  }
  if (
    input.status !== "draft" &&
    input.status !== "approved" &&
    input.status !== "rejected"
  ) {
    return { success: false, error: "Choose a valid approval state." };
  }

  await db.$transaction(async (tx) => {
    const existing = await tx.messagingTemplate.findFirst({
      where: {
        tenantId: ctx.tenantId,
        channel: input.channel,
        purpose: input.purpose,
        language,
      },
    });
    const approvedAt = input.status === "approved" ? new Date() : null;
    const data = {
      name,
      status: input.status,
      approvedAt,
      approvedById: input.status === "approved" ? ctx.userId : null,
    };
    if (existing) {
      await tx.messagingTemplate.update({ where: { id: existing.id }, data });
    } else {
      await tx.messagingTemplate.create({
        data: {
          tenantId: ctx.tenantId,
          channel: input.channel,
          purpose: input.purpose,
          language,
          ...data,
        },
      });
    }
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "tenant.messaging_template_changed",
      entityType: "tenant",
      entityId: ctx.tenantId,
      details: {
        channel: input.channel,
        purpose: input.purpose,
        language,
        from: existing ? { name: existing.name, status: existing.status } : null,
        to: { name, status: input.status },
        financialMutation: false,
      },
    });
  });

  return { success: true, data: await buildView(ctx.tenantId) };
}
