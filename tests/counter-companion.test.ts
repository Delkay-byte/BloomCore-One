/**
 * Counter Companion: the guided counter capture.
 *
 * These tests exist because the companion is the one screen an agent uses dozens of
 * times a day, so its refusals have to be exactly right: no PIN ever stored, no
 * transaction presented as network-confirmed, no number captured without being read
 * back, and no permission asked for that the workflow does not need.
 */

import { describe, expect, it } from "vitest";
import {
  COUNTER_FLOWS,
  COUNTER_PERMISSION_POLICY,
  COUNTER_STATUS_LABELS,
  buildCounterCapture,
  counterConfirmationLine,
  looksLikeSecret,
  maskCustomerNumber,
  normalizeCustomerNumber,
} from "@/lib/counter-companion";

const valid = {
  flow: "cash_in",
  network: "mtn",
  customerNumber: "0244000111",
  customerNumberConfirmed: true,
  amount: 120.5,
  reference: "MP-778812",
};

describe("capture rules", () => {
  it("builds a capture for a confirmed customer number", () => {
    const result = buildCounterCapture(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capture.amountMinor).toBe(12_050);
    expect(result.capture.network).toBe("mtn");
    // The stored/displayed form is masked; the full number is not echoed in a list.
    expect(result.capture.customerNumberMasked).toBe("+233244•••11");
    expect(result.capture.providerConfirmed).toBe(false);
    expect(result.capture.status).toBe("captured");
  });

  it("requires the number to be read back before saving", () => {
    const result = buildCounterCapture({ ...valid, customerNumberConfirmed: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("customer");
      expect(result.error).toMatch(/read the number back/i);
    }
  });

  it("refuses a number that is not a Ghanaian mobile number", () => {
    for (const customerNumber of ["12345", "024400011", "+2348012345678", "abc"]) {
      expect(buildCounterCapture({ ...valid, customerNumber }).ok).toBe(false);
    }
  });

  it("accepts local, international and bare-prefix forms", () => {
    expect(normalizeCustomerNumber("0244000111")).toBe("+233244000111");
    expect(normalizeCustomerNumber("+233244000111")).toBe("+233244000111");
    expect(normalizeCustomerNumber("233244000111")).toBe("+233244000111");
    expect(normalizeCustomerNumber("024 400 0111")).toBe("+233244000111");
  });

  it("never stores a PIN typed into the reference", () => {
    for (const reference of ["1234", "123456", "PIN 4321", "otp 55123", "my password"]) {
      expect(looksLikeSecret(reference)).toBe(true);
      const result = buildCounterCapture({ ...valid, reference });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.field).toBe("reference");
        expect(result.error).toMatch(/never type a customer's or agent's PIN/i);
      }
    }
  });

  it("accepts an ordinary network reference", () => {
    expect(looksLikeSecret("MP-778812")).toBe(false);
    expect(looksLikeSecret("TXN-2026-000123")).toBe(false);
    expect(buildCounterCapture({ ...valid, reference: "TXN-2026-000123" }).ok).toBe(true);
  });

  it("refuses a bad flow, bad network, fractional pesewa and zero amount", () => {
    expect(buildCounterCapture({ ...valid, flow: "transfer" }).ok).toBe(false);
    expect(buildCounterCapture({ ...valid, network: "vodafone" }).ok).toBe(false);
    expect(buildCounterCapture({ ...valid, amount: 10.005 }).ok).toBe(false);
    expect(buildCounterCapture({ ...valid, amount: 0 }).ok).toBe(false);
  });

  it("does not ask for a customer number on a commission or expense entry", () => {
    expect(buildCounterCapture({ flow: "commission", network: "telecel", amount: 3.5 }).ok).toBe(true);
    expect(buildCounterCapture({ flow: "expense", network: "at_money", amount: 15 }).ok).toBe(true);
  });

  it("tells the agent the truth after a capture", () => {
    const result = buildCounterCapture(valid);
    if (!result.ok) throw new Error(result.error);
    const line = counterConfirmationLine(result.capture);
    expect(line).toMatch(/recorded on this device/i);
    expect(line).toMatch(/the network has not confirmed it to MaaCash/i);
    expect(line).not.toMatch(/confirmed by|delivered|successful payment/i);
  });

  it("offers only states that stop short of a network verdict", () => {
    const labels = Object.values(COUNTER_STATUS_LABELS).join(" | ");
    expect(labels).not.toMatch(/confirmed|completed|paid/i);
    for (const flow of COUNTER_FLOWS) {
      expect(flow.label.length).toBeGreaterThan(0);
    }
  });

  it("keeps the permission policy closed", () => {
    // Nothing is required beyond the web platform today.
    expect(COUNTER_PERMISSION_POLICY.required).toHaveLength(0);
    const refused = COUNTER_PERMISSION_POLICY.refused.map((row) => row.permission);
    expect(refused).toContain("android.permission.READ_SMS");
    expect(refused).toContain("android.permission.READ_CALL_LOG");
    expect(refused).toContain("android.permission.BIND_ACCESSIBILITY_SERVICE");
    for (const row of COUNTER_PERMISSION_POLICY.refused) {
      expect(row.reason.length).toBeGreaterThan(30);
    }
  });

  it("masks a number it cannot parse instead of showing it", () => {
    expect(maskCustomerNumber("0244000111")).toBe("+233244•••11");
    expect(maskCustomerNumber(null)).toBeNull();
    expect(maskCustomerNumber("nonsense")).toBeNull();
  });
});
