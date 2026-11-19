/**
 * Customer statement and receipt rules.
 *
 * Pure functions only: the database actions map rows into these inputs. This
 * keeps the financial ordering, running balance and receipt content testable
 * without a server, and prevents the statement from presenting a balance that
 * was calculated in a different order from the displayed rows.
 *
 * Money rules:
 * - A contribution credits the customer; a contribution reversal is a negative
 *   contribution row and therefore debits.
 * - A withdrawal debits its net paid amount; a withdrawal reversal is a
 *   negative net amount and therefore credits.
 * - Commission is taken from the Commission table only. The withdrawal row also
 *   carries commissionAmount, but adding both would double count it.
 * - A card fee debits the customer.
 */

export type SusuStatementKind =
  | "contribution"
  | "withdrawal"
  | "commission"
  | "card_fee";

export interface StatementContributionRow {
  id: string;
  referenceId: string;
  amount: unknown;
  collectionDate: Date | string;
  channel: string;
  receivedByName: string | null;
  recordedByName?: string | null;
  notes: string | null;
  reversalOfId?: string | null;
  reversedAt?: Date | string | null;
  accountNumber?: string | null;
  cycleNumber: number;
}

export interface StatementWithdrawalRow {
  id: string;
  referenceId: string;
  netAmount: unknown;
  commissionAmount: unknown;
  createdAt: Date | string;
  notes: string | null;
  status: string;
  reversalOfId?: string | null;
  reversedAt?: Date | string | null;
  accountNumber?: string | null;
  cycleNumber: number;
}

export interface StatementCommissionRow {
  id: string;
  amount: unknown;
  createdAt: Date | string;
  basis: string;
  accountNumber?: string | null;
  cycleNumber: number;
}

export interface StatementCardFeeRow {
  id: string;
  amount: unknown;
  createdAt: Date | string;
  notes: string | null;
  accountNumber?: string | null;
}

export interface SusuStatementEntry {
  id: string;
  kind: SusuStatementKind;
  /** Signed effect on the customer's balance. Credits are positive. */
  amount: number;
  direction: "credit" | "debit";
  balance: number;
  occurredAt: string;
  cycleNumber: number | null;
  accountNumber: string | null;
  channel: string | null;
  receivedBy: string | null;
  status: string;
  isReversal: boolean;
  notes: string | null;
  /** Existing operator reference used as the receipt number. */
  reference: string | null;
  receiptAvailable: boolean;
}

export interface SusuStatementSummary {
  openingBalance: number;
  closingBalance: number;
  credits: number;
  debits: number;
  contributionTotal: number;
  withdrawalTotal: number;
  commissionTotal: number;
  cardFeeTotal: number;
  entryCount: number;
  from: string | null;
  to: string | null;
}

export interface SusuStatement {
  entries: SusuStatementEntry[];
  summary: SusuStatementSummary;
}

