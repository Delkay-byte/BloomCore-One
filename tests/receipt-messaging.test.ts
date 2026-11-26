import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_LENGTH,
  MockMessageProvider,
  maskPhone,
  validateOutboundMessage,
} from "@/lib/messaging/provider";
import { buildReceiptMessage, receiptMessageFits } from "@/lib/messaging/receipt-message";
import type { SusuReceipt } from "@/lib/susu-statements";

const receipt: SusuReceipt = {
  subjectId: "contrib-1",
  reference: "CON-20261124-ABC123",
  kind: "contribution",
  status: "completed",
  isReversal: false,
  issuedAt: "2026-11-24T09:30:00.000Z",
  businessName: "MaaCash Demo",
  customer: {
    customerId: "CUS-001",
    fullName: "Ama Mensah",
    phone: "+233200000901",
  },
  accountNumber: "SUSU-001",
  cycleNumber: 1,
  channel: "collector",
  receivedBy: "Kofi Collector",
  notes: null,
  amount: 50,
  commissionAmount: 0,
  netAmount: 50,
};

describe("receipt message foundation", () => {
  it("builds a short SMS and a richer WhatsApp message without inventing a balance", () => {
    const sms = buildReceiptMessage(receipt, "sms");
    expect(sms).toContain("MaaCash Demo");
    expect(sms).toContain("GHS 50.00");
    expect(sms).toContain("CON-20261124-ABC123");
    expect(sms).toContain("24 Nov 2026");
    expect(sms).not.toMatch(/profit|provider-confirmed/i);
    expect(sms.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH.sms);

    const whatsapp = buildReceiptMessage(receipt, "whatsapp");
    expect(whatsapp).toContain("Ama Mensah");
    expect(whatsapp).toContain("SUSU-001");
    expect(whatsapp).toContain("Receipt: CON-20261124-ABC123");
    expect(whatsapp).not.toMatch(/profit|provider-confirmed/i);
    expect(receiptMessageFits(receipt, "whatsapp")).toBe(true);
  });

  it("labels a withdrawal as a payout, not revenue", () => {
    const withdrawal: SusuReceipt = {
      ...receipt,
      kind: "withdrawal",
      reference: "WDR-20261124-XYZ",
      amount: 100,
      commissionAmount: 5,
      netAmount: 95,
    };
    const sms = buildReceiptMessage(withdrawal, "sms");
    expect(sms).toContain("Withdrawal paid GHS 95.00");
    expect(sms).not.toContain("Contribution");
  });

  it("masks a recipient number and validates provider input", async () => {
    expect(maskPhone("+233200000901")).toBe("•••••••••0901");
    expect(maskPhone(null)).toBeNull();

    const provider = new MockMessageProvider();
    expect(provider.delivers).toBe(false);
    const result = await provider.send({
      channel: "sms",
      to: "+233200000901",
      body: "Receipt recorded.",
      purpose: "receipt",
      reference: "CON-1",
    });
    expect(result).toMatchObject({
      status: "simulated",
      providerId: "mock",
      providerMessageId: null,
      error: null,
    });

    expect(
      validateOutboundMessage({
        channel: "sms",
        to: "0200000901",
        body: "Receipt recorded.",
        purpose: "receipt",
        reference: "CON-1",
      })
    ).toContain("E.164");
    expect(
      validateOutboundMessage({
        channel: "sms",
        to: "+233200000901",
        body: "x".repeat(MAX_MESSAGE_LENGTH.sms + 1),
        purpose: "receipt",
        reference: "CON-1",
      })
    ).toContain("exceeds");
  });
});

