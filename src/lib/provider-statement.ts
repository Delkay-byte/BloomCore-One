/**
 * Provider statement import — parsing, mapping, validation and matching rules.
 *
 * An imported provider statement is EVIDENCE, never a posting. Everything in
 * this module is pure: it reads text and returns rows plus verdicts. It cannot
 * create, edit or reverse a financial record, and the importer that uses it
 * never does so either.
 *
 * Money is handled as integer pesewa (1 GHS = 100 pesewa) so no binary
 * floating-point rounding can change an amount. Values are converted to a
 * Decimal only when they are stored.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

import {
  STATEMENT_PROVIDERS,
  isStatementProvider,
  type StatementProvider,
} from "./provider-statement-labels";

export * from "./provider-statement-labels";


/** Canonical fields a statement import can carry. */
export const STATEMENT_FIELDS = [
  "externalReference",
  "transactionAt",
  "direction",
  "amount",
  "fee",
  "balanceAfter",
  "description",
] as const;
export type StatementField = (typeof STATEMENT_FIELDS)[number];

export const STATEMENT_FIELD_LABELS: Record<StatementField, string> = {
  externalReference: "Transaction reference",
  transactionAt: "Transaction date and time",
  direction: "Direction (in / out)",
  amount: "Amount",
  fee: "Fee",
  balanceAfter: "Balance after",
  description: "Description",
};

/** Fields that must be mapped for an import to be meaningful. */
export const REQUIRED_STATEMENT_FIELDS: StatementField[] = [
  "transactionAt",
  "amount",
  "direction",
];

/**
 * Header synonyms, in priority order. A provider changes its export headings
 * often, so mapping is explicit and stored with the import: the same file can
 * always be re-read the same way.
 */
const HEADER_SYNONYMS: Record<StatementField, string[]> = {
  externalReference: [
    "transaction id",
    "transactionid",
    "transaction reference",
    "reference",
    "ref",
    "external ref",
    "external reference",
    "receipt no",
    "receipt number",
    "financial transaction id",
  ],
  transactionAt: [
    "date",
    "transaction date",
    "date time",
    "datetime",
    "transaction date and time",
    "time",
    "created at",
    "created",
    "value date",
  ],
  direction: ["direction", "type", "transaction type", "dr/cr", "debit/credit", "entry"],
  amount: ["amount", "value", "transaction amount", "amount (ghs)", "amount(ghs)", "ghs"],
  fee: ["fee", "charges", "charge", "commission", "fees"],
  balanceAfter: ["balance", "balance after", "running balance", "closing balance", "balance(ghs)"],
  description: ["description", "narration", "details", "particulars", "note", "memo"],
};

export const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;
export const MAX_STATEMENT_ROWS = 20_000;

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/** Parse delimited text into rows. Handles quotes, escaped quotes and CRLF. */
export function parseDelimited(input: string, delimiter = ","): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  // A trailing newline produces one extra empty row; a real final row does not.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function normaliseHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ");
}

/**
 * Detect a column mapping from a header row. Returns only the fields it is
 * confident about; the caller may override any of them before importing.
 */
export function detectColumnMapping(header: string[]): Partial<Record<StatementField, number>> {
  const mapping: Partial<Record<StatementField, number>> = {};
  const normalised = header.map(normaliseHeader);
  for (const field of STATEMENT_FIELDS) {
    const synonyms = HEADER_SYNONYMS[field];
    let found = -1;
    for (const synonym of synonyms) {
      const index = normalised.findIndex((value) => value === synonym);
      if (index >= 0) {
        found = index;
        break;
      }
    }
    if (found < 0) {
      // Fall back to a contains-match, longest synonym first, to tolerate
      // decorations such as "Amount (GHS)" or "Transaction Date (GMT)".
      const ordered = [...synonyms].sort((a, b) => b.length - a.length);
      for (const synonym of ordered) {
        const index = normalised.findIndex((value) => value.includes(synonym));
        if (index >= 0) {
          found = index;
          break;
        }
      }
    }
    if (found >= 0 && !Object.values(mapping).includes(found)) {
      mapping[field] = found;
    }
  }
  return mapping;
}

