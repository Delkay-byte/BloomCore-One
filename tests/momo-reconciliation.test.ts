/**
 * Approved MoMo terminology and the corrected combined-accountability model.
 *
 * Business rules locked by these tests:
 *   Expected closing = opening cash + opening float + additional funding
 *                      + commission - expenses
 *   Actual closing   = closing cash + closing float
 * Customer deposits, cash out and airtime sales move money between the two
 * pockets and never change combined accountability.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MOMO_FIELD_LABELS,
  calculateReconciliation,
  describeVariance,
  statusLabel,
} from "@/lib/momo-reconciliation";

function readSource(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("approved MoMo field names", () => {
  it("uses exactly the approved labels", () => {
    expect(MOMO_FIELD_LABELS).toEqual({
      customerDeposit: "Customer deposit (Cash in)",
      cashOut: "Cash out",
      airtimeSold: "Airtime sold",
      additionalCashReceived: "Additional cash received",
      additionalMomoFloatReceived: "Additional MoMo float received",
      commission: "Commission earned",
      totalExpenses: "Business expenses",
      openingCash: "Opening physical cash",
      openingMomoFloat: "Opening MoMo float",
      closingCash: "Actual closing physical cash",
      closingMomoFloat: "Actual closing MoMo float",
    });
  });

  it("shows the approved labels on the agent end-of-day form", () => {
    const form = readSource("src/app/worker/daily/[id]/page.tsx");
    expect(form).toContain("Customer deposit (Cash in)");
    expect(form).toContain("Cash out");
    expect(form).toContain("Airtime sold");
    expect(form).toContain("Additional cash received");
    expect(form).toContain("Additional MoMo float received");
    expect(form).toContain("Commission earned");
    expect(form).not.toContain("Money Added to MoMo");
    expect(form).not.toContain("Money Paid from MoMo");
    expect(form).not.toContain("Cash Received");
    expect(form).not.toContain("Cash Paid Out");
    // Retired duplicate inputs must not be rendered at all.
    expect(form).not.toContain('formData.set("totalCashPaid"');
    expect(form).not.toContain('formData.set("totalCashReceived"');
  });

  it("uses the approved labels in administrator views and exports", () => {
    for (const file of [
      "src/app/admin/(workspace)/history/page.tsx",
      "src/app/admin/(workspace)/reports/page.tsx",
      "src/app/admin/(workspace)/reports/[id]/page.tsx",
      "src/app/admin/(workspace)/history/[id]/correct/CorrectionForm.tsx",
      "src/lib/actions/momo-history.actions.ts",
    ]) {
      const source = readSource(file);
      expect(source, file).toContain("Customer deposit");
      expect(source, file).toContain("Cash out");
      expect(source, file).not.toContain("Money Added to MoMo");
      expect(source, file).not.toContain("Money Paid from MoMo");
      expect(source, file).not.toContain("Cash Received");
      expect(source, file).not.toContain("Cash Paid Out");
    }
  });
});

describe("combined accountability arithmetic", () => {
  it("balances when actual closing equals expected closing", () => {
    // Opening 1000 float + 500 cash = 1500.
    // Deposits 600, cash out 450 and airtime 100 only move money between the
    // pockets. Commission 15 is the sole increase.
    const result = calculateReconciliation({
      openingMomoFloat: 1000,
      openingCash: 500,
      customerDeposit: 600,
      cashOut: 450,
      airtimeSold: 100,
      commission: 15,
      totalExpenses: 0,
      closingMomoFloat: 765,
      closingCash: 750,
    });
    expect(result.openingTotal).toBe(1500);
    expect(result.additionalFunding).toBe(0);
    expect(result.expectedClosing).toBe(1515);
    expect(result.actualClosing).toBe(1515);
    expect(result.difference).toBe(0);
    expect(result.status).toBe("balanced");
    expect(describeVariance(result.difference)).toBe("Balanced");
    expect(statusLabel("balanced")).toBe("Balanced");
  });

  it("does not change accountability when customers deposit, withdraw or buy airtime", () => {
    const result = calculateReconciliation({
      openingMomoFloat: 0,
      openingCash: 0,
      customerDeposit: 2500,
      cashOut: 1800,
      airtimeSold: 700,
      commission: 0,
      totalExpenses: 0,
      closingMomoFloat: 0,
      closingCash: 0,
    });
    expect(result.expectedClosing).toBe(0);
    expect(result.actualClosing).toBe(0);
    expect(result.difference).toBe(0);
    expect(result.status).toBe("balanced");
  });

  it("adds additional cash and additional float once each", () => {
    const result = calculateReconciliation({
      openingMomoFloat: 400,
      openingCash: 100,
      additionalCashReceived: 200,
      additionalMomoFloat: 300,
      closingMomoFloat: 700,
      closingCash: 300,
    });
    expect(result.openingTotal).toBe(500);
    expect(result.additionalFunding).toBe(500);
    expect(result.expectedClosing).toBe(1000);
    expect(result.actualClosing).toBe(1000);
    expect(result.difference).toBe(0);
  });

  it("adds commission once and deducts itemised expenses once", () => {
    const result = calculateReconciliation({
      openingMomoFloat: 900,
      openingCash: 100,
      commission: 50,
      totalExpenses: 30,
      closingMomoFloat: 950,
      closingCash: 70,
    });
    expect(result.expectedClosing).toBe(1020);
    expect(result.actualClosing).toBe(1020);
    expect(result.difference).toBe(0);
  });

  it("reports a shortage as a negative difference requiring investigation", () => {
    const result = calculateReconciliation({
      openingMomoFloat: 1000,
      openingCash: 500,
      customerDeposit: 400,
      cashOut: 520,
      airtimeSold: 0,
      commission: 12,
      totalExpenses: 0,
      // Expected 1512; actual 1467: GH₵45 missing.
      closingMomoFloat: 955,
      closingCash: 512,
    });
    expect(result.expectedClosing).toBe(1512);
    expect(result.actualClosing).toBe(1467);
    expect(result.difference).toBe(-45);
    expect(result.status).toBe("shortage");
    expect(describeVariance(result.difference)).toBe("Shortage");
    expect(statusLabel("shortage")).toBe("Shortage — Investigation Required");
  });

  it("reports money above expectation as a positive difference", () => {
    const result = calculateReconciliation({
      openingMomoFloat: 1000,
      openingCash: 500,
      commission: 0,
      totalExpenses: 0,
      closingMomoFloat: 1000,
      closingCash: 520,
    });
    expect(result.difference).toBe(20);
    expect(result.status).toBe("positive");
    expect(describeVariance(result.difference)).toBe("Positive difference");
    expect(statusLabel("positive")).toBe("Positive difference");
  });

  it("treats missing or invalid optional values as zero", () => {
    const result = calculateReconciliation({
      openingMomoFloat: Number.NaN,
      openingCash: 100,
      customerDeposit: Number.NaN,
      cashOut: undefined as unknown as number,
      airtimeSold: Number.NaN,
      commission: Number.NaN,
      totalExpenses: Number.NaN,
      closingMomoFloat: 0,
      closingCash: 100,
    });
    expect(result.expectedClosing).toBe(100);
    expect(result.actualClosing).toBe(100);
    expect(result.difference).toBe(0);
  });

  it("keeps the movement guides informational only", () => {
    const result = calculateReconciliation({
      openingMomoFloat: 1000,
      openingCash: 500,
      customerDeposit: 600,
      cashOut: 450,
      airtimeSold: 100,
      closingMomoFloat: 750,
      closingCash: 750,
    });
    expect(result.expectedMomoFloat).toBe(750);
    expect(result.expectedCash).toBe(750);
    // The guides agree here, and accountability is balanced.
    expect(result.difference).toBe(0);
  });
});
