/**
 * Transactional customer receipts: consent, one-event-per-confirmation,
 * non-delivering defaults, retry classification and idempotent status events.
 * No real WhatsApp request or message is made.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import { prisma, cleanDatabase } from "./setup";
import { enableMessagingForTenant } from "./messaging-fixtures";

const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as null | Record<string, unknown> },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/tenant", () => ({
  requireTenantAdmin: async () => ctxHolder.current,
  requireTenantAdminSusu: async () => ctxHolder.current,
  requireTenantCustomer: async () => ctxHolder.current,
  getApiTenantContext: async () => ctxHolder.current,
}));

import { recordContribution } from "@/lib/actions/susu-contribution.actions";
import {
  confirmMessagingVerification,
  saveMyMessagingPreference,
} from "@/lib/actions/customer-messaging.actions";
import { issueConsentChallenge } from "@/lib/messaging/consent";
import {
  deliverPendingCustomerMessages,
  enqueueReceiptForTransactionTx,
  recordCustomerMessageStatus,
} from "@/lib/messaging/outbox";
import {
  MetaWhatsAppCloudProvider,
  getWhatsAppConfig,
  verifyWhatsAppSignature,
  type WhatsAppProvider,
} from "@/lib/messaging/whatsapp";

const NOW = new Date("2026-12-05T10:00:00Z");

let tenantId: string;
let otherTenantId: string;
let adminId: string;
let customerId: string;
let accountId: string;

async function seedCustomer(tenant: string, suffix: string) {
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant,
      email: `admin-${suffix}@test.local`,
      fullName: "Admin",
      role: "admin",
      status: "active",
      passwordHash: "x",
    },
  });
  const customer = await prisma.customer.create({
    data: {
      tenantId: tenant,
      customerId: `C-${suffix}`,
      fullName: `Customer ${suffix}`,
      phone: "+233200000100",
      status: "active",
      portalEnabled: true,
    },
  });
  const account = await prisma.susuAccount.create({
    data: {
      tenantId: tenant,
      accountId: `S-${suffix}`,
      customerId: customer.id,
      dailyContribution: 50,
      status: "active",
    },
  });
  const cycle = await prisma.susuCycle.create({
    data: {
      tenantId: tenant,
      accountId: account.id,
      cycleNumber: 1,
      startDate: new Date("2026-12-01T00:00:00Z"),
      endDate: new Date("2026-12-31T00:00:00Z"),
      dailyContribution: 50,
      status: "active",
      commissionCharged: false,
    },
  });
  return { admin, customer, account, cycle };
}

async function optIn(
  customer: string,
  tenant: string,
  channel: "whatsapp" | "sms" = "whatsapp"
) {
  return prisma.customerMessagingPreference.create({
    data: {
      customerId: customer,
      tenantId: tenant,
      whatsappNumber: channel === "whatsapp" ? "+233200000111" : null,
      whatsappStatus: channel === "whatsapp" ? "verified" : "unverified",
      whatsappOptInAt: channel === "whatsapp" ? NOW : null,
      whatsappOptInSource: channel === "whatsapp" ? "test" : null,
      smsNumber: channel === "sms" ? "+233200000222" : null,
      smsStatus: channel === "sms" ? "verified" : "unverified",
      smsOptInAt: channel === "sms" ? NOW : null,
      smsOptInSource: channel === "sms" ? "test" : null,
      preferredChannel: channel,
    },
  });
}

function receipt(subjectId = "contrib-1", type: "contribution" | "withdrawal" = "contribution") {
  return {
    businessName: "E2E Susu",
    transactionType: type,
    amount: 100,
    currency: "GHS",
    reference: `REF-${subjectId}`,
    occurredAt: NOW,
    accountReference: "S-ONE",
    confirmationStatus: "confirmed",
  } as const;
}

beforeEach(async () => {
  await cleanDatabase();
  const tenant = await prisma.businessTenant.create({
    data: { code: `MSG-${Math.random().toString(36).slice(2, 8)}`, name: "Messaging Tenant", status: "ACTIVE", susuEnabled: true },
  });
  const other = await prisma.businessTenant.create({
    data: { code: `OTH-${Math.random().toString(36).slice(2, 8)}`, name: "Other Tenant", status: "ACTIVE", susuEnabled: true },
  });
  tenantId = tenant.id;
  otherTenantId = other.id;
  // Delivery requires the business to switch the channels on, so every test in
  // this file starts from that real configuration.
  await enableMessagingForTenant(prisma, tenantId, ["whatsapp", "sms"]);
  const seeded = await seedCustomer(tenantId, "ONE");
  adminId = seeded.admin.id;
  customerId = seeded.customer.id;
  accountId = seeded.account.id;
  ctxHolder.current = {
    tenantId,
    tenantName: "Messaging Tenant",
    tenantCode: tenant.code,
    userId: adminId,
    role: "admin",
    modules: ["susu"],
  };
});

describe("consent and receipt events", () => {
  it("queues one WhatsApp receipt for a confirmed contribution", async () => {
    await optIn(customerId, tenantId, "whatsapp");
    const result = await recordContribution({
      accountId,
      amount: 100,
      channel: "direct_office",
      idempotencyKey: "MSG-CON-1001",
    });
    expect(result.success).toBe(true);
    const rows = await prisma.customerMessageOutbox.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe("whatsapp");
    expect(rows[0].status).toBe("pending");
    expect(rows[0].reference).toBe("CON-MSG-CON-1001".replace("CON-", "CON-"));
    expect(rows[0].recipientMasked).toMatch(/0111$/);
    expect(rows[0].recipientEncrypted).not.toContain("+233200000111");
    expect(rows[0].payload).not.toMatch(/OTP|PIN/i);
  });

  it("does not queue when the customer has not opted in", async () => {
    const result = await recordContribution({
      accountId,
      amount: 50,
      channel: "direct_office",
      idempotencyKey: "MSG-CON-1002",
    });
    expect(result.success).toBe(true);
    expect(await prisma.customerMessageOutbox.count()).toBe(0);
  });

  it("does not queue after an opt-out", async () => {
    await prisma.customerMessagingPreference.create({
      data: {
        customerId,
        tenantId,
        whatsappNumber: "+233200000111",
        whatsappStatus: "verified",
        whatsappOptInAt: new Date("2026-12-01T00:00:00Z"),
        whatsappOptOutAt: new Date("2026-12-04T00:00:00Z"),
        preferredChannel: "whatsapp",
      },
    });
    const result = await recordContribution({
      accountId,
      amount: 50,
      channel: "direct_office",
      idempotencyKey: "MSG-CON-1003",
    });
    expect(result.success).toBe(true);
    expect(await prisma.customerMessageOutbox.count()).toBe(0);
  });

  it("does not duplicate the outbox row for the same confirmation", async () => {
    await optIn(customerId, tenantId, "whatsapp");
    await recordContribution({
      accountId,
      amount: 50,
      channel: "direct_office",
      idempotencyKey: "MSG-CON-1004",
    });
    await recordContribution({
      accountId,
      amount: 50,
      channel: "direct_office",
      idempotencyKey: "MSG-CON-1004",
    });
    expect(await prisma.customerMessageOutbox.count()).toBe(1);
  });

  it("queues a withdrawal receipt event once", async () => {
    await optIn(customerId, tenantId, "sms");
    await prisma.$transaction(async (tx) => {
      await enqueueReceiptForTransactionTx(tx, {
        tenantId,
        customerId,
        subjectType: "withdrawal",
        subjectId: "withdrawal-1",
        receipt: receipt("withdrawal-1", "withdrawal"),
      });
    });
    expect(await prisma.customerMessageOutbox.count()).toBe(1);
    expect((await prisma.customerMessageOutbox.findFirstOrThrow()).channel).toBe("sms");
  });

  it("refuses a receipt for another tenant's customer", async () => {
    const other = await seedCustomer(otherTenantId, "TWO");
    await optIn(other.customer.id, otherTenantId, "whatsapp");
    const result = await prisma.$transaction(async (tx) =>
      enqueueReceiptForTransactionTx(tx, {
        tenantId,
        customerId: other.customer.id,
        subjectType: "contribution",
        subjectId: "cross-tenant",
        receipt: receipt("cross-tenant"),
      })
    );
    expect(result.queued).toBe(false);
    expect(result.reason).toBe("no_consent");
  });
});

describe("provider outcomes", () => {
  it("returns simulated without a network call when delivery is disabled", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("no network allowed");
    });
    const provider = new MetaWhatsAppCloudProvider(
      {
        ...getWhatsAppConfig({} as NodeJS.ProcessEnv),
        accessToken: "EAA_test",
        phoneNumberId: "123",
        businessAccountId: "456",
        configured: true,
        deliveryEnabled: false,
      },
      fetchSpy as never
    );
    const result = await provider.sendTemplate({
      to: "+233200000111",
      templateName: "maacash_receipt",
      languageCode: "en_US",
      parameters: ["a"],
    });
    expect(result.status).toBe("simulated");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("marks a timeout as retryable and a rejected template as permanent", async () => {
    await optIn(customerId, tenantId, "whatsapp");
    await prisma.$transaction(async (tx) => {
      await enqueueReceiptForTransactionTx(tx, {
        tenantId,
        customerId,
        subjectType: "contribution",
        subjectId: "prov-1",
        receipt: receipt("prov-1"),
      });
    });
    const timeout: WhatsAppProvider = {
      id: "mock-timeout",
      delivers: true,
      sendTemplate: async () => ({
        status: "retryable",
        providerId: "mock-timeout",
        providerMessageId: null,
        error: "provider_timeout",
        retryable: true,
      }),
    };
    await deliverPendingCustomerMessages(5, timeout);
    const row = await prisma.customerMessageOutbox.findFirstOrThrow();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("provider_timeout");

    const rejected: WhatsAppProvider = {
      id: "mock-rejected",
      delivers: true,
      sendTemplate: async () => ({
        status: "rejected",
        providerId: "mock-rejected",
        providerMessageId: null,
        error: "template_not_approved",
        retryable: false,
      }),
    };
    await prisma.customerMessageOutbox.update({
      where: { id: row.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await deliverPendingCustomerMessages(5, rejected);
    const failed = await prisma.customerMessageOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(failed.status).toBe("rejected");
    expect(failed.lastError).toBe("template_not_approved");
  });
});

describe("status webhook", () => {
  it("records a delivery event once and ignores a replay", async () => {
    const row = await prisma.customerMessageOutbox.create({
      data: {
        eventKey: "status-event-1",
        tenantId,
        customerId,
        channel: "whatsapp",
        reference: "REF-STATUS",
        recipientEncrypted: "v1:x:y:z",
        recipientMasked: "••••011",
        payload: "{}",
        status: "accepted",
        providerId: "meta_cloud",
        providerMessageId: "wamid-1",
      },
    });
    const first = await recordCustomerMessageStatus({
      eventId: "wamid-1:delivered:100",
      providerMessageId: "wamid-1",
      status: "delivered",
      occurredAt: NOW,
    });
    const second = await recordCustomerMessageStatus({
      eventId: "wamid-1:delivered:100",
      providerMessageId: "wamid-1",
      status: "delivered",
      occurredAt: NOW,
    });
    expect(first).toBe("applied");
    expect(second).toBe("duplicate");
    const stored = await prisma.customerMessageOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.status).toBe("delivered");
    expect(await prisma.customerMessageStatusEvent.count()).toBe(1);
  });

  it("verifies Meta's HMAC and rejects a tampered body", () => {
    const secret = "app-secret";
    const raw = '{"entry":[]}';
    const signature = `sha256=${createHmac("sha256", secret)
      .update(raw)
      .digest("hex")}`;
    expect(verifyWhatsAppSignature(raw, signature, secret)).toBe(true);
    expect(verifyWhatsAppSignature(`${raw} `, signature, secret)).toBe(false);
    expect(verifyWhatsAppSignature(raw, null, secret)).toBe(false);
  });
});


describe("customer preference management", () => {
  it("records opt-in only after the number is confirmed, then records opt-out", async () => {
    ctxHolder.current = {
      tenantId,
      tenantName: "Messaging Tenant",
      userId: customerId,
      role: "customer",
      modules: ["customer"],
    };
    const saved = await saveMyMessagingPreference({
      whatsappNumber: "+233 20 000 0111",
      whatsappOptIn: true,
      smsNumber: "+233200000222",
      smsOptIn: true,
      preferredChannel: "whatsapp",
    });
    expect(saved.success).toBe(true);
    // The portal saves the claim; ownership still has to be proven.
    expect(saved.data?.whatsappOptedIn).toBe(false);
    expect(saved.data?.whatsappVerified).toBe(false);
    expect(saved.data?.whatsappNumber).toBe("+233200000111");
    expect(saved.data?.preferredChannel).toBe("whatsapp");

    // Confirm the WhatsApp number the way the customer would, with a code only
    // the number's owner receives.
    let code = "";
    await issueConsentChallenge({
      tenantId,
      customerId,
      channel: "whatsapp",
      number: "+233200000111",
      businessName: "Messaging Tenant",
      deliver: async (sent) => {
        code = sent;
      },
    });
    const confirmed = await confirmMessagingVerification({ channel: "whatsapp", code });
    expect(confirmed.success, confirmed.error).toBe(true);
    expect(confirmed.data?.whatsappOptedIn).toBe(true);
    expect(confirmed.data?.whatsappVerified).toBe(true);

    const optedOut = await saveMyMessagingPreference({
      whatsappNumber: "+233200000111",
      whatsappOptIn: false,
      smsNumber: "+233200000222",
      smsOptIn: false,
      preferredChannel: "none",
    });
    expect(optedOut.success).toBe(true);
    expect(optedOut.data?.whatsappOptedIn).toBe(false);
    expect(optedOut.data?.whatsappOptOutAt).toBeTruthy();
    expect(optedOut.data?.smsOptOutAt).toBeTruthy();
  });

  it("rejects an invalid opted-in number", async () => {
    ctxHolder.current = {
      tenantId,
      tenantName: "Messaging Tenant",
      userId: customerId,
      role: "customer",
      modules: ["customer"],
    };
    const result = await saveMyMessagingPreference({
      whatsappNumber: "not-a-number",
      whatsappOptIn: true,
      smsNumber: "",
      smsOptIn: false,
      preferredChannel: "whatsapp",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/valid WhatsApp/);
  });
});
