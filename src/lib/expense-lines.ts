import { z } from "zod";
import { fromPesewas, toPesewas } from "@/lib/momo-reconciliation";

/**
 * Itemised MoMo expenses.
 *
 * The expense list is the ONLY source of the daily Expenses total. A browser
 * aggregate is never trusted: every save and correction revalidates the rows
 * and sums them in integer pesewas on the server.
 */

export const MAX_EXPENSE_LINES = 100;
export const MAX_EXPENSE_AMOUNT = 999999.99;

export interface ExpenseLine {
  description: string;
  amount: number;
}

export type ExpenseParseResult =
  | { ok: true; lines: ExpenseLine[]; total: number }
  | { ok: false; error: string };

export const expenseLineSchema = z.object({
  description: z
    .string()
    .trim()
    .min(1, "Each expense needs a description.")
    .max(200, "Expense descriptions must be 200 characters or fewer."),
  amount: z
    .number()
    .finite("Enter a valid expense amount.")
    .min(0.01, "Each expense amount must be greater than 0.")
    .max(MAX_EXPENSE_AMOUNT, "Each expense amount is too large."),
});

export const expenseLinesSchema = z
  .array(expenseLineSchema)
  .max(MAX_EXPENSE_LINES, `Add no more than ${MAX_EXPENSE_LINES} expense lines.`);

/** True when the amount carries no more than two decimal places. */
export function hasCurrencyPrecision(value: number): boolean {
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

/** Sum expense lines in integer pesewas, so float drift cannot alter a total. */
export function sumExpenseLines(lines: ExpenseLine[]): number {
  return fromPesewas(
    lines.reduce((sum, line) => sum + toPesewas(line.amount), 0)
  );
}

function amountValue(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") return Number(raw);
  return Number.NaN;
}

/**
 * Validate raw expense rows and return the canonical list plus its total.
 *
 * Fully blank rows are ignored (they are not expenses). A row with only one
 * field filled is rejected instead of being silently discarded. The aggregate
 * supplied by the client is never read.
 */
export function parseExpenseLines(raw: unknown): ExpenseParseResult {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, lines: [], total: 0 };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: "Invalid expense data." };
  }
  if (raw.length > MAX_EXPENSE_LINES) {
    return {
      ok: false,
      error: `Add no more than ${MAX_EXPENSE_LINES} expense lines.`,
    };
  }

  const lines: ExpenseLine[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "Invalid expense data." };
    }
    const record = item as Record<string, unknown>;
    const description =
      typeof record.description === "string" ? record.description.trim() : "";
    const amount = amountValue(record.amount);

    // A completely blank row is not an expense. It must never add to the total.
    const amountBlank = !Number.isFinite(amount) || amount === 0;
    if (description === "" && amountBlank) continue;
    if (description === "") {
      return { ok: false, error: "Each expense needs a description." };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: "Each expense needs an amount greater than 0." };
    }
    if (amount > MAX_EXPENSE_AMOUNT) {
      return { ok: false, error: "Each expense amount is too large." };
    }
    if (!hasCurrencyPrecision(amount)) {
      return {
        ok: false,
        error: "Expense amounts must use no more than two decimal places.",
      };
    }
    lines.push({
      description,
      amount: fromPesewas(toPesewas(amount)),
    });
  }

  const total = sumExpenseLines(lines);
  if (total > MAX_EXPENSE_AMOUNT) {
    return { ok: false, error: "Total expenses are too large." };
  }
  return { ok: true, lines, total };
}

/** Read the JSON expense payload posted by a form and validate it. */
export function readExpenseFormValue(raw: FormDataEntryValue | null): ExpenseParseResult {
  if (raw === null) return { ok: true, lines: [], total: 0 };
  if (typeof raw !== "string") {
    return { ok: false, error: "Invalid expense data." };
  }
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, lines: [], total: 0 };
  try {
    return parseExpenseLines(JSON.parse(trimmed));
  } catch {
    return { ok: false, error: "Invalid expense data." };
  }
}
