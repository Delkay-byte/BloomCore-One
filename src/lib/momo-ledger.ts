/**
 * MoMo operational transaction ledger — domain rules.
 *
 * This module is the single place that defines what each operational
 * transaction does to the two pockets of business money (physical cash and
 * MoMo E-cash), and which postings drive the daily accountability figure.
 *
 * The approved simplified closing model still governs accountability:
 *
 *   expected closing = opening total
 *                    + commission + debts collected + other operational income
 *                    - approved expenses
 *
 * Customer deposits, cash-outs and airtime sales move value between the two
 * pockets. They are recorded for operational reporting but never change the
 * combined expected closing, so they can never be mistaken for revenue or
 * profit. A transaction's principal is never treated as commission.
 *
 * Every entry in this ledger is operator-recorded. `recordingSource` always
 * says so; nothing in this module implies a provider confirmation.
 */

import { z } from "zod";
import { hasCurrencyPrecision } from "./expense-lines";

export const MOMO_NETWORKS = [
  "mtn",
  "telecel",
  "at_money",
  "other",
  "unassigned",
] as const;
export type MomoNetwork = (typeof MOMO_NETWORKS)[number];

export const MOMO_NETWORK_LABELS: Record<MomoNetwork, string> = {
  mtn: "MTN MoMo",
  telecel: "Telecel Cash",
  at_money: "AT Money",
  other: "Other network",
  unassigned: "Not network-specific",
};

export const MOMO_TRANSACTION_TYPES = [
  "cash_in",
  "cash_out",
  "airtime_sale",
  "commission",
  "debts_collected",
  "other_income",
  "expense",
] as const;
export type MomoTransactionType = (typeof MOMO_TRANSACTION_TYPES)[number];

export const MOMO_VERIFICATION_STATUSES = [
  "operator_recorded",
  "statement_imported",
  "provider_confirmed",
  "disputed",
] as const;
export type MomoVerificationStatus = (typeof MOMO_VERIFICATION_STATUSES)[number];

export const MOMO_VERIFICATION_LABELS: Record<MomoVerificationStatus, string> = {
  operator_recorded: "Operator-recorded — not provider-verified",
  statement_imported: "Imported statement — not independently verified",
  provider_confirmed: "Provider-confirmed",
  disputed: "Disputed — under review",
};

export function isMomoVerificationStatus(
  value: unknown
): value is MomoVerificationStatus {
  return (
    typeof value === "string" &&
    (MOMO_VERIFICATION_STATUSES as readonly string[]).includes(value)
  );
}

export type LedgerEffectClass = "principal" | "commission" | "income" | "expense";

export interface MomoTransactionDefinition {
  label: string;
  shortLabel: string;
  effectClass: LedgerEffectClass;
  /** +1 adds to physical cash, -1 removes, 0 leaves it unchanged. */
  cashEffect: -1 | 0 | 1;
  /** +1 adds to E-cash, -1 removes, 0 leaves it unchanged. */
  floatEffect: -1 | 0 | 1;
  /** True when the principal is an operational movement, never revenue. */
  principalMovement: boolean;
  help: string;
}

export const MOMO_TRANSACTION_DEFINITIONS: Record<
  MomoTransactionType,
  MomoTransactionDefinition
