/**
 * Per-business messaging settings and the scheduled delivery pass.
 *
 * These tests prove the two things the audit called out: a business can no
 * longer rely on global environment values alone, and a pending message no
 * longer waits for the next receipt to be attempted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
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
  getMessagingSettings,
  saveMessagingSettings,
  saveMessagingTemplate,
} from "@/lib/actions/messaging-settings.actions";
import {
  deliverPendingCustomerMessages,
  enqueueReceiptForTransactionTx,
} from "@/lib/messaging/outbox";
import { runMessagingDispatch } from "@/lib/messaging/dispatch";
import { decideMessagingDelivery } from "@/lib/messaging/config";

const NOW = new Date("2026-12-05T10:00:00Z");

let tenantId: string;
let customerId: string;

beforeEach(async () => {
  await cleanDatabase();
  // WhatsApp credentials present but delivery switched off: the provider lets a
  // send through as `simulated` without any network call, which is exactly the
  // "cannot deliver yet" case these tests need.
  vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "EAA_test");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "123");
  vi.stubEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", "456");
  vi.stubEnv("WHATSAPP_DELIVERY_ENABLED", "false");
  vi.stubEnv("WHATSAPP_DELIVERY_ALLOWLIST", "");
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `CFG-${Math.random().toString(36).slice(2, 8)}`,
      name: "Config Tenant",
      status: "ACTIVE",
      susuEnabled: true,
    },
  });
  tenantId = tenant.id;
  const admin = await prisma.user.create({
    data: {
      tenantId,
      email: `cfg-admin-${Math.random().toString(36).slice(2, 8)}@test.local`,
      fullName: "Config Admin",
      role: "admin",
      status: "active",
      passwordHash: "x",
    },
  });
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      customerId: `CFG-C-${Math.random().toString(36).slice(2, 8)}`,
      fullName: "Config Customer",
      phone: "+233200000888",
      status: "active",
      portalEnabled: true,
    },
  });
  customerId = customer.id;
  await prisma.customerMessagingPreference.create({
    data: {
      customerId,
      tenantId,
      whatsappNumber: "+233200000888",
      whatsappStatus: "verified",
      whatsappOptInAt: NOW,
      whatsappVerifiedAt: NOW,
      whatsappOptInSource: "operator",
      preferredChannel: "whatsapp",
    },
  });
  ctxHolder.current = {
    tenantId,
    tenantName: "Config Tenant",
    userId: admin.id,
    role: "admin",
    modules: ["susu"],
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
        businessName: "Config Tenant",
        transactionType: "contribution",
        amount: 50,
        currency: "GHS",
        reference: `CFG-${subjectId}`,
        occurredAt: NOW,
        accountReference: "S-1",
        confirmationStatus: "confirmed",
      },
    })
  );
}

describe("business settings gate delivery", () => {
  it("refuses delivery when the business has not switched the channel on", async () => {
    await queueReceipt("no-switch");
    await deliverPendingCustomerMessages(5);
    const row = await prisma.customerMessageOutbox.findFirstOrThrow();
    expect(row.status).toBe("rejected");
    expect(row.lastError).toBe("channel_disabled_by_business");
    // It is not retried: only a person can change this.
    expect(row.attempts).toBe(1);
  });

  it("sends through the platform template once the business switches WhatsApp on", async () => {
    await saveMessagingSettings({
      whatsappEnabled: true,
      smsEnabled: false,
      whatsappTemplateName: "",
      whatsappTemplateLanguage: "",
      smsSenderId: "",
      note: "pilot",
    });
    await queueReceipt("switched-on");
    await deliverPendingCustomerMessages(5);
    const row = await prisma.customerMessageOutbox.findFirstOrThrow();
    // No provider is configured, so this must be simulated, never delivered.
    expect(row.status).toBe("simulated");
    expect(row.deliveredAt).toBeNull();
  });

  it("refuses when the business names a template that is not approved", async () => {
    await saveMessagingSettings({
      whatsappEnabled: true,
      smsEnabled: false,
      whatsappTemplateName: "maacash_receipt_business",
      whatsappTemplateLanguage: "en_US",
      smsSenderId: "",
      note: "",
    });
    await queueReceipt("named-template");
    await deliverPendingCustomerMessages(5);
    const row = await prisma.customerMessageOutbox.findFirstOrThrow();
    expect(row.status).toBe("rejected");
    expect(row.lastError).toBe("template_not_approved");
  });

  it("sends once that template is approved", async () => {
    await saveMessagingSettings({
      whatsappEnabled: true,
      smsEnabled: false,
      whatsappTemplateName: "maacash_receipt_business",
      whatsappTemplateLanguage: "en_US",
      smsSenderId: "",
      note: "",
    });
    const approved = await saveMessagingTemplate({
      channel: "whatsapp",
      purpose: "receipt",
      name: "maacash_receipt_business",
      language: "en_US",
      status: "approved",
    });
    expect(approved.success, approved.error).toBe(true);
    expect(approved.data?.effective.whatsapp.allowed).toBe(true);

    await queueReceipt("approved-template");
    await deliverPendingCustomerMessages(5);
    const row = await prisma.customerMessageOutbox.findFirstOrThrow();
    expect(row.status).toBe("simulated");
  });
});

describe("settings validation and audit", () => {
  it("rejects a template name that is not a provider identifier", async () => {
    const result = await saveMessagingSettings({
      whatsappEnabled: true,
      smsEnabled: false,
      whatsappTemplateName: "Free text receipt!",
      whatsappTemplateLanguage: "en_US",
      smsSenderId: "",
      note: "",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/lowercase letters/i);
  });

  it("rejects a template name while WhatsApp is off", async () => {
    const result = await saveMessagingSettings({
      whatsappEnabled: false,
      smsEnabled: false,
      whatsappTemplateName: "maacash_receipt",
      whatsappTemplateLanguage: "en_US",
      smsSenderId: "",
      note: "",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/switch whatsapp on/i);
  });

  it("records the previous and new values in the audit trail", async () => {
    await saveMessagingSettings({
      whatsappEnabled: true,
      smsEnabled: false,
      whatsappTemplateName: "",
      whatsappTemplateLanguage: "",
      smsSenderId: "",
      note: "first",
    });
    await saveMessagingSettings({
      whatsappEnabled: false,
      smsEnabled: true,
      whatsappTemplateName: "",
      whatsappTemplateLanguage: "",
      smsSenderId: "MAACASH",
      note: "second",
    });
    const audits = await prisma.auditLog.findMany({
      where: { tenantId, action: "tenant.messaging_settings_changed" },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(2);
    const last = JSON.parse(String(audits[1].details)) as {
      from: { whatsappEnabled: boolean };
      to: { smsEnabled: boolean; smsSenderId: string };
    };
    expect(last.from.whatsappEnabled).toBe(true);
    expect(last.to.smsEnabled).toBe(true);
    expect(last.to.smsSenderId).toBe("MAACASH");

    const view = await getMessagingSettings();
    expect(view.data?.smsEnabled).toBe(true);
  });

  it("records who approved a template and when", async () => {
    await saveMessagingTemplate({
      channel: "sms",
      purpose: "receipt",
      name: "maacash_receipt_sms",
      language: "en_US",
      status: "approved",
    });
    const row = await prisma.messagingTemplate.findFirstOrThrow({
      where: { tenantId, channel: "sms" },
    });
    expect(row.status).toBe("approved");
    expect(row.approvedById).toBe(ctxHolder.current?.userId);
    expect(row.approvedAt).not.toBeNull();
  });
});

describe("decisions", () => {
  it("explains a refusal in words an operator can act on", () => {
    const decision = decideMessagingDelivery({
      channel: "whatsapp",
      purpose: "receipt",
      config: {
        whatsappEnabled: false,
        smsEnabled: false,
        whatsappTemplateName: null,
        whatsappTemplateLanguage: null,
        smsSenderId: null,
        note: null,
      },
      templates: [],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.explanation).toMatch(/has not switched on WhatsApp/i);
  });
});

describe("scheduled delivery pass", () => {
  it("delivers a due row that no new receipt would have triggered", async () => {
    await enableMessagingForTenant(prisma, tenantId, ["whatsapp"]);
    await queueReceipt("scheduled");
    const pendingBefore = await prisma.customerMessageOutbox.count({
      where: { status: "pending" },
    });
    expect(pendingBefore).toBe(1);

    const summary = await runMessagingDispatch();
    expect(summary.tenants).toBeGreaterThanOrEqual(1);
    // Nothing is delivered for real here: the provider cannot deliver, so the
    // pass reports the message as simulated rather than counted as delivered.
    expect(summary.accepted).toBe(0);
    expect(summary.simulated).toBe(1);

    const row = await prisma.customerMessageOutbox.findFirstOrThrow();
    expect(row.status).toBe("simulated");
    expect(summary.pending).toBe(0);
  });

  it("does not touch a row whose backoff has not elapsed", async () => {
    await enableMessagingForTenant(prisma, tenantId, ["whatsapp"]);
    await queueReceipt("backoff");
    await prisma.customerMessageOutbox.updateMany({
      data: { nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    const summary = await runMessagingDispatch();
    expect(summary.accepted).toBe(0);
    expect(summary.pending).toBe(1);
  });
});

describe("internal dispatch route", () => {
  const token = "test-dispatch-token";

  beforeEach(() => {
    process.env.MESSAGING_DISPATCH_TOKEN = token;
  });

  it("refuses a request without the token", async () => {
    const { POST } = await import("@/app/api/internal/messaging/dispatch/route");
    const request = new NextRequest("http://localhost/api/internal/messaging/dispatch", {
      method: "POST",
    });
    const response = await POST(request);
    expect(response.status).toBe(403);
  });

  it("runs one pass when the token matches", async () => {
    await enableMessagingForTenant(prisma, tenantId, ["whatsapp"]);
    await queueReceipt("route-pass");
    const { POST } = await import("@/app/api/internal/messaging/dispatch/route");
    const request = new NextRequest("http://localhost/api/internal/messaging/dispatch", {
      method: "POST",
      headers: { "x-dispatch-token": token },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; simulated: number };
    expect(body.ok).toBe(true);
    expect(body.simulated).toBe(1);
  });

  it("is unavailable when no token is configured", async () => {
    delete process.env.MESSAGING_DISPATCH_TOKEN;
    const { POST } = await import("@/app/api/internal/messaging/dispatch/route");
    const request = new NextRequest("http://localhost/api/internal/messaging/dispatch", {
      method: "POST",
      headers: { "x-dispatch-token": token },
    });
    const response = await POST(request);
    expect(response.status).toBe(503);
  });
});
