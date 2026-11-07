/**
 * Approved MoMo terminology and reconciliation arithmetic.
 *
 * These tests lock the business-owner-approved labels in place and prove that
 * retiring the duplicate "Cash paid out" input neither double-counts nor
 * removes a genuine cash movement.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MOMO_FIELD_LABELS,
  calculateReconciliation,
  describeVariance,
} from "@/lib/momo-reconciliation";

function readSource(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("approved MoMo field names", () => {
  it("uses exactly the three approved labels", () => {
    expect(MOMO_FIELD_LABELS).toEqual({
      customerDeposit: "Customer deposit",
      cashOut: "Cash out",
      cashIn: "Cash in",
    });
  });

  it("shows the approved labels on the agent end-of-day form", () => {
    const form = readSource("src/app/worker/daily/[id]/page.tsx");
    expect(form).toContain("Customer deposit");
    expect(form).toContain("Cash out");
    expect(form).toContain("Cash in");
    expect(form).not.toContain("Money Added to MoMo");
    expect(form).not.toContain("Money Paid from MoMo");
    expect(form).not.toContain("Cash Received");
    expect(form).not.toContain("Cash Paid Out");
    // The retired duplicate input must not be rendered at all.
    expect(form).not.toContain('formData.set("totalCashPaid"');
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
      expect(source, file).toContain("Cash in");
      expect(source, file).not.toContain("Money Added to MoMo");
      expect(source, file).not.toContain("Money Paid from MoMo");
      expect(source, file).not.toContain("Cash Received");
      expect(source, file).not.toContain("Cash Paid Out");
    }
  });
});

describe("reconciliation arithmetic", () => {
  const balanced = calculateReconciliation({
    openingMomoFloat: 1000,
    openingCash: 500,
    customerDeposit: 600,
    cashOut: 450,
    cashIn: 600,
    commission: 15,
    otherIncome: 0,
    totalExpenses: 0,
    closingMomoFloat: 1150,
    closingCash: 665,
  });

  it("balances when actual equals expected", () => {
    expect(balanced.expectedMomoFloat).toBe(1150);
    expect(balanced.expectedCash).toBe(665);
    expect(balanced.momoVariance).toBe(0);
    expect(balanced.cashVariance).toBe(0);
    expect(balanced.totalVariance).toBe(0);
    expect(describeVariance(balanced.totalVariance)).toBe("Balanced");
  });

  it("counts Cash out exactly once on the cash side", () => {
    const oneCashOut = calculateReconciliation({
      openingMomoFloat: 0,
      openingCash: 1000,
      customerDeposit: 0,
      cashOut: 100,
      cashIn: 0,
      commission: 0,
      otherIncome: 0,
      totalExpenses: 0,
      closingMomoFloat: 0,
      closingCash: 900,
    });
    // 1000 - 100, not 1000 - 200.
    expect(oneCashOut.expectedCash).toBe(900);
    expect(oneCashOut.cashVariance).toBe(0);
  });

  it("matches the legacy result when Cash paid out duplicated Cash out", () => {
    // Before retirement both fields carried the same 450 movement: one against
    // the float and one against cash. The new single field must produce the
    // same cash expectation, so the movement is not lost or doubled.
    const legacyExpectedCash = 500 + 600 + 15 + 0 - 450 - 0;
    expect(balanced.expectedCash).toBe(legacyExpectedCash);
  });

  it("reports a genuine cash shortfall as a negative difference", () => {
    const short = calculateReconciliation({
      openingMomoFloat: 1150,
      openingCash: 665,
      customerDeposit: 400,
      cashOut: 520,
      cashIn: 400,
      commission: 12,
      otherIncome: 0,
      totalExpenses: 0,
      closingMomoFloat: 1030,
      closingCash: 512,
    });
    expect(short.expectedMomoFloat).toBe(1030);
    expect(short.expectedCash).toBe(557);
    expect(short.momoVariance).toBe(0);
    expect(short.cashVariance).toBe(-45);
    expect(short.totalVariance).toBe(-45);
    expect(describeVariance(short.totalVariance)).toBe("Short");
  });

  it("separates a float shortage from a cash shortage", () => {
    const floatShort = calculateReconciliation({
      openingMomoFloat: 1000,
      openingCash: 0,
      customerDeposit: 500,
      cashOut: 200,
      cashIn: 0,
      commission: 0,
      otherIncome: 0,
      totalExpenses: 0,
      closingMomoFloat: 1200,
      closingCash: 0,
    });
    expect(floatShort.momoVariance).toBe(-100);
    expect(floatShort.cashVariance).toBe(200);
    expect(floatShort.totalVariance).toBe(100);
  });
});