> = {
  cash_in: {
    label: "MoMo cash in (customer deposit)",
    shortLabel: "Cash in",
    effectClass: "principal",
    cashEffect: 1,
    floatEffect: -1,
    principalMovement: true,
    help: "The customer hands over physical cash and you send the same value as E-cash. Customer money, never business revenue.",
  },
  cash_out: {
    label: "MoMo cash out (customer withdrawal)",
    shortLabel: "Cash out",
    effectClass: "principal",
    cashEffect: -1,
    floatEffect: 1,
    principalMovement: true,
    help: "You hand over physical cash and receive the same value as E-cash. Customer money, never business revenue.",
  },
  airtime_sale: {
    label: "Airtime sale",
    shortLabel: "Airtime",
    effectClass: "principal",
    cashEffect: 1,
    floatEffect: -1,
    principalMovement: true,
    help: "The customer pays cash and your E-cash balance falls by the same value. Recorded for operations only.",
  },
  commission: {
    label: "Commission (day total or provider posting)",
    shortLabel: "Commission",
    effectClass: "commission",
    cashEffect: 0,
    floatEffect: 0,
    principalMovement: false,
    help: "Commission earned from the provider statement. This is business income. Record it once, either as a day total or per transaction, never both.",
  },
  debts_collected: {
    label: "Debt collected",
    shortLabel: "Debt collected",
    effectClass: "income",
    cashEffect: 1,
    floatEffect: 0,
    principalMovement: false,
    help: "Money received from someone who previously owed the business. It increases the money you must account for.",
  },
  other_income: {
    label: "Other approved operational income",
    shortLabel: "Other income",
    effectClass: "income",
    cashEffect: 1,
    floatEffect: 0,
    principalMovement: false,
    help: "Approved operational income that is not commission or a debt collection. It increases accountability.",
  },
  expense: {
    label: "Business expense",
    shortLabel: "Expense",
    effectClass: "expense",
    cashEffect: -1,
    floatEffect: 0,
    principalMovement: false,
    help: "A legitimate business cost paid from physical cash. It reduces the money you must account for.",
  },
};

export function isMomoNetwork(value: unknown): value is MomoNetwork {
  return typeof value === "string" && (MOMO_NETWORKS as readonly string[]).includes(value);
}

export function isMomoTransactionType(value: unknown): value is MomoTransactionType {
  return (
    typeof value === "string" &&
    (MOMO_TRANSACTION_TYPES as readonly string[]).includes(value)
  );
}

export function transactionDefinition(type: MomoTransactionType): MomoTransactionDefinition {
  return MOMO_TRANSACTION_DEFINITIONS[type];
}

/** Direction stored on every row. Reversals are explicitly marked. */
export function deriveDirection(type: MomoTransactionType): "inflow" | "outflow" | "neutral" {
  const definition = transactionDefinition(type);
  if (definition.effectClass === "expense") return "outflow";
  if (definition.effectClass === "commission" || definition.effectClass === "income") {
    return "inflow";
  }
  return "neutral";
}