function money(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const rounded = Math.round((parsed + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function iso(value: Date | string): string {
  return date(value).toISOString();
}

type InternalEntry = Omit<SusuStatementEntry, "balance"> & { at: number; order: number };

export function buildSusuStatement(input: {
  contributions: StatementContributionRow[];
  withdrawals: StatementWithdrawalRow[];
  commissions: StatementCommissionRow[];
  cardFees?: StatementCardFeeRow[];
  from?: string | null;
  to?: string | null;
}): SusuStatement {
  const raw: InternalEntry[] = [];
  let order = 0;

  // A reversed original is only paired when its reversal row is present. A
  // historical row that was marked reversed without a reversal entry must not
  // keep inflating the balance.
  const contributionReversals = new Set(
    input.contributions.map((row) => row.reversalOfId).filter(Boolean)
  );
  const withdrawalReversals = new Set(
    input.withdrawals.map((row) => row.reversalOfId).filter(Boolean)
  );

  for (const row of input.contributions) {
    if (row.reversedAt && !contributionReversals.has(row.id)) continue;
    const amount = money(row.amount);
    raw.push({
      id: row.id,
      kind: "contribution",
      amount,
      direction: amount >= 0 ? "credit" : "debit",
      occurredAt: iso(row.collectionDate),
      at: date(row.collectionDate).getTime(),
      order: order++,
      cycleNumber: row.cycleNumber,
      accountNumber: row.accountNumber ?? null,
      channel: row.channel,
      receivedBy: row.receivedByName ?? row.recordedByName ?? null,
      status: row.reversedAt ? "reversed" : row.reversalOfId ? "reversal" : "completed",
      isReversal: Boolean(row.reversalOfId),
      notes: row.notes,
      reference: row.referenceId,
      receiptAvailable: true,
    });
  }

  for (const row of input.withdrawals) {
    if (row.reversedAt && !withdrawalReversals.has(row.id)) continue;
    if (!row.reversalOfId && (row.status === "pending" || row.status === "rejected")) {
      continue;
    }
    const net = money(row.netAmount);
    const amount = money(-net);
    raw.push({
      id: row.id,
      kind: "withdrawal",
      amount,
      direction: amount >= 0 ? "credit" : "debit",
      occurredAt: iso(row.createdAt),
      at: date(row.createdAt).getTime(),
      order: order++,
      cycleNumber: row.cycleNumber,
      accountNumber: row.accountNumber ?? null,
      channel: "withdrawal",
      receivedBy: null,
      status: row.status,
      isReversal: Boolean(row.reversalOfId),
      notes: row.notes,
      reference: row.referenceId,
      receiptAvailable: true,
    });
  }

  for (const row of input.commissions) {
    const rawAmount = money(row.amount);
    const amount = rawAmount < 0 ? Math.abs(rawAmount) : -Math.abs(rawAmount);
    raw.push({
      id: row.id,
      kind: "commission",
      amount,
      direction: amount >= 0 ? "credit" : "debit",
      occurredAt: iso(row.createdAt),
      at: date(row.createdAt).getTime(),
      order: order++,
      cycleNumber: row.cycleNumber,
      accountNumber: row.accountNumber ?? null,
      channel: "commission",
      receivedBy: null,
      status: row.basis === "reversal" ? "reversal" : "completed",
      isReversal: row.basis === "reversal",
      notes: row.basis === "reversal" ? "Commission reversal" : "First-withdrawal commission",
      reference: null,
      receiptAvailable: false,
    });
  }

  for (const row of input.cardFees ?? []) {
    const amount = money(-Math.abs(money(row.amount)));
    raw.push({
      id: row.id,
      kind: "card_fee",
      amount,
      direction: "debit",
      occurredAt: iso(row.createdAt),
      at: date(row.createdAt).getTime(),
      order: order++,
      cycleNumber: null,
      accountNumber: row.accountNumber ?? null,
      channel: "card_fee",
      receivedBy: null,
      status: "completed",
      isReversal: false,
      notes: row.notes,
      reference: null,
      receiptAvailable: false,
    });
  }

  raw.sort((a, b) => a.at - b.at || a.order - b.order);

  const fromMs = input.from ? new Date(`${input.from}T00:00:00.000Z`).getTime() : null;
  const toMs = input.to ? new Date(`${input.to}T23:59:59.999Z`).getTime() : null;

  let running = 0;
  for (const entry of raw) {
    if (fromMs !== null && entry.at < fromMs) running += entry.amount;
  }
  const openingBalance = money(running);

  const entries: SusuStatementEntry[] = [];
  let credits = 0;
  let debits = 0;
  let contributionTotal = 0;
  let withdrawalTotal = 0;
  let commissionTotal = 0;
  let cardFeeTotal = 0;

  for (const entry of raw) {
    if (fromMs !== null && entry.at < fromMs) continue;
    if (toMs !== null && entry.at > toMs) continue;
    running = money(running + entry.amount);

    entries.push({
      id: entry.id,
      kind: entry.kind,
      amount: entry.amount,
      direction: entry.direction,
      balance: running,
      occurredAt: entry.occurredAt,
      cycleNumber: entry.cycleNumber,
      accountNumber: entry.accountNumber,
      channel: entry.channel,
      receivedBy: entry.receivedBy,
      status: entry.status,
      isReversal: entry.isReversal,
      notes: entry.notes,
      reference: entry.reference,
      receiptAvailable: entry.receiptAvailable,
    });

    if (entry.amount > 0) credits += entry.amount;
    if (entry.amount < 0) debits += Math.abs(entry.amount);
    if (entry.kind === "contribution") contributionTotal += entry.amount;
    if (entry.kind === "withdrawal") withdrawalTotal += Math.abs(entry.amount);
    if (entry.kind === "commission") commissionTotal += -entry.amount;
    if (entry.kind === "card_fee") cardFeeTotal += Math.abs(entry.amount);
  }

  return {
    entries,
    summary: {
      openingBalance,
      closingBalance: money(running),
      credits: money(credits),
      debits: money(debits),
      contributionTotal: money(contributionTotal),
      withdrawalTotal: money(withdrawalTotal),
      commissionTotal: money(commissionTotal),
      cardFeeTotal: money(cardFeeTotal),
      entryCount: entries.length,
      from: input.from ?? null,
      to: input.to ?? null,
    },
  };
}

export type SusuReceiptKind = "contribution" | "withdrawal";

export interface SusuReceipt {
  reference: string;
  kind: SusuReceiptKind;
  status: string;
  isReversal: boolean;
  issuedAt: string;
  businessName: string;
  customer: {
    customerId: string;
    fullName: string;
    phone: string | null;
  };
  accountNumber: string;
  cycleNumber: number;
  channel: string;
  receivedBy: string | null;
  notes: string | null;
  amount: number;
  commissionAmount: number;
  netAmount: number;
}

export function buildSusuReceipt(input: {
  kind: SusuReceiptKind;
  reference: string;
  status: string;
  isReversal: boolean;
  issuedAt: Date | string;
  businessName: string;
  customer: { customerId: string; fullName: string; phone: string | null };
  accountNumber: string;
  cycleNumber: number;
  channel: string;
  receivedBy: string | null;
  notes: string | null;
  amount: unknown;
  commissionAmount?: unknown;
  netAmount?: unknown;
}): SusuReceipt {
  const amount = money(input.amount);
  return {
    reference: input.reference,
    kind: input.kind,
    status: input.status,
    isReversal: input.isReversal,
    issuedAt: iso(input.issuedAt),
    businessName: input.businessName,
    customer: input.customer,
    accountNumber: input.accountNumber,
    cycleNumber: input.cycleNumber,
    channel: input.channel,
    receivedBy: input.receivedBy,
    notes: input.notes,
    amount,
    commissionAmount: money(input.commissionAmount ?? 0),
    netAmount: money(input.netAmount ?? amount),
  };
}
