/**
 * SMS delivery-status webhook.
 *
 * No SMS provider is contracted, so this route is proven against the ledger
 * contract it owns: signed payloads only, one event applied once, and a failed
 * delivery recorded without ever being mistaken for a sent message.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import { NextRequest } from "next/server";
import { prisma, cleanDatabase } from "./setup";

const SECRET = "test-sms-status-secret";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
}

async function seedRow(providerMessageId: string) {
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `SMSW-${Math.random().toString(36).slice(2, 8)}`,
      name: "SMS Webhook Tenant",
      status: "ACTIVE",
      susuEnabled: true,
    },
  });
  const customer = await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      customerId: `SMSW-C-${Math.random().toString(36).slice(2, 8)}`,
      fullName: "SMS Webhook Customer",
      status: "active",
      portalEnabled: true,
    },
  });
  return prisma.customerMessageOutbox.create({
    data: {
      eventKey: `receipt:contribution:${providerMessageId}:sms`,
      tenantId: tenant.id,
      customerId: customer.id,
      channel: "sms",
      purpose: "receipt",
      reference: "SMSW-REF",
      recipientEncrypted: "enc",
      recipientMasked: "••••0222",
      payload: JSON.stringify({ body: "receipt", parameters: [] }),
      status: "accepted",
      acceptedAt: new Date(),
      providerId: "mock_sms",
      providerMessageId,
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  process.env.SMS_STATUS_WEBHOOK_SECRET = SECRET;
});

describe("signed SMS status callbacks", () => {
  it("records a delivered status once and ignores a replay", async () => {
    const row = await seedRow("sms-1");
    const body = JSON.stringify({
      events: [
        {
          messageId: "sms-1",
          status: "delivered",
          occurredAt: "2026-12-05T10:05:00Z",
          eventId: "sms-1:delivered",
        },
      ],
    });
    const { POST } = await import("@/app/api/webhooks/sms/route");
    const make = () =>
      new NextRequest("http://localhost/api/webhooks/sms", {
        method: "POST",
        body,
        headers: { "x-sms-signature-256": sign(body) },
      });

    const first = await POST(make());
    expect(first.status).toBe(200);
    const after = await prisma.customerMessageOutbox.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.status).toBe("delivered");
    expect(after.deliveredAt).not.toBeNull();

    const replay = await POST(make());
    expect(replay.status).toBe(200);
    const events = await prisma.customerMessageStatusEvent.count({
      where: { outboxId: row.id },
    });
    expect(events).toBe(1);
  });

  it("records a failed delivery with a sanitised reason", async () => {
    const row = await seedRow("sms-2");
    const body = JSON.stringify({
      events: [
        {
          messageId: "sms-2",
          status: "undelivered",
          reason: "invalid destination",
          eventId: "sms-2:failed",
        },
      ],
    });
    const { POST } = await import("@/app/api/webhooks/sms/route");
    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/sms", {
        method: "POST",
        body,
        headers: { "x-sms-signature-256": sign(body) },
      })
    );
    expect(response.status).toBe(200);
    const after = await prisma.customerMessageOutbox.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.status).toBe("failed");
    expect(after.lastError).toBe("invalid destination");
  });

  it("rejects an unsigned or tampered body", async () => {
    await seedRow("sms-3");
    const body = JSON.stringify({
      events: [{ messageId: "sms-3", status: "delivered" }],
    });
    const { POST } = await import("@/app/api/webhooks/sms/route");
    const unsigned = await POST(
      new NextRequest("http://localhost/api/webhooks/sms", {
        method: "POST",
        body,
      })
    );
    expect(unsigned.status).toBe(401);

    const tampered = await POST(
      new NextRequest("http://localhost/api/webhooks/sms", {
        method: "POST",
        body: body.replace("delivered", "delivered "),
        headers: { "x-sms-signature-256": sign(body) },
      })
    );
    expect(tampered.status).toBe(401);
  });

  it("is unavailable until a secret is configured", async () => {
    delete process.env.SMS_STATUS_WEBHOOK_SECRET;
    const body = JSON.stringify({ events: [] });
    const { POST } = await import("@/app/api/webhooks/sms/route");
    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/sms", {
        method: "POST",
        body,
        headers: { "x-sms-signature-256": sign(body) },
      })
    );
    expect(response.status).toBe(503);
  });
});