export function networkLabel(value: string | null | undefined): string {
  return isMomoNetwork(value) ? MOMO_NETWORK_LABELS[value] : "Not network-specific";
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export interface LedgerRowForTotals {
  type: string;
  amount: unknown;
  commissionAmount?: unknown;
  status: string;
}

export type CommissionBasis = "none" | "day_total" | "per_transaction";

export interface LedgerSummary {
  entryCount: number;
  principalCount: number;
  cashIn: number;
  cashOut: number;
  airtimeSold: number;
  commission: number;
  commissionBasis: CommissionBasis;
  debtsCollected: number;
  otherIncome: number;
  expenses: number;
  /** Net change in physical cash implied by the recorded operational entries. */
  cashMovement: number;
  /** Net change in E-cash implied by the recorded operational entries. */
  floatMovement: number;
  /** Accountability increase = commission + debts + other income - expenses. */
  netIncrease: number;
  principalTotal: number;
}

function money(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const rounded = Math.round((parsed + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Derive the day's accountability figures from the effective ledger rows.
 *
 * Only `recorded` rows are effective. A reversed or corrected row keeps its
 * original values but is superseded, and its reversal/successor row carries the
 * current position. That is what makes the posting history immutable without
 * double counting.
 *
 * Commission precedence: when the day contains one or more day-total
 * commission rows, those are the commission source and any per-transaction
 * `commissionAmount` is treated as reference information only. Otherwise
 * per-transaction commission is summed. The two are never added together.
 */
export function summariseLedger(rows: LedgerRowForTotals[]): LedgerSummary {
  const effective = rows.filter((row) => row.status === "recorded");
  let cashIn = 0;
  let cashOut = 0;
  let airtimeSold = 0;
  let standaloneCommission = 0;
  let perTransactionCommission = 0;
  let debtsCollected = 0;
  let otherIncome = 0;
  let expenses = 0;
  let cashMovement = 0;
  let floatMovement = 0;
  let principalCount = 0;
  let principalTotal = 0;

  for (const row of effective) {
    if (!isMomoTransactionType(row.type)) continue;
    const definition = transactionDefinition(row.type);
    const amount = Math.abs(money(row.amount));
    if (definition.principalMovement) principalCount += 1;
    if (definition.principalMovement) principalTotal += amount;

    cashMovement += definition.cashEffect * amount;
    floatMovement += definition.floatEffect * amount;

    switch (row.type) {
      case "cash_in":
        cashIn += amount;
        break;
      case "cash_out":
        cashOut += amount;
        break;
      case "airtime_sale":
        airtimeSold += amount;
        break;
      case "commission":
        standaloneCommission += amount;
        break;
      case "debts_collected":
        debtsCollected += amount;
        break;
      case "other_income":
        otherIncome += amount;
        break;
      case "expense":
        expenses += amount;
        break;
      default:
        break;
    }

    // Commission recorded against any row is reference information; the
    // day-total precedence rule above decides whether it is counted.
    if (row.commissionAmount) {
      perTransactionCommission += Math.max(0, money(row.commissionAmount));
    }
  }

  const commission =
    standaloneCommission > 0 ? standaloneCommission : perTransactionCommission;
  const commissionBasis: CommissionBasis =
    standaloneCommission > 0
      ? "day_total"
      : perTransactionCommission > 0
        ? "per_transaction"
        : "none";

  const netIncrease =
    Math.round((commission + debtsCollected + otherIncome - expenses) * 100) / 100;

  return {
    entryCount: effective.length,
    principalCount,
    cashIn: money(cashIn),
    cashOut: money(cashOut),
    airtimeSold: money(airtimeSold),
    commission: money(commission),
    commissionBasis,
    debtsCollected: money(debtsCollected),
    otherIncome: money(otherIncome),
    expenses: money(expenses),
    cashMovement: money(cashMovement),
    floatMovement: money(floatMovement),
    netIncrease,
    principalTotal: money(principalTotal),
  };
}

export interface LedgerProjection {
  openingCash: number;
  openingFloat: number;
  projectedCash: number;
  projectedFloat: number;
  projectedTotal: number;
  expectedClosing: number;
  netIncrease: number;
}

/**
 * Running operational position for the worker.
 *
 * `projectedCash`/`projectedFloat` are what the recorded entries imply for each
 * pocket. `expectedClosing` is the accountability figure that must be present
 * at close. Both are informational until the worker submits the counted close;
 * the counted figures remain the reconciliation input.
 */
export function projectLedgerPosition(
  summary: LedgerSummary,
  opening: { openingCash: unknown; openingFloat: unknown }
): LedgerProjection {
  const openingCash = money(opening.openingCash);
  const openingFloat = money(opening.openingFloat);
  const projectedCash = money(openingCash + summary.cashMovement);
  const projectedFloat = money(openingFloat + summary.floatMovement);
  return {
    openingCash,
    openingFloat,
    projectedCash,
    projectedFloat,
    projectedTotal: money(projectedCash + projectedFloat),
    expectedClosing: money(openingCash + openingFloat + summary.netIncrease),
    netIncrease: summary.netIncrease,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,63}$/;

const amountSchema = z
  .number()
  .finite("Enter a valid amount.")
  .positive("The amount must be greater than zero.")
  .max(999_999_999.99, "The amount is too large.")
  .refine(hasCurrencyPrecision, "The amount must use no more than two decimal places.");

export const momoTransactionInputSchema = z
  .object({
    type: z.enum(MOMO_TRANSACTION_TYPES),
    network: z.enum(MOMO_NETWORKS).default("unassigned"),
    amount: amountSchema,
    commissionAmount: z
      .number()
      .finite()
      .min(0, "Commission cannot be negative.")
      .max(999_999_999.99)
      .refine(hasCurrencyPrecision, "Commission must use no more than two decimal places.")
      .default(0),
    occurredAt: z.string().min(1, "Transaction time is required."),
    reference: z
      .string()
      .trim()
      .min(3, "Enter a business reference of at least 3 characters.")
      .max(64, "The reference must be 64 characters or fewer.")
      .regex(referencePattern, "Use letters, numbers, dot, slash, dash or underscore."),
    externalReference: z
      .string()
      .trim()
      .max(64, "The provider reference must be 64 characters or fewer.")
      .optional()
      .nullable(),
    note: z.string().trim().max(300, "The note must be 300 characters or fewer.").optional(),
    supportingEvidence: z
      .string()
      .trim()
      .max(300, "Supporting evidence must be 300 characters or fewer.")
      .optional(),
    idempotencyKey: z
      .string()
      .trim()
      .min(8, "A submission key is required.")
      .max(120, "The submission key is too long."),
  })
  .superRefine((value, ctx) => {
    const definition = transactionDefinition(value.type);
    if (value.type === "commission" && value.commissionAmount > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["commissionAmount"],
        message:
          "A day-total commission row already carries the commission in its amount.",
      });
    }
    if (definition.principalMovement && value.commissionAmount > 0 && value.type === "airtime_sale") {
      ctx.addIssue({
        code: "custom",
        path: ["commissionAmount"],
        message: "Airtime sales do not carry a separate commission in this ledger.",
      });
    }
  });

export type MomoTransactionInput = z.infer<typeof momoTransactionInputSchema>;

/** Business-date window in UTC. Time is supplied as ISO and must fall inside. */
export function businessDateWindow(businessDate: Date): { start: Date; end: Date } {
  const start = new Date(
    Date.UTC(
      businessDate.getUTCFullYear(),
      businessDate.getUTCMonth(),
      businessDate.getUTCDate()
    )
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export function isWithinBusinessDate(occurredAt: Date, businessDate: Date): boolean {
  if (Number.isNaN(occurredAt.getTime())) return false;
  const { start, end } = businessDateWindow(businessDate);
  return occurredAt >= start && occurredAt < end;
}

/**
 * A carried opening position may be adjusted, but a material change has to be
 * explained. GH₵1.00 is the materiality boundary; rounding noise below it is
 * treated as the same position.
 */
export const MATERIAL_OPENING_DIFFERENCE = 1;

export interface OpeningCarryForward {
  available: boolean;
  sourceAccountId: string | null;
  businessDate: string | null;
  openingCash: number | null;
  openingMomoFloat: number | null;
  /** Why no position could be carried. */
  reason: "no_prior_account" | "prior_unapproved" | "prior_unresolved" | null;
}

/**
 * Decide whether a prior closing can seed the next opening.
 *
 * Policy (deterministic and deliberately conservative):
 *   - the immediately preceding account for the location must exist;
 *   - it must have been reviewed by an administrator;
 *   - its stored reconciliation must be balanced.
 * A submitted-but-unreviewed, corrected-with-shortage or otherwise unresolved
 * day is never carried automatically. The worker must enter the opening
 * themselves and explain it.
 */
export function decideOpeningCarryForward(
  prior:
    | {
        id: string;
        businessDate: Date;
        status: string;
        closingCash: unknown;
        closingMomoFloat: unknown;
      }
    | null,
  difference: { status: "balanced" | "positive" | "shortage" } | null
): OpeningCarryForward {
  if (!prior) {
    return {
      available: false,
      sourceAccountId: null,
      businessDate: null,
      openingCash: null,
      openingMomoFloat: null,
      reason: "no_prior_account",
    };
  }
  const base = {
    sourceAccountId: prior.id,
    businessDate: prior.businessDate.toISOString(),
    openingCash: null,
    openingMomoFloat: null,
  };
  if (prior.status !== "reviewed") {
    return { ...base, available: false, reason: "prior_unapproved" };
  }
  if (!difference || difference.status !== "balanced") {
    return { ...base, available: false, reason: "prior_unresolved" };
  }
  return {
    ...base,
    available: true,
    openingCash: money(prior.closingCash),
    openingMomoFloat: money(prior.closingMomoFloat),
    reason: null,
  };
}

/** True when two opening amounts are the same within the materiality boundary. */
export function openingDifferenceIsMaterial(
  manual: { cash: unknown; float: unknown },
  reference: { cash: unknown; float: unknown }
): boolean {
  const cashDiff = Math.abs(money(manual.cash) - money(reference.cash));
  const floatDiff = Math.abs(money(manual.float) - money(reference.float));
  return cashDiff >= MATERIAL_OPENING_DIFFERENCE || floatDiff >= MATERIAL_OPENING_DIFFERENCE;
}

export function formatCedis(value: number): string {
  return `GH₵${money(value).toFixed(2)}`;
}