export function missingRequiredFields(
  mapping: Partial<Record<StatementField, number>>
): StatementField[] {
  return REQUIRED_STATEMENT_FIELDS.filter((field) => mapping[field] === undefined);
}

// ---------------------------------------------------------------------------
// Value normalisation
// ---------------------------------------------------------------------------

/**
 * Convert a money string to integer pesewa.
 *
 * Accepts "1,234.50", "1234.5", "GHS 12.00", "(12.00)" for a negative,
 * "-12.00", "12.005" is rejected rather than silently rounded.
 */
export function parseMoneyToMinor(raw: string): { ok: true; minor: number } | { ok: false; error: string } {
  const value = raw
    .trim()
    .replace(/^(ghs|gh¢|₵|gh)\s*/i, "")
    .replace(/\s/g, "");
  if (value === "") return { ok: false, error: "Amount is empty." };
  const negative = /^\(.*\)$/.test(value);
  const cleaned = value.replace(/^\((.*)\)$/, "$1").replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { ok: false, error: `"${raw.trim()}" is not a valid amount.` };
  }
  const sign = cleaned.startsWith("-") || negative ? -1 : 1;
  const unsigned = cleaned.replace(/^-/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > 2) {
    return { ok: false, error: `"${raw.trim()}" has more than two decimal places.` };
  }
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) {
    return { ok: false, error: `"${raw.trim()}" is too large.` };
  }
  return { ok: true, minor: sign * minor };
}

export function minorToNumber(minor: number): number {
  return Math.round(minor) / 100;
}

/**
 * Parse a provider timestamp.
 *
 * Ambiguous day-month order is never guessed silently: ISO 8601 and
 * `YYYY/MM/DD` are unambiguous, and `DD/MM/YYYY` is the documented Ghanaian
 * export convention. A value that matches none of them is rejected so a
 * mis-mapped column cannot move a transaction to the wrong day.
 */
export function parseStatementDate(raw: string): { ok: true; at: Date } | { ok: false; error: string } {
  const value = raw.trim();
  if (value === "") return { ok: false, error: "Date is empty." };

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (iso) {
    const [, y, m, d, hh = "00", mm = "00", ss = "00"] = iso;
    const at = new Date(
      Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))
    );
    return Number.isNaN(at.getTime())
      ? { ok: false, error: `"${value}" is not a valid date.` }
      : { ok: true, at };
  }

  const slashYearFirst = /^(\d{4})\/(\d{2})\/(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (slashYearFirst) {
    const [, y, m, d, hh = "00", mm = "00", ss = "00"] = slashYearFirst;
    const at = new Date(
      Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))
    );
    return Number.isNaN(at.getTime())
      ? { ok: false, error: `"${value}" is not a valid date.` }
      : { ok: true, at };
  }

  const dayFirst = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  if (dayFirst) {
    const [, d, m, y, hh = "00", mm = "00", ss = "00"] = dayFirst;
    const at = new Date(
      Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))
    );
    if (Number.isNaN(at.getTime())) {
      return { ok: false, error: `"${value}" is not a valid date.` };
    }
    return { ok: true, at };
  }

  return { ok: false, error: `"${value}" is not a recognised date format.` };
}

const INBOUND = new Set([
  "in",
  "credit",
  "cr",
  "c",
  "deposit",
  "received",
  "receive",
  "cash in",
  "cash-in",
  "collection",
]);
const OUTBOUND = new Set([
  "out",
  "debit",
  "dr",
  "d",
  "withdrawal",
  "withdraw",
  "payment",
  "cash out",
  "cash-out",
  "cashout",
  "sent",
  "transfer out",
]);

