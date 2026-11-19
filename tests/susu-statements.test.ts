/**
 * Customer statement and receipt rules (Priority 4).
 *
 * Pure financial-ordering tests plus the receipt builder. No database: the
 * database actions are covered in customer-portal.test.ts.
 */

import { describe, expect, it } from "vitest";
import { buildSusuReceipt, buildSusuStatement } from "@/lib/susu-statements";

const contribution = (
  id: string,
  amount: number,
  when: string,
  overrides: Record<string, unknown> = {}
) => ({
  id,
  referenceId: `REF-C-${id}`,
  amount,
  collectionDate: new Date(when),
  channel: "direct_office",
  receivedByName: "Ama Mensah",
  notes: null,
  accountNumber: "BIK-S-1",
  cycleNumber: 1,
  ...overrides,
});

const withdrawal = (
  id: string,
  netAmount: number,
  when: string,
  overrides: Record<string, unknown> = {}
) => ({
  id,
  referenceId: `REF-W-${id}`,
  netAmount,
  commissionAmount: 0,
  createdAt: new Date(when),
  notes: null,
  status: "completed",
  accountNumber: "BIK-S-1",
  cycleNumber: 1,
  ...overrides,
});

describe("chronological running balance", () => {
  it("orders every entry by date and carries the balance in that order", () => {
    const { entries, summary } = buildSusuStatement({
      contributions: [
        contribution("c1", 50, "2026-01-01T09:00:00Z"),
        contribution("c2", 50, "2026-01-03T09:00:00Z"),
      ],
      withdrawals: [withdrawal("w1", 30, "2026-01-02T09:00:00Z")],
      commissions: [
        {
          id: "com1",
          amount: 10,
          createdAt: new Date("2026-01-02T09:00:01Z"),
          basis: "one_day_contribution",
          accountNumber: "BIK-S-1",
          cycleNumber: 1,
        },
      ],
    });

    expect(entries.map((entry) => entry.kind)).toEqual([
      "contribution",
      "withdrawal",
      "commission",
      "contribution",
    ]);
    expect(entries.map((entry) => entry.balance)).toEqual([50, 20, 10, 60]);
    expect(summary.openingBalance).toBe(0);
    expect(summary.closingBalance).toBe(60);
    expect(summary.credits).toBe(100);
    expect(summary.debits).toBe(40);
  });

  it("counts commission once, never from both the withdrawal and the commission row", () => {
    const { entries, summary } = buildSusuStatement({
      contributions: [contribution("c1", 100, "2026-01-01T09:00:00Z")],
      withdrawals: [
        withdrawal("w1", 50, "2026-01-02T09:00:00Z", { commissionAmount: 10 }),
      ],
      commissions: [
        {
          id: "com1",
          amount: 10,
          createdAt: new Date("2026-01-02T09:00:01Z"),
          basis: "one_day_contribution",
          accountNumber: "BIK-S-1",
          cycleNumber: 1,
        },
      ],
    });

    expect(entries).toHaveLength(3);
    expect(summary.commissionTotal).toBe(10);
    expect(summary.closingBalance).toBe(40);
  });

  it("keeps the original and its reversal visible and nets them to zero", () => {
    const { entries, summary } = buildSusuStatement({
      contributions: [
        contribution("c1", 50, "2026-01-01T09:00:00Z"),
        contribution("c2", -50, "2026-01-02T09:00:00Z", {
          reversalOfId: "c1",
          channel: "reversal",
        }),
      ],
      withdrawals: [],
      commissions: [],
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ amount: 50, isReversal: false });
    expect(entries[1]).toMatchObject({ amount: -50, isReversal: true, direction: "debit" });
    expect(summary.closingBalance).toBe(0);
  });

  it("treats a withdrawal reversal as money coming back in", () => {
    const { entries, summary } = buildSusuStatement({
      contributions: [contribution("c1", 100, "2026-01-01T09:00:00Z")],
      withdrawals: [
        withdrawal("w1", 40, "2026-01-02T09:00:00Z"),
        withdrawal("w2", -40, "2026-01-03T09:00:00Z", {
          reversalOfId: "w1",
          status: "reversal",
        }),
      ],
      commissions: [],
    });

    expect(entries.map((entry) => entry.amount)).toEqual([100, -40, 40]);
    expect(summary.closingBalance).toBe(100);
  });

  it("excludes an orphan reversed row and a pending withdrawal from the balance", () => {
    const { entries, summary } = buildSusuStatement({
      contributions: [
        contribution("c1", 50, "2026-01-01T09:00:00Z"),
        contribution("c2", 999, "2026-01-02T09:00:00Z", {
          reversedAt: new Date("2026-01-03T09:00:00Z"),
        }),
      ],
      withdrawals: [withdrawal("w1", 40, "2026-01-02T10:00:00Z", { status: "pending" })],
      commissions: [],
    });

    expect(entries).toHaveLength(1);
    expect(summary.closingBalance).toBe(50);
  });

  it("uses the date filter for opening and closing without hiding later entries from the balance", () => {
    const { entries, summary } = buildSusuStatement({
      contributions: [
        contribution("c1", 50, "2026-01-01T09:00:00Z"),
        contribution("c2", 50, "2026-01-03T09:00:00Z"),
      ],
      withdrawals: [withdrawal("w1", 30, "2026-01-02T09:00:00Z")],
      commissions: [],
      cardFees: [
        {
          id: "fee1",
          amount: 10,
          createdAt: new Date("2026-01-02T10:00:00Z"),
          notes: "Card issued",
          accountNumber: "BIK-S-1",
        },
      ],
      from: "2026-01-02",
      to: "2026-01-03",
    });

    expect(summary.openingBalance).toBe(50);
    expect(summary.closingBalance).toBe(60);
    expect(entries).toHaveLength(3);
    expect(summary.cardFeeTotal).toBe(10);
  });
});

describe("receipt document", () => {
  it("preserves the original reference and the paid amounts", () => {
    const receipt = buildSusuReceipt({
      kind: "withdrawal",
      reference: "REF-W-123",
      status: "completed",
      isReversal: false,
      issuedAt: new Date("2026-01-02T09:00:00Z"),
      businessName: "MaaCash Demo",
      customer: { customerId: "BIK-C-1", fullName: "Kofi Mensah", phone: "+233200000000" },
      accountNumber: "BIK-S-1",
      cycleNumber: 2,
      channel: "withdrawal",
      receivedBy: null,
      notes: "School fees",
      amount: 100,
      commissionAmount: 10,
      netAmount: 90,
    });

    expect(receipt).toMatchObject({
      reference: "REF-W-123",
      kind: "withdrawal",
      amount: 100,
      commissionAmount: 10,
      netAmount: 90,
      cycleNumber: 2,
      businessName: "MaaCash Demo",
    });
  });
});
