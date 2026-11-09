import { describe, expect, it } from "vitest";
import {
  parseExpenseLines,
  readExpenseFormValue,
  sumExpenseLines,
} from "@/lib/expense-lines";

describe("itemised MoMo expenses", () => {
  it("sums rows in pesewas and ignores the client aggregate", () => {
    const result = parseExpenseLines([
      { description: "Transport", amount: 10 },
      { description: "Food", amount: 5 },
      { description: "Data", amount: 20 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.total).toBe(35);
      expect(result.lines).toHaveLength(3);
    }
  });

  it("does not count fully blank rows", () => {
    const result = parseExpenseLines([
      { description: "", amount: 0 },
      { description: "   ", amount: "" },
      { description: "Transport", amount: 10 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.total).toBe(10);
  });

  it("rejects an amount without a description", () => {
    const result = parseExpenseLines([{ description: "  ", amount: 10 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("description");
  });

  it("rejects a description without a positive amount", () => {
    const result = parseExpenseLines([{ description: "Transport", amount: 0 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("amount");
  });

  it("rejects amounts with more than two decimal places", () => {
    const result = parseExpenseLines([{ description: "Transport", amount: 1.001 }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("two decimal");
  });

  it("parses the JSON form value and rejects malformed data", () => {
    expect(readExpenseFormValue('{"nope":true}').ok).toBe(false);
    expect(readExpenseFormValue("not-json").ok).toBe(false);
    const parsed = readExpenseFormValue(
      JSON.stringify([{ description: "Transport", amount: "10.50" }])
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.total).toBe(10.5);
  });

  it("returns GH₵0.00 for an empty list", () => {
    const result = parseExpenseLines([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.total).toBe(0);
    expect(sumExpenseLines([])).toBe(0);
  });
});
