/**
 * Messaging fixtures shared by the messaging tests.
 *
 * A business must switch a channel on before any customer message is sent, so
 * every test that exercises delivery enables it explicitly. This is deliberate:
 * a test that forgets the switch should fail, not silently prove delivery works.
 */

import type { PrismaClient } from "@prisma/client";

export type TestMessagingChannel = "whatsapp" | "sms";

export async function enableMessagingForTenant(
  prisma: PrismaClient,
  tenantId: string,
  channels: TestMessagingChannel[] = ["whatsapp", "sms"]
): Promise<void> {
  const whatsapp = channels.includes("whatsapp");
  const sms = channels.includes("sms");
  await prisma.tenantMessagingConfig.upsert({
    where: { tenantId },
    create: {
      tenantId,
      whatsappEnabled: whatsapp,
      smsEnabled: sms,
      note: "test fixture",
    },
    update: { whatsappEnabled: whatsapp, smsEnabled: sms },
  });
  for (const channel of channels) {
    await prisma.messagingTemplate.upsert({
      where: {
        tenantId_channel_purpose_language: {
          tenantId,
          channel,
          purpose: "receipt",
          language: "en_US",
        },
      },
      create: {
        tenantId,
        channel,
        purpose: "receipt",
        name: channel === "sms" ? "maacash_receipt_sms" : "maacash_receipt",
        language: "en_US",
        status: "approved",
        approvedAt: new Date(),
      },
      update: { status: "approved", approvedAt: new Date() },
    });
  }
}