export function parseDirection(raw: string): { ok: true; direction: "in" | "out" } | { ok: false; error: string } {
  const value = raw.trim().toLowerCase();
  if (INBOUND.has(value)) return { ok: true, direction: "in" };
  if (OUTBOUND.has(value)) return { ok: true, direction: "out" };
  // Accept a signed amount in the direction column ("+100", "-100").
  if (/^\+\d/.test(value)) return { ok: true, direction: "in" };
  if (/^-\d/.test(value)) return { ok: true, direction: "out" };
  return { ok: false, error: `"${raw.trim()}" is not a recognised direction.` };
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

export type StatementRowStatus = "valid" | "invalid";

export interface ParsedStatementRow {
  rowNumber: number;
  /** Null when the row could not be parsed at all. */
  externalReference: string | null;
  transactionAt: Date | null;
  direction: "in" | "out" | null;
  amountMinor: number | null;
  feeMinor: number | null;
  balanceAfterMinor: number | null;
  description: string | null;
  rawRow: string;
  status: StatementRowStatus;
  errors: string[];
  fingerprint: string | null;
}

export interface ParsedStatement {
  header: string[];
  mapping: Partial<Record<StatementField, number>>;
  rows: ParsedStatementRow[];
  validRows: number;
  invalidRows: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  errors: string[];
}

function cell(cells: string[], index: number | undefined): string {
  if (index === undefined) return "";
  return (cells[index] ?? "").trim();
}

/** Deterministic identity for one statement line. */
export function statementFingerprint(input: {
  provider: string;
  externalReference: string | null;
  transactionAt: Date | null;
  direction: string | null;
  amountMinor: number | null;
}): string | null {
  if (!input.transactionAt || input.amountMinor === null || !input.direction) return null;
  const payload = [
    input.provider,
    (input.externalReference ?? "").toLowerCase(),
    input.transactionAt.toISOString(),
    input.direction,
    String(input.amountMinor),
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

export function parseStatement(input: {
  provider: StatementProvider;
  csv: string;
  mapping?: Partial<Record<StatementField, number>>;
  delimiter?: string;
  /** Header row present. Provider exports always have one. */
  hasHeader?: boolean;
}): ParsedStatement {
  const rows = parseDelimited(input.csv, input.delimiter ?? ",");
  const hasHeader = input.hasHeader ?? true;
  const header = hasHeader ? (rows[0] ?? []) : [];
  const mapping = input.mapping ?? detectColumnMapping(header);
  const errors: string[] = [];

  const missing = missingRequiredFields(mapping);
  if (missing.length > 0) {
    errors.push(
      `The import is missing a column for: ${missing
        .map((field) => STATEMENT_FIELD_LABELS[field])
        .join(", ")}.`
    );
  }

  const dataRows = hasHeader ? rows.slice(1) : rows;
  if (dataRows.length === 0) errors.push("The file contains no data rows.");
  if (dataRows.length > MAX_STATEMENT_ROWS) {
    errors.push(
      `The file has ${dataRows.length} rows; the limit is ${MAX_STATEMENT_ROWS}. Split the statement.`
    );
  }

  const parsed: ParsedStatementRow[] = [];
  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  const dataLength = Math.min(dataRows.length, MAX_STATEMENT_ROWS);

  for (let index = 0; index < dataLength; index += 1) {
    const cells = dataRows[index];
    const rowNumber = hasHeader ? index + 2 : index + 1;
    const rowErrors: string[] = [];

    const reference = cell(cells, mapping.externalReference) || null;

    let transactionAt: Date | null = null;
    if (mapping.transactionAt === undefined) {
      rowErrors.push("No date column is mapped.");
    } else {
      const dateResult = parseStatementDate(cell(cells, mapping.transactionAt));
      if (dateResult.ok) transactionAt = dateResult.at;
      else rowErrors.push(dateResult.error);
    }

    let direction: "in" | "out" | null = null;
    if (mapping.direction === undefined) {
      rowErrors.push("No direction column is mapped.");
    } else {
      const directionResult = parseDirection(cell(cells, mapping.direction));
      if (directionResult.ok) direction = directionResult.direction;
      else rowErrors.push(directionResult.error);
    }

    let amountMinor: number | null = null;
    if (mapping.amount === undefined) {
      rowErrors.push("No amount column is mapped.");
    } else {
      const amountResult = parseMoneyToMinor(cell(cells, mapping.amount));
      if (amountResult.ok) {
        amountMinor = Math.abs(amountResult.minor);
        if (amountMinor === 0) rowErrors.push("The amount is zero.");
      } else {
        rowErrors.push(amountResult.error);
      }
    }

    let feeMinor: number | null = null;
    if (mapping.fee !== undefined) {
      const raw = cell(cells, mapping.fee);
      if (raw !== "") {
        const feeResult = parseMoneyToMinor(raw);
        if (feeResult.ok) feeMinor = Math.abs(feeResult.minor);
        else rowErrors.push(`Fee: ${feeResult.error}`);
      }
    }

    let balanceAfterMinor: number | null = null;
    if (mapping.balanceAfter !== undefined) {
      const raw = cell(cells, mapping.balanceAfter);
      if (raw !== "") {
        const balanceResult = parseMoneyToMinor(raw);
        if (balanceResult.ok) balanceAfterMinor = balanceResult.minor;
        else rowErrors.push(`Balance after: ${balanceResult.error}`);
      }
    }

    const description = mapping.description === undefined ? null : cell(cells, mapping.description) || null;
    const fingerprint = statementFingerprint({
      provider: input.provider,
      externalReference: reference,
      transactionAt,
      direction,
      amountMinor,
    });

    if (transactionAt) {
      if (!periodStart || transactionAt < periodStart) periodStart = transactionAt;
      if (!periodEnd || transactionAt > periodEnd) periodEnd = transactionAt;
    }

    parsed.push({
      rowNumber,
      externalReference: reference,
      transactionAt,
      direction,
      amountMinor,
      feeMinor,
      balanceAfterMinor,
      description,
      rawRow: cells.join(",").slice(0, 1000),
      status: rowErrors.length === 0 ? "valid" : "invalid",
      errors: rowErrors,
      fingerprint,
    });
  }

  const validRows = parsed.filter((row) => row.status === "valid").length;
  return {
    header,
    mapping,
    rows: parsed,
    validRows,
    invalidRows: parsed.length - validRows,
    periodStart,
    periodEnd,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Matching against internal records
// ---------------------------------------------------------------------------

export interface MatchCandidate {
  id: string;
  reference: string | null;
  transactionAt: Date;
  direction: string;
  amountMinor: number;
}

export type MatchType = "exact_reference" | "amount_and_time";

export interface StatementMatch {
  entityId: string;
  matchType: MatchType;
}

/** How far apart a matched internal record and statement line may sit. */
export const MATCH_WINDOW_MINUTES = 15;

/**
 * Find the internal record a statement line corresponds to.
 *
 * A reference match must also agree on direction and amount: a reused reference
 * with a different value is not evidence of the same transaction. Otherwise the
 * amount must agree exactly and the timestamps must be within the window, with
 * exactly one such candidate. Ambiguity returns null so a human decides.
 */
export function findStatementMatch(
  row: { externalReference: string | null; transactionAt: Date | null; direction: string | null; amountMinor: number | null },
  candidates: MatchCandidate[]
): StatementMatch | null {
  if (!row.transactionAt || !row.direction || row.amountMinor === null) return null;

  if (row.externalReference) {
    const reference = row.externalReference.trim().toLowerCase();
    const referenceMatches = candidates.filter(
      (candidate) =>
        (candidate.reference ?? "").trim().toLowerCase() === reference &&
        candidate.direction === row.direction &&
        candidate.amountMinor === row.amountMinor
    );
    if (referenceMatches.length === 1) {
      return { entityId: referenceMatches[0].id, matchType: "exact_reference" };
    }
    if (referenceMatches.length > 1) return null;
  }

  const windowMs = MATCH_WINDOW_MINUTES * 60 * 1000;
  const amountMatches = candidates.filter(
    (candidate) =>
      candidate.direction === row.direction &&
      candidate.amountMinor === row.amountMinor &&
      Math.abs(candidate.transactionAt.getTime() - row.transactionAt!.getTime()) <= windowMs
  );
  if (amountMatches.length === 1) {
    return { entityId: amountMatches[0].id, matchType: "amount_and_time" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reconciliation report
// ---------------------------------------------------------------------------

export interface StatementReconciliationSummary {
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  duplicateRows: number;
  invalidRows: number;
  matchedInMinor: number;
  matchedOutMinor: number;
  unmatchedInMinor: number;
  unmatchedOutMinor: number;
  netUnmatchedMinor: number;
}

export function summariseStatementRows(
  rows: Array<{
    status: string;
    direction: string | null;
    amountMinor: number | null;
    matchType: string | null;
  }>
): StatementReconciliationSummary {
  const summary: StatementReconciliationSummary = {
    totalRows: rows.length,
    matchedRows: 0,
    unmatchedRows: 0,
    duplicateRows: 0,
    invalidRows: 0,
    matchedInMinor: 0,
    matchedOutMinor: 0,
    unmatchedInMinor: 0,
    unmatchedOutMinor: 0,
    netUnmatchedMinor: 0,
  };
  for (const row of rows) {
    const amount = row.amountMinor ?? 0;
    if (row.status === "duplicate") {
      summary.duplicateRows += 1;
      continue;
    }
    if (row.status === "invalid" || amount === 0) {
      summary.invalidRows += 1;
      continue;
    }
    const matched = row.matchType !== null || row.status === "matched";
    if (matched) {
      summary.matchedRows += 1;
      if (row.direction === "in") summary.matchedInMinor += amount;
      else summary.matchedOutMinor += amount;
    } else {
      summary.unmatchedRows += 1;
      if (row.direction === "in") summary.unmatchedInMinor += amount;
      else summary.unmatchedOutMinor += amount;
    }
  }
  summary.netUnmatchedMinor = summary.unmatchedInMinor - summary.unmatchedOutMinor;
  return summary;
}

// ---------------------------------------------------------------------------
// Action input validation
// ---------------------------------------------------------------------------

export const statementImportSchema = z.object({
  provider: z.enum(STATEMENT_PROVIDERS),
  fileName: z.string().trim().min(1, "Choose a statement file.").max(200),
  csv: z.string().min(1, "The statement file is empty.").max(MAX_STATEMENT_BYTES),
  note: z.string().trim().max(500).optional(),
});

export const statementCaseSchema = z.object({
  category: z.enum([
    "provider_statement",
    "branch_liquidity",
    "branch_transfer",
    "remittance",
    "shift",
    "daily_close",
    "other",
  ]),
  severity: z.enum(["high", "medium", "low"]),
  title: z.string().trim().min(5, "Describe the exception in at least 5 characters.").max(160),
  description: z.string().trim().max(2000).optional(),
  ownerId: z.string().trim().min(1).optional(),
  dueAt: z.string().trim().optional(),
  evidence: z.string().trim().max(2000).optional(),
  links: z
    .array(
      z.object({
        entityType: z.string().trim().min(1).max(60),
        entityId: z.string().trim().min(1).max(60),
        note: z.string().trim().max(300).optional(),
      })
    )
    .max(20)
    .optional(),
});

/** Age in whole days, used for the exception queue's ageing column. */
export function caseAgeDays(openedAt: Date, now: Date = new Date()): number {
  const ms = now.getTime() - openedAt.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}
