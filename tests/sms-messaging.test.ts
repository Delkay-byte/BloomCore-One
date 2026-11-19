/**
 * SMS receipt foundation: consent-gated outbox, mock provider and delivery
 * classification. No SMS provider is contacted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";
import {
  deliverPendingCustomerMessages,
  enqueueReceiptForTransactionTx,
} from "@/lib/messaging/outbox";
import {
  MockSmsProvider,
  getSmsProvider,
  getSmsProviderConfig,
  type SmsProvider,
} from "@/lib/messaging/sms";

let tenantId: string;
let customerId: string;

const NOW = new Date("2026-12-05T10:00:00Z");

async function seed() {
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `SMS-${Math.random().toString(36).slice(2, 8)}`,
      name: "SMS Tenant",
      status: "ACTIVE",
      susuEnabled: true,
    },
  });
  tenantId = tenant.id;
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      customerId: `SMS-C-${Math.random().toString(36).slice(2, 8)}`,
      fullName: "SMS Customer",
      phone: "+233200000333",
      status: "active",
      portalEnabled: true,
    },
  });
  customerId = customer.id;
  await prisma.customerMessagingPreference.create({
    data: {
      customerId,
      tenantId,
      smsNumber: "+233200000333",
      smsStatus: "verified",
      smsOptInAt: NOW,
      smsOptInSource: "test",
      preferredChannel: "sms",
    },
  });
}

async function queue() {
  return prisma.$transaction(async (tx) =>
    enqueueReceiptForTransactionTx(tx, {
      tenantId,
      customerId,
      subjectType: "contribution",
      subjectId: `sms-${Math.random().toString(36).slice(2, 8)}`,
      receipt: {
        businessName: "SMS Tenant",
        transactionType: "contribution",
        amount: 50,
        currency: "GHS",
        reference: "SMS-REF-001",
        occurredAt: NOW,
        accountReference: "S-SMS-1",
        confirmationStatus: "confirmed",
      },
    })
  );
}

beforeEach(async () => {
  await cleanDatabase();
  await seed();
});

describe("SMS provider foundation", () => {
  it("never sends or claims delivery from the mock adapter", async () => {
    const provider = getSmsProvider();
    expect(provider).toBeInstanceOf(MockSmsProvider);
    expect(provider.delivers).toBe(false);
    const result = await provider.sendSms({
      to: "+233200000333",
      body: "SMS Tenant: Contribution received GHS 50.00. Ref SMS-REF-001.",
      reference: "SMS-REF-001",
    });
    expect(result.status).toBe("simulated");
    expect(result.providerMessageId).toBeNull();
  });

  it("rejects an invalid number instead of guessing", async () => {
    const result = await new MockSmsProvider().sendSms({
      to: "0200000333",
      body: "test",
      reference: "SMS-REF-002",
    });
    expect(result.status).toBe("rejected");
    expect(result.error).toMatch(/E\.164/);
  });

  it("reports no operational SMS provider even if a name is configured", () => {
    const config = getSmsProviderConfig({ SMS_PROVIDER: "some-vendor", NODE_ENV: "test" });
    expect(config.provider).toBe("some-vendor");
    expect(config.ready).toBe(false);
    expect(getSmsProvider().delivers).toBe(false);
  });
});

describe("SMS receipt outbox", () => {
  it("queues one SMS receipt after confirmed opt-in", async () => {
    const result = await queue();
    expect(result.queued).toBe(true);
    expect(result.channel).toBe("sms");
    const row = await prisma.customerMessageOutbox.findFirstOrThrow();
    expect(row.status).toBe("pending");
    expect(row.channel).toBe("sms");
    expect(row.payload).toContain("SMS Tenant");
    expect(row.payload).toContain("SMS-REF-001");
    expect(row.payload).not.toMatch(/OTP|PIN/i);
  });

  it("does not queue after an SMS opt-out", async () => {
    await prisma.customerMessagingPreference.update({
      where: { customerId },
      data: {
        smsOptOutAt: new Date("2026-12-06T00:00:00Z"),
      },
    });
    const result = await queue();
    expect(result.queued).toBe(false);
    expect(result.reason).toBe("no_consent");
  });

  it("delivers through an injected provider and records only accepted", async () => {
    await queue();
    const accepted: SmsProvider = {
      id: "mock_accept",
      delivers: true,
      sendSms: vi.fn(async () => ({
        status: "accepted" as const,
        providerId: "mock_accept",
        providerMessageId: "sms-provider-1",
        error: null,
        retryable: false as const,
      })),
    };
    await deliverPendingCustomerMessages(5, undefined as never, accepted);
    const row = await prisma.customerMessageOutbox.findFirstOrThrow();
    expect(row.status).toBe("accepted");
    expect(row.providerId).toBe("mock_accept");
    expect(row.providerMessageId).toBe("sms-provider-1");
    expect(row.deliveredAt).toBeNull();
  });

  it("keeps a provider timeout retryable", async () => {
    await queue();
    const timeout: SmsProvider = {
      id: "mock_timeout",
      delivers: true,
      sendSms: async () => ({
        status: "retryable",
        providerId: "mock_timeout",
        providerMessageId: null,
        error: "provider_timeout",
        retryable: true,
      }),
    };
    await deliverPendingCustomerMessages(5, undefined as never, timeout);
    const row = await prisma.customerMessageOutbox.findFirstOrThrow();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("provider_timeout");
  });
});
