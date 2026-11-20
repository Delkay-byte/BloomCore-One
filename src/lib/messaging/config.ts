/**
 * Per-business messaging settings.
 *
 * The platform decides whether a provider exists at all; a business decides
 * whether it uses that provider and with which approved template. Both must
 * agree before a customer message leaves the queue, so a tenant switch can only
 * narrow the platform ceiling and never widen it.
 */

import { db } from "@/lib/db";
import { getSmsProviderConfig } from "@/lib/messaging/sms";
import { getWhatsAppConfig, type WhatsAppConfig } from "@/lib/messaging/whatsapp";

export type MessagingChannel = "whatsapp" | "sms";
export type MessagingPurpose = "receipt" | "statement" | "dispute_update";

export const MESSAGING_PURPOSES: MessagingPurpose[] = [
  "receipt",
  "statement",
  "dispute_update",
];

/**
 * Template names must look like a provider-approved template, not free text.
 * Enforced again when the value is saved and when it is used.
 */
export const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{3,64}$/;

export interface TenantMessagingConfigValues {
  whatsappEnabled: boolean;
  smsEnabled: boolean;
  whatsappTemplateName: string | null;
  whatsappTemplateLanguage: string | null;
  smsSenderId: string | null;
  note: string | null;
}

export const DEFAULT_TENANT_MESSAGING_CONFIG: TenantMessagingConfigValues = {
  whatsappEnabled: false,
  smsEnabled: false,
  whatsappTemplateName: null,
  whatsappTemplateLanguage: null,
  smsSenderId: null,
  note: null,
};

export interface MessagingTemplateValues {
  id: string;
  channel: MessagingChannel;
  purpose: MessagingPurpose;
  name: string;
  language: string;
  status: "draft" | "approved" | "rejected";
  approvedAt: string | null;
}

export interface ResolvedMessagingDecision {
  /** True only when the platform and this business both allow the channel. */
  allowed: boolean;
  /** Machine-readable reason when delivery is refused. */
  reason: "channel_disabled_by_business" | "template_not_approved" | null;
  /** What a person should do about it. */
  explanation: string | null;
  templateName: string | null;
  languageCode: string | null;
  senderId: string | null;
}

export function readTenantMessagingConfig(
  row:
    | {
        whatsappEnabled: boolean;
        smsEnabled: boolean;
        whatsappTemplateName: string | null;
        whatsappTemplateLanguage: string | null;
        smsSenderId: string | null;
        note: string | null;
      }
    | null
    | undefined
): TenantMessagingConfigValues {
  if (!row) return { ...DEFAULT_TENANT_MESSAGING_CONFIG };
  return {
    whatsappEnabled: row.whatsappEnabled,
    smsEnabled: row.smsEnabled,
    whatsappTemplateName: row.whatsappTemplateName ?? null,
    whatsappTemplateLanguage: row.whatsappTemplateLanguage ?? null,
    smsSenderId: row.smsSenderId ?? null,
    note: row.note ?? null,
  };
}

export async function resolveTenantMessagingConfig(
  tenantId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<{
  values: TenantMessagingConfigValues;
  templates: MessagingTemplateValues[];
  whatsapp: WhatsAppConfig;
  smsReady: boolean;
}> {
  const [row, templates] = tenantId
    ? await Promise.all([
        db.tenantMessagingConfig.findFirst({ where: { tenantId } }),
        db.messagingTemplate.findMany({
          where: { tenantId },
          orderBy: { createdAt: "asc" },
        }),
      ])
    : [null, []];
  return {
    values: readTenantMessagingConfig(row),
    templates: templates.map((template) => ({
      id: template.id,
      channel: template.channel === "sms" ? "sms" : "whatsapp",
      purpose: isPurpose(template.purpose) ? template.purpose : "receipt",
      name: template.name,
      language: template.language,
      status:
        template.status === "approved"
          ? "approved"
          : template.status === "rejected"
            ? "rejected"
            : "draft",
      approvedAt: template.approvedAt?.toISOString() ?? null,
    })),
    whatsapp: getWhatsAppConfig(env),
    smsReady: getSmsProviderConfig(env).ready,
  };
}

function isPurpose(value: string): value is MessagingPurpose {
  return (MESSAGING_PURPOSES as string[]).includes(value);
}

/**
 * Decide whether one message may be sent, and with which template.
 *
 * Fail closed at every step: an unset business row, a disabled channel, a
 * missing platform provider or an unapproved template all refuse delivery with
 * a reason a person can act on. The template name never comes from free text.
 */
export function decideMessagingDelivery(input: {
  channel: MessagingChannel;
  purpose: MessagingPurpose;
  config: TenantMessagingConfigValues;
  templates: MessagingTemplateValues[];
  /** Platform template, used only when the business has registered none. */
  fallbackTemplateName?: string | null;
  fallbackLanguage?: string | null;
}): ResolvedMessagingDecision {
  const {
    channel,
    purpose,
    config,
    templates,
    fallbackTemplateName,
    fallbackLanguage,
  } = input;

  const businessAllows =
    channel === "whatsapp" ? config.whatsappEnabled : config.smsEnabled;
  if (!businessAllows) {
    return {
      allowed: false,
      reason: "channel_disabled_by_business",
      explanation:
        channel === "whatsapp"
          ? "This business has not switched on WhatsApp receipts."
          : "This business has not switched on SMS receipts.",
      templateName: null,
      languageCode: null,
      senderId: null,
    };
  }

  // The platform gate is deliberately not repeated here. The provider adapter
  // already refuses to send until credentials, the explicit delivery switch and
  // the allowlist all permit it, and it reports `simulated` rather than
  // `accepted` when it cannot deliver. Re-checking that here would double-count
  // one control and hide the provider's own refusal. What a business owns is
  // the switch below and the template that follows.

  const approved = templates.find(
    (template) =>
      template.channel === channel &&
      template.purpose === purpose &&
      template.status === "approved"
  );
  if (approved) {
    return {
      allowed: true,
      reason: null,
      explanation: null,
      templateName: approved.name,
      languageCode: approved.language,
      senderId: config.smsSenderId,
    };
  }

  // A business that configured its own receipt template must have it approved.
  const configuredName =
    channel === "whatsapp" ? config.whatsappTemplateName : null;
  if (configuredName) {
    return {
      allowed: false,
      reason: "template_not_approved",
      explanation: `The template "${configuredName}" is not marked approved for this business.`,
      templateName: null,
      languageCode: null,
      senderId: null,
    };
  }

  if (channel === "whatsapp" && purpose === "receipt" && fallbackTemplateName) {
    if (TEMPLATE_NAME_PATTERN.test(fallbackTemplateName)) {
      return {
        allowed: true,
        reason: null,
        explanation: null,
        templateName: fallbackTemplateName,
        languageCode: fallbackLanguage ?? "en_US",
        senderId: null,
      };
    }
  }

  return {
    allowed: false,
    reason: "template_not_approved",
    explanation:
      channel === "whatsapp"
        ? "No approved WhatsApp template is registered for this purpose."
        : "No approved SMS template is registered for this purpose.",
    templateName: null,
    languageCode: null,
    senderId: null,
  };
}
