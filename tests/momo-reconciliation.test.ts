/**
 * Approved simplified MoMo daily closing.
 *
 * Business rules locked by these tests:
 *   Expected closing = opening physical cash + opening E-cash
 *                      + debts collected + commission - expenses
 *   Actual closing   = closing physical cash + closing E-cash
 * Customer deposits, cash out and airtime move money between the two pockets
 * and never change combined accountability, so the form does not ask for them.
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
  it("uses exactly the approved simplified labels", () => {
    expect(MOMO_FIELD_LABELS).toEqual({
      openingCash: "Total Physical Cash",
      openingMomoFloat: "Total E-cash",
      closingCash: "Total Physical Cash",
      closingMomoFloat: "Total E-cash",
      totalExpenses: "Expenses",
      commission: "Commission",
      debtsCollected: "Debts Collected",
    });
  });

  it("shows only the approved fields on the agent daily form", () => {
    const form = readSource("src/app/worker/daily/[id]/page.tsx");
    expect(form).toContain("START OF DAY");
    expect(form).toContain("END OF DAY");
    expect(form).toContain("Total Physical Cash");
    expect(form).toContain("Total E-cash");
    expect(form).toContain("Debts Collected");
    expect(form).toContain("Commission");
    expect(form).toContain("Expenses");
    // The retired transaction-by-transaction inputs must not come back.
    expect(form).not.toContain("Customer deposit (Cash in)");
    expect(form).not.toContain("Additional cash received");
    expect(form).not.toContain("Additional MoMo float received");
    expect(form).not.toContain("Airtime sold");
    expect(form).not.toContain('formData.set("totalCashIn"');
    expect(form).not.toContain('formData.set("totalCashOut"');
  });
});

describe("simplified accountability arithmetic", () => {
  it("balances when actual closing equals expected closing", () => {
    const result = calculateReconciliation({
      openingMomoFloat: 1000,
      openingCash: 500,
      commission: 15,
      totalExpenses: 0,
      closingMomoFloat: 765,
      closingCash: 750,
    });
    expect(result.openingTotal).toBe(1500);
    expect(result.expectedClosing).toBe(1515);
    expect(result.actualClosing).toBe(1515);
    expect(result.difference).toBe(0);
    expect(result.status).toBe("balanced");
    expect(describeVariance(result.difference)).toBe("Balanced");
    expect(statusLabel("balanced")).toBe("Balanced");
  });

  it("ignores legacy customer transaction fields", () => {
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

  it("adds debts collected once, increasing accountability", () => {
    const result = calculateReconciliation({
      openingMomoFloat: 400,
      openingCash: 100,
      debtsCollected: 100,
      closingMomoFloat: 400,
      closingCash: 200,
    });
    expect(result.openingTotal).toBe(500);
    expect(result.debtsCollected).toBe(100);
    expect(result.expectedClosing).toBe(600);
    expect(result.actualClosing).toBe(600);
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
      commission: 12,
      totalExpenses: 0,
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

  it("reports money above expectation as a positive (green) difference", () => {
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

  it("treats missing or invalid values as zero", () => {
    const result = calculateReconciliation({
      openingMomoFloat: Number.NaN,
      openingCash: 100,
      debtsCollected: Number.NaN,
      commission: Number.NaN,
      totalExpenses: Number.NaN,
      closingMomoFloat: 0,
      closingCash: 100,
    });
    expect(result.expectedClosing).toBe(100);
    expect(result.actualClosing).toBe(100);
    expect(result.difference).toBe(0);
  });

  it("uses integer pesewas so float drift cannot change money", () => {
    const result = calculateReconciliation({
      openingMomoFloat: 0.1,
      openingCash: 0.2,
      commission: 0,
      totalExpenses: 0,
      closingMomoFloat: 0,
      closingCash: 0.3,
    });
    expect(result.expectedClosing).toBe(0.3);
    expect(result.actualClosing).toBe(0.3);
    expect(result.difference).toBe(0);
    expect(result.status).toBe("balanced");
  });
});
