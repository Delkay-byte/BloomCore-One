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
    // Expenses have one itemised section and no separate editable aggregate.
    expect(form).not.toContain('formData.set("totalExpenses"');
    expect(form).not.toContain("Add expense details (optional)");
    expect(form).toContain("Add Expense");
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
    expect(result.netIncrease).toBe(15);
    expect(result.profitRetained).toBe(15);
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

  it("reports a genuine shortage only below the opening capital floor", () => {
    const result = calculateReconciliation({
      openingMomoFloat: 1000,
      openingCash: 500,
      commission: 12,
      totalExpenses: 0,
      closingMomoFloat: 955,
      closingCash: 512,
    });
    expect(result.expectedClosing).toBe(1512);
    expect(result.capitalFloor).toBe(1500);
    expect(result.actualClosing).toBe(1467);
    expect(result.difference).toBe(-33);
    expect(result.status).toBe("shortage");
    expect(describeVariance(result.difference)).toBe("Shortage");
    expect(statusLabel("shortage")).toContain("Shortage");
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
    expect(describeVariance(result.difference)).toBe("Positive surplus");
    expect(statusLabel("positive")).toBe("Positive surplus");
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

/**
 * Pilot acceptance scenarios from the owner's report. Commission and debts
 * collected increase business money; expenses reduce it. A closing total equal
 * to the opening total is balanced even when profit was withdrawn. A shortage
 * is reported only when counted money is below the opening capital floor.
 */
describe("pilot acceptance scenarios", () => {
  it("Test A — no movements balances", () => {
    const result = calculateReconciliation({
      openingCash: 9500,
      openingMomoFloat: 0,
      closingCash: 9500,
      closingMomoFloat: 0,
      commission: 0,
      debtsCollected: 0,
      totalExpenses: 0,
    });
    expect(result.expectedClosing).toBe(9500);
    expect(result.actualClosing).toBe(9500);
    expect(result.difference).toBe(0);
    expect(result.status).toBe("balanced");
  });

  it("Test B — expenses only reduce expected and counted closing", () => {
    const result = calculateReconciliation({
      openingCash: 9500,
      openingMomoFloat: 0,
      closingCash: 9485,
      closingMomoFloat: 0,
      commission: 0,
      debtsCollected: 0,
      totalExpenses: 15,
    });
    expect(result.expectedClosing).toBe(9485);
    expect(result.netIncrease).toBe(-15);
    expect(result.actualClosing).toBe(9485);
    expect(result.difference).toBe(0);
    expect(result.status).toBe("balanced");
  });

  it("Test C — commission and debts collected balance when counted", () => {
    const result = calculateReconciliation({
      openingCash: 6708,
      openingMomoFloat: 2792,
      closingCash: 4059 + 468 + 250 - 15,
      closingMomoFloat: 5441,
      commission: 250,
      debtsCollected: 468,
      totalExpenses: 15,
    });
    expect(result.openingTotal).toBe(9500);
    expect(result.netIncrease).toBe(703);
    expect(result.expectedClosing).toBe(10203);
    expect(result.actualClosing).toBe(10203);
    expect(result.difference).toBe(0);
    expect(result.status).toBe("balanced");
    expect(result.profitRetained).toBe(703);
  });

  it("Test D — the reported GH₵9,500 closing balances; profit is not a loss", () => {
    const result = calculateReconciliation({
      openingCash: 6708,
      openingMomoFloat: 2792,
      closingCash: 4059,
      closingMomoFloat: 5441,
      commission: 250,
      debtsCollected: 468,
      totalExpenses: 15,
    });
    expect(result.expectedClosing).toBe(10203);
    expect(result.netIncrease).toBe(703);
    expect(result.actualClosing).toBe(9500);
    expect(result.capitalFloor).toBe(9500);
    expect(result.difference).toBe(0);
    expect(result.status).toBe("balanced");
    expect(result.profitRetained).toBe(0);
    expect(result.profitNotRetained).toBe(703);
  });

  it("Test D2 — a real shortage is reported only below the opening capital", () => {
    const result = calculateReconciliation({
      openingCash: 6708,
      openingMomoFloat: 2792,
      closingCash: 3959,
      closingMomoFloat: 5441,
      commission: 250,
      debtsCollected: 468,
      totalExpenses: 15,
    });
    expect(result.actualClosing).toBe(9400);
    expect(result.capitalFloor).toBe(9500);
    expect(result.difference).toBe(-100);
    expect(result.status).toBe("shortage");
  });

  it("Test E — money above expectation is a positive difference, not a shortage", () => {
    const surplus = calculateReconciliation({
      openingCash: 6708,
      openingMomoFloat: 2792,
      closingCash: 4059,
      closingMomoFloat: 5441 + 800,
      commission: 250,
      debtsCollected: 468,
      totalExpenses: 15,
    });
    expect(surplus.netIncrease).toBe(703);
    expect(surplus.expectedClosing).toBe(10203);
    expect(surplus.actualClosing).toBe(10300);
    expect(surplus.difference).toBe(97);
    expect(surplus.status).toBe("positive");
  });
});
