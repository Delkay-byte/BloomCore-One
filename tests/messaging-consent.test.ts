/**
 * Consent proof: a number typed into the portal is a claim until a code sent to
 * that number comes back. These tests prove the control end to end, including
 * that an unproven number receives nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
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

import {
  confirmMessagingVerification,
  getMyMessagingPreference,
  requestMessagingVerification,
  saveMyMessagingPreference,
} from "@/lib/actions/customer-messaging.actions";
import { enqueueReceiptForTransactionTx } from "@/lib/messaging/outbox";
import {
  CONSENT_MAX_ATTEMPTS,
  confirmConsentChallenge,
  issueConsentChallenge,
} from "@/lib/messaging/consent";

const NOW = new Date("2026-12-05T10:00:00Z");
const NUMBER = "+233200000555";

let tenantId: string;
let tenantName: string;
let customerId: string;

beforeEach(async () => {
  await cleanDatabase();
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `CON-${Math.random().toString(36).slice(2, 8)}`,
      name: "Consent Tenant",
      status: "ACTIVE",
      susuEnabled: true,
    },
  });
  tenantId = tenant.id;
  tenantName = tenant.name;
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      customerId: `CON-C-${Math.random().toString(36).slice(2, 8)}`,
      fullName: "Consent Customer",
      phone: NUMBER,
      status: "active",
      portalEnabled: true,
    },
  });
  customerId = customer.id;
  await enableMessagingForTenant(prisma, tenantId, ["whatsapp"]);
  ctxHolder.current = {
    tenantId,
    tenantName,
    userId: customerId,
    role: "customer",
    modules: ["customer"],
  };
});

async function queueReceipt(subjectId: string) {
  return prisma.$transaction(async (tx) =>
    enqueueReceiptForTransactionTx(tx, {
      tenantId,
      customerId,
      subjectType: "contribution",
      subjectId,
      receipt: {
        businessName: "Consent Tenant",
        transactionType: "contribution",
        amount: 50,
        currency: "GHS",
        reference: `CON-${subjectId}`,
        occurredAt: NOW,
        accountReference: "S-1",
        confirmationStatus: "confirmed",
      },
    })
  );
}

describe("portal opt-in requires proof", () => {
  it("saves the number but does not allow receipts until it is confirmed", async () => {
    const saved = await saveMyMessagingPreference({
      whatsappNumber: NUMBER,
      whatsappOptIn: true,
      smsNumber: "",
      smsOptIn: false,
      preferredChannel: "whatsapp",
    });
    expect(saved.success, saved.error).toBe(true);
    expect(saved.data?.whatsappOptedIn).toBe(false);
    expect(saved.data?.whatsappVerified).toBe(false);
    expect(saved.data?.awaitingCode).toContain("whatsapp");
    expect(saved.notice).toMatch(/confirmation code/i);

    const queued = await queueReceipt("unverified-1");
    expect(queued.queued).toBe(false);
    expect(queued.reason).toBe("no_consent");
    expect(await prisma.customerMessageOutbox.count()).toBe(0);
  });

  it("refuses a wrong code, counts attempts and then refuses further tries", async () => {
    await prisma.customerMessagingPreference.create({
      data: {
        customerId,
        tenantId,
        whatsappNumber: NUMBER,
        whatsappStatus: "unverified",
        whatsappOptInAt: NOW,
      },
    });
    await issueConsentChallenge({
      tenantId,
      customerId,
      channel: "whatsapp",
      number: NUMBER,
      businessName: tenantName,
      deliver: async () => {},
    });
    for (let attempt = 1; attempt <= CONSENT_MAX_ATTEMPTS; attempt += 1) {
      const wrong = await confirmMessagingVerification({
        channel: "whatsapp",
        code: "000001",
      });
      expect(wrong.success).toBe(false);
      expect(wrong.error).toMatch(/not correct/i);
    }
    const blocked = await confirmMessagingVerification({
      channel: "whatsapp",
      code: "000001",
    });
    expect(blocked.success).toBe(false);
    expect(blocked.error).toMatch(/too many attempts/i);
    const pref = await getMyMessagingPreference();
    expect(pref.data?.whatsappOptedIn).toBe(false);
  });
});

describe("confirmation codes", () => {
  it("verifies with the delivered code and then allows a receipt", async () => {
    let delivered = "";
    await issueConsentChallenge({
      tenantId,
      customerId,
      channel: "whatsapp",
      number: NUMBER,
      businessName: tenantName,
      deliver: async (code) => {
        delivered = code;
      },
    });
    await prisma.customerMessagingPreference.create({
      data: {
        customerId,
        tenantId,
        whatsappNumber: NUMBER,
        whatsappStatus: "unverified",
        whatsappOptInAt: NOW,
      },
    });

    const result = await confirmConsentChallenge({
      tenantId,
      customerId,
      channel: "whatsapp",
      code: delivered,
    });
    expect(result.verified, result.error).toBe(true);

    const pref = await prisma.customerMessagingPreference.findUniqueOrThrow({
      where: { customerId },
    });
    expect(pref.whatsappStatus).toBe("verified");
    expect(pref.whatsappVerifiedAt).not.toBeNull();
    expect(pref.whatsappVerificationMethod).toBe("otp");

    const queued = await queueReceipt("verified-1");
    expect(queued.queued).toBe(true);
  });

  it("refuses an expired code", async () => {
    let delivered = "";
    await issueConsentChallenge({
      tenantId,
      customerId,
      channel: "whatsapp",
      number: NUMBER,
      businessName: tenantName,
      deliver: async (code) => {
        delivered = code;
      },
      now: new Date(Date.now() - 60 * 60 * 1000),
    });
    await prisma.customerMessagingPreference.create({
      data: {
        customerId,
        tenantId,
        whatsappNumber: NUMBER,
        whatsappStatus: "unverified",
        whatsappOptInAt: NOW,
      },
    });
    const result = await confirmConsentChallenge({
      tenantId,
      customerId,
      channel: "whatsapp",
      code: delivered,
    });
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/expired/i);
  });

  it("supersedes an older code when a new one is requested", async () => {
    const codes: string[] = [];
    const deliver = async (code: string) => {
      codes.push(code);
    };
    await prisma.customerMessagingPreference.create({
      data: {
        customerId,
        tenantId,
        whatsappNumber: NUMBER,
        whatsappStatus: "unverified",
        whatsappOptInAt: NOW,
      },
    });
    await issueConsentChallenge({
      tenantId,
      customerId,
      channel: "whatsapp",
      number: NUMBER,
      businessName: tenantName,
      deliver,
    });
    await issueConsentChallenge({
      tenantId,
      customerId,
      channel: "whatsapp",
      number: NUMBER,
      businessName: tenantName,
      deliver,
    });
    const stale = await confirmConsentChallenge({
      tenantId,
      customerId,
      channel: "whatsapp",
      code: codes[0],
    });
    expect(stale.verified).toBe(false);
    if (codes[1] !== codes[0]) {
      const fresh = await confirmConsentChallenge({
        tenantId,
        customerId,
        channel: "whatsapp",
        code: codes[1],
      });
      expect(fresh.verified, fresh.error).toBe(true);
    }
  });

  it("will not verify a number that changed after the code was sent", async () => {
    let delivered = "";
    await issueConsentChallenge({
      tenantId,
      customerId,
      channel: "whatsapp",
      number: NUMBER,
      businessName: tenantName,
      deliver: async (code) => {
        delivered = code;
      },
    });
    await prisma.customerMessagingPreference.create({
      data: {
        customerId,
        tenantId,
        whatsappNumber: "+233200000777",
        whatsappStatus: "unverified",
        whatsappOptInAt: NOW,
      },
    });
    const result = await confirmConsentChallenge({
      tenantId,
      customerId,
      channel: "whatsapp",
      code: delivered,
    });
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/number changed/i);
  });

  it("stores only a hash of the code and the masked number", async () => {
    let delivered = "";
    await issueConsentChallenge({
      tenantId,
      customerId,
      channel: "whatsapp",
      number: NUMBER,
      businessName: tenantName,
      deliver: async (code) => {
        delivered = code;
      },
    });
    const row = await prisma.messagingConsentChallenge.findFirstOrThrow({
      where: { customerId },
    });
    expect(row.codeHash).not.toContain(delivered);
    expect(row.numberMasked).not.toContain("000005");
    expect(row.numberHash).not.toContain(NUMBER);
  });
});

describe("re-requesting a code", () => {
  it("refuses when no number has been saved", async () => {
    const result = await requestMessagingVerification("sms");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/save your number first/i);
  });

  it("reports a failure honestly and leaves no usable code when nothing can be sent", async () => {
    await saveMyMessagingPreference({
      whatsappNumber: NUMBER,
      whatsappOptIn: true,
      smsNumber: "",
      smsOptIn: false,
      preferredChannel: "whatsapp",
    });
    const result = await requestMessagingVerification("whatsapp");
    // No WhatsApp provider is configured in this deployment, so the code cannot
    // be delivered. The honest answer is a failure, never a pretend success.
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/could not send/i);
    const pending = await prisma.messagingConsentChallenge.count({
      where: { status: "pending" },
    });
    expect(pending).toBe(0);
    const pref = await getMyMessagingPreference();
    expect(pref.data?.whatsappOptedIn).toBe(false);
  });
});
