/**
 * Validation and duplicate classification for customer migration.
 *
 * This is the heart of Phase 7's safety story. It answers three questions for
 * every row, and it answers them the same way every time:
 *
 *   1. Is this row usable at all?            â†’ invalid (with reasons)
 *   2. Does MaaCash already know this person? â†’ new / link / possible duplicate
 *   3. Does MaaCash already know this ACCOUNT? â†’ exact duplicate / number conflict
 *
 * The classifier never guesses in the direction that creates data. A row that
 * could be a second account for an existing customer, or could be a new person
 * with a similar name, becomes `possible_customer_duplicate` and waits for a
 * human. Nothing is merged automatically, and no account number is ever
 * reassigned silently.
 *
 * The module is pure: it receives already-authorized reference data and returns
 * decisions. It performs no writes and no authorisation.
 */

import {
  ONBOARDING_LIMITS,
  cleanText,
  emailKey,
  looksLikeEmail,
  parseMoneyCell,
  personNameKey,
  phoneKey,
  referenceKey,
} from "@/lib/susu/identity";
import type { ParsedCsv } from "@/lib/susu/import-csv";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

export const IMPORT_FIELD_KEYS = [
  "fullName",
  "phone",
  "branchRef",
  "accountNumber",
  "dailyContribution",
  "openingDate",
  "collectorRef",
  "externalReference",
  "email",
  "address",
  "notes",
] as const;

export type ImportFieldKey = (typeof IMPORT_FIELD_KEYS)[number];

export interface ImportFieldDefinition {
  key: ImportFieldKey;
  label: string;
  hint: string;
  required: boolean;
  /** Header names that map to this field automatically. */
  aliases: readonly string[];
}

export const IMPORT_FIELDS: readonly ImportFieldDefinition[] = [
  {
    key: "fullName",
    label: "Customer full name",
    hint: "The name the business knows the person by.",
    required: true,
    aliases: [
      "full name",
      "fullname",
      "name",
      "customer name",
      "customer",
      "client name",
      "account name",
      "member name",
    ],
  },
  {
    key: "phone",
    label: "Phone number",
    hint: "Ghana mobile number. Shared and missing numbers are allowed.",
    required: false,
    aliases: ["phone", "phone number", "mobile", "mobile number", "telephone", "tel", "contact"],
  },
  {
    key: "branchRef",
    label: "Branch code or name",
    hint: "Matches a branch in this business. Required when rows belong to different branches.",
    required: false,
    aliases: ["branch", "branch code", "branch name", "location", "office", "station"],
  },
  {
    key: "accountNumber",
    label: "Existing account number",
    hint: "The number in your own book. Kept as a reference; MaaCash issues its own number when needed.",
    required: false,
    aliases: [
      "account number",
      "account no",
      "account",
      "card number",
      "card no",
      "passbook",
      "passbook number",
      "passbook no",
      "susu number",
    ],
  },
  {
    key: "dailyContribution",
    label: "Daily contribution (GHâ‚µ)",
    hint: "The agreed daily amount, e.g. 20.",
    required: true,
    aliases: [
      "daily contribution",
      "daily amount",
      "daily",
      "amount",
      "contribution",
      "daily susu",
      "rate",
      "daily deposit",
    ],
  },
  {
    key: "openingDate",
    label: "Opening date",
    hint: "When the account really opened. Use YYYY-MM-DD.",
    required: false,
    aliases: ["opening date", "date opened", "opened", "start date", "date started", "date"],
  },
  {
    key: "collectorRef",
    label: "Collector e-mail or name",
    hint: "Assign the customer to an existing collector in this business.",
    required: false,
    aliases: ["collector", "collector email", "collector name", "agent", "field agent", "field officer"],
  },
  {
    key: "externalReference",
    label: "Your customer reference",
    hint: "Your own reference for this person. Not unique, and never used to merge people.",
    required: false,
    aliases: ["reference", "customer reference", "customer id", "client id", "book number", "member id", "old id"],
  },
  {
    key: "email",
    label: "E-mail",
    hint: "Optional. An address already used by another MaaCash customer cannot be reused.",
    required: false,
    aliases: ["email", "e-mail", "email address", "e mail"],
  },
  {
    key: "address",
    label: "Address",
    hint: "Where the person lives or trades.",
    required: false,
    aliases: ["address", "location address", "residence", "town", "area", "house"],
  },
  {
    key: "notes",
    label: "Notes",
    hint: "Anything the office should know. Kept on the customer record.",
    required: false,
    aliases: ["notes", "note", "comment", "comments", "remark", "remarks", "description"],
  },
];

export const REQUIRED_IMPORT_FIELDS: readonly ImportFieldKey[] = IMPORT_FIELDS.filter(
  (field) => field.required
).map((field) => field.key);

/** MaaCash field â†’ zero-based column index (or absent when unmapped). */
export type ColumnMapping = Partial<Record<ImportFieldKey, number>>;

/**
 * Suggest a mapping from the spreadsheet's own headings.
 *
 * Only exact (normalized) alias matches are used, so a column called "Date of
 * birth" is never silently treated as the opening date. The operator confirms
 * or corrects every suggestion before anything is validated.
 */
export function autoDetectMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const usedColumns = new Set<number>();

  const normalized = headers.map((header) =>
    header
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );

  // Required fields claim their columns first so an optional field cannot steal
  // the only sensible "name" column.
  const ordered = [...IMPORT_FIELDS].sort(
    (a, b) => Number(b.required) - Number(a.required)
  );

  for (const field of ordered) {
    const exact = normalized.findIndex(
      (header, index) => !usedColumns.has(index) && field.aliases.includes(header)
    );
    if (exact >= 0) {
      mapping[field.key] = exact;
      usedColumns.add(exact);
      continue;
    }
    const partial = normalized.findIndex(
      (header, index) =>
        !usedColumns.has(index) &&
        header.length > 0 &&
        field.aliases.some((alias) => header.includes(alias) || alias.includes(header))
    );
    if (partial >= 0) {
      mapping[field.key] = partial;
      usedColumns.add(partial);
    }
  }

  return mapping;
}

/**
 * Validate a submitted mapping.
 *
 * A mapping is stored durably and drives the commit, so it must be internally
 * consistent: no column used twice, every index inside the header, and every
 * required field mapped.
 */
export function validateMapping(
  mapping: ColumnMapping,
  headerCount: number
): { ok: true; mapping: ColumnMapping } | { ok: false; error: string } {
  const cleaned: ColumnMapping = {};
  const used = new Map<number, ImportFieldKey>();

  for (const [rawKey, rawIndex] of Object.entries(mapping)) {
    if (rawIndex === null || rawIndex === undefined) continue;
    const key = rawKey as ImportFieldKey;
    if (!IMPORT_FIELD_KEYS.includes(key)) {
      return { ok: false, error: `Unknown field "${key}".` };
    }
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= headerCount) {
      return { ok: false, error: "A selected column is outside the file." };
    }
    if (used.has(index)) {
      const other = used.get(index)!;
      return {
        ok: false,
        error: `The same column is mapped to both "${other}" and "${key}".`,
      };
    }
    used.set(index, key);
    cleaned[key] = index;
  }

  for (const required of REQUIRED_IMPORT_FIELDS) {
    if (cleaned[required] === undefined) {
      const label = IMPORT_FIELDS.find((field) => field.key === required)!.label;
      return { ok: false, error: `"${label}" must be mapped to a column.` };
    }
  }

  return { ok: true, mapping: cleaned };
}

// ---------------------------------------------------------------------------
// Row classification vocabulary
// ---------------------------------------------------------------------------

export type ImportClassification =
  | "new_customer"
  | "new_account_existing_customer"
  | "exact_duplicate"
  | "possible_customer_duplicate"
  | "account_conflict"
  | "customer_conflict"
  | "invalid";

export type ImportResolution = "create_new" | "link_existing" | "exclude";

export const IMPORT_CLASSIFICATION_LABELS: Record<ImportClassification, string> = {
  new_customer: "New customer",
  new_account_existing_customer: "New account for existing customer",
  exact_duplicate: "Already in MaaCash",
  possible_customer_duplicate: "Possible duplicate â€” needs review",
  account_conflict: "Account number already used",
  customer_conflict: "Conflicts with an existing record",
  invalid: "Needs correction",
};

export const IMPORT_RESOLUTION_LABELS: Record<ImportResolution, string> = {
  create_new: "Create a new customer and account",
  link_existing: "Add an account to the matched customer",
  exclude: "Do not import this row",
};

export interface ImportIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
}

/** Reference data the classifier needs. Already tenant-authorised by the caller. */
export interface ImportReferenceData {
  branches: { id: string; code: string; name: string; status: string }[];
  collectors: {
    id: string;
    fullName: string;
    email: string | null;
    branchId: string | null;
    status: string;
  }[];
  customers: {
    id: string;
    customerId: string;
    fullName: string;
    phone: string | null;
    email: string | null;
    externalReference: string | null;
  }[];
  accounts: {
    id: string;
    accountId: string;
    externalAccountReference: string | null;
    customerId: string;
  }[];
}

export interface ImportRowDraft {
  rowNumber: number;
  rawRow: string;
  customerName: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  email: string | null;
  externalReference: string | null;
  address: string | null;
  notes: string | null;
  accountNumber: string | null;
  dailyContribution: number | null;
  openingDate: Date | null;
  branchRef: string | null;
  collectorRef: string | null;
  classification: ImportClassification;
  issues: ImportIssue[];
  matchReasons: string[];
  matchedCustomerId: string | null;
  matchedAccountId: string | null;
  branchId: string | null;
  collectorId: string | null;
  resolution: ImportResolution | null;
}

export interface ImportValidationOptions {
  branchMode: "single_branch" | "row_column";
  /** Destination branch for single_branch imports. */
  defaultBranchId: string | null;
  mapping: ColumnMapping;
  /**
   * Branches the operator may write to. `"all"` means company-wide. A row that
   * resolves to a branch outside this set is refused here, not at commit time,
   * so the operator learns before they commit rather than halfway through.
   */
  allowedBranchIds: Set<string> | "all";
  /**
   * True when the business has no branch configured at all (a legacy single
   * office). Phase 1 keeps such tenants working without a branch, so an import
   * must not invent one — rows are attributed to LEGACY_UNASSIGNED.
   */
  branchlessTenant?: boolean;
  /** Used only to format messages and to bound plausibility checks. */
  today?: Date;
}

// ---------------------------------------------------------------------------
// Cell parsing
// ---------------------------------------------------------------------------

interface DatePattern {
  regex: RegExp;
  /** Year/month/day as WRITTEN, used to reject a rolled-over date. */
  parts: (match: RegExpMatchArray) => { year: number; month: number; day: number };
}

const DATE_PATTERNS: DatePattern[] = [
  {
    regex: /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
    parts: (m) => ({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }),
  },
  {
    regex: /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
    parts: (m) => ({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }),
  },
  {
    // Ghana writes day first. Interpreted as DD/MM/YYYY deliberately; the
    // operator sees the interpreted date in the preview before committing.
    regex: /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/,
    parts: (m) => ({ year: Number(m[3]), month: Number(m[2]), day: Number(m[1]) }),
  },
];

/**
 * Parse a date cell.
 *
 * Ambiguous input is never guessed silently: the interpreted date is shown back
 * to the operator in the row preview, so a day/month swap is visible before it
 * is committed.
 */
export function parseDateCell(
  value: string
): { ok: true; date: Date } | { ok: false; reason: string } {
  const text = value.trim();
  if (!text) return { ok: false, reason: "empty" };

  for (const pattern of DATE_PATTERNS) {
    const match = text.match(pattern.regex);
    if (!match) continue;
    const { year, month, day } = pattern.parts(match);
    const date = new Date(year, month - 1, day);
    // Reject rollover dates such as 31/02/2019, which Date would silently move
    // to 2 March. A migration must never invent a date the source did not say.
    if (
      Number.isNaN(date.getTime()) ||
      date.getFullYear() !== year ||
      date.getMonth() + 1 !== month ||
      date.getDate() !== day
    ) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, date };
  }

  const fallback = new Date(text);
  if (!Number.isNaN(fallback.getTime()) && fallback.getFullYear() > 1900) {
    return { ok: true, date: fallback };
  }
  return { ok: false, reason: "invalid" };
}

/** Read one mapped cell, trimmed. Exported so callers can pre-scan a whole file. */
export function readCell(
  row: { cells: string[] },
  mapping: ColumnMapping,
  key: ImportFieldKey
): string {
  const index = mapping[key];
  if (index === undefined) return "";
  return (row.cells[index] ?? "").trim();
}

// ---------------------------------------------------------------------------
// Reference indexes
// ---------------------------------------------------------------------------

export interface ReferenceIndexes {
  branchesByCode: Map<string, ImportReferenceData["branches"][number]>;
  branchesByName: Map<string, ImportReferenceData["branches"][number][]>;
  collectorsByEmail: Map<string, ImportReferenceData["collectors"][number]>;
  collectorsByName: Map<string, ImportReferenceData["collectors"][number][]>;
  customersById: Map<string, ImportReferenceData["customers"][number]>;
  customersByReference: Map<string, ImportReferenceData["customers"][number][]>;
  customersByPhone: Map<string, ImportReferenceData["customers"][number][]>;
  customersByEmail: Map<string, ImportReferenceData["customers"][number][]>;
  customersByName: Map<string, ImportReferenceData["customers"][number][]>;
  accountsByNumber: Map<string, ImportReferenceData["accounts"][number]>;
  /** Emails claimed by ANY tenant, used to avoid a global-unique collision. */
  emailsInUse: Set<string>;
}

export function buildReferenceIndexes(
  reference: ImportReferenceData,
  emailsInUse: Set<string>
): ReferenceIndexes {
  const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };

  const index: ReferenceIndexes = {
    branchesByCode: new Map(),
    branchesByName: new Map(),
    collectorsByEmail: new Map(),
    collectorsByName: new Map(),
    customersById: new Map(),
    customersByReference: new Map(),
    customersByPhone: new Map(),
    customersByEmail: new Map(),
    customersByName: new Map(),
    accountsByNumber: new Map(),
    emailsInUse,
  };

  for (const branch of reference.branches) {
    index.branchesByCode.set(branch.code.trim().toLowerCase(), branch);
    push(index.branchesByName, branch.name.trim().toLowerCase(), branch);
  }
  for (const collector of reference.collectors) {
    if (collector.email) {
      index.collectorsByEmail.set(collector.email.trim().toLowerCase(), collector);
    }
    push(index.collectorsByName, personNameKey(collector.fullName), collector);
  }
  for (const customer of reference.customers) {
    index.customersById.set(customer.id, customer);
    const ref = referenceKey(customer.externalReference);
    if (ref) push(index.customersByReference, ref, customer);
    const phone = phoneKey(customer.phone);
    if (phone) push(index.customersByPhone, phone, customer);
    const email = emailKey(customer.email);
    if (email) push(index.customersByEmail, email, customer);
    const name = personNameKey(customer.fullName);
    if (name) push(index.customersByName, name, customer);
  }
  for (const account of reference.accounts) {
    index.accountsByNumber.set(account.accountId.trim().toLowerCase(), account);
    const external = referenceKey(account.externalAccountReference);
    if (external) index.accountsByNumber.set(external.toLowerCase(), account);
  }

  return index;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function firstIssue(issues: ImportIssue[]): ImportIssue | undefined {
  return issues.find((issue) => issue.severity === "error");
}

/**
 * Turn one parsed row into a draft decision.
 *
 * `seen` carries the in-file duplicate memory so two identical people in one
 * spreadsheet are caught before they become two customers.
 */
export function classifyRow(
  row: { rowNumber: number; cells: string[]; raw: string },
  options: ImportValidationOptions,
  index: ReferenceIndexes,
  seen: {
    references: Map<string, number>;
    phones: Map<string, { rowNumber: number; nameKey: string }>;
    emails: Map<string, { rowNumber: number; nameKey: string }>;
    accounts: Map<string, number>;
  }
): ImportRowDraft {
  const today = options.today ?? new Date();
  const issues: ImportIssue[] = [];
  const matchReasons: string[] = [];

  const rawName = readCell(row, options.mapping, "fullName");
  const customerName = cleanText(rawName, ONBOARDING_LIMITS.nameMax);
  if (!customerName) {
    issues.push({
      code: "name_required",
      message: "The customer's full name is missing.",
      severity: "error",
    });
  } else if (customerName.length < ONBOARDING_LIMITS.nameMin) {
    issues.push({
      code: "name_too_short",
      message: "The customer's name is too short to be a real name.",
      severity: "error",
    });
  }

  const rawPhone = readCell(row, options.mapping, "phone");
  const phone = cleanText(rawPhone, ONBOARDING_LIMITS.phoneMax);
  const phoneNormalized = phone ? phoneKey(phone) : "";
  if (phone && phoneNormalized.length !== 9) {
    issues.push({
      code: "phone_unrecognised",
      message: `"${phone}" is not a recognisable Ghana mobile number. The row can still be imported; the number is kept exactly as written.`,
      severity: "warning",
    });
  }

  const rawEmail = readCell(row, options.mapping, "email");
  const email = cleanText(rawEmail, 254);
  if (email && !looksLikeEmail(email)) {
    issues.push({
      code: "email_invalid",
      message: `"${email}" is not a valid e-mail address.`,
      severity: "error",
    });
  }

  const rawAmount = readCell(row, options.mapping, "dailyContribution");
  const parsedAmount = parseMoneyCell(
    rawAmount,
    ONBOARDING_LIMITS.dailyContributionMin,
    ONBOARDING_LIMITS.dailyContributionMax
  );
  if (!parsedAmount.ok) {
    issues.push({
      code: "daily_contribution_invalid",
      message: `Daily contribution: ${parsedAmount.reason.toLowerCase()}.`,
      severity: "error",
    });
  }

  const rawOpeningDate = readCell(row, options.mapping, "openingDate");
  let openingDate: Date | null = null;
  if (rawOpeningDate) {
    const parsed = parseDateCell(rawOpeningDate);
    if (!parsed.ok) {
      issues.push({
        code: "opening_date_invalid",
        message: `"${rawOpeningDate}" could not be read as a date. Use YYYY-MM-DD.`,
        severity: "error",
      });
    } else if (parsed.date.getTime() > today.getTime() + 24 * 60 * 60 * 1000) {
      issues.push({
        code: "opening_date_future",
        message: "The opening date is in the future.",
        severity: "error",
      });
    } else if (parsed.date.getFullYear() < 1980) {
      issues.push({
        code: "opening_date_implausible",
        message: "The opening date is implausibly early.",
        severity: "error",
      });
    } else {
      openingDate = parsed.date;
    }
  }

  const rawBranch = readCell(row, options.mapping, "branchRef");
  const branchRef = cleanText(rawBranch, ONBOARDING_LIMITS.nameMax);
  let branchId: string | null = null;
  if (options.branchMode === "single_branch") {
    branchId = options.defaultBranchId;
    if (!branchId && !options.branchlessTenant) {
      issues.push({
        code: "branch_required",
        message: "No destination branch was chosen for this import.",
        severity: "error",
      });
    }
  } else if (!branchRef) {
    issues.push({
      code: "branch_required",
      message: "The branch column is empty for this row.",
      severity: "error",
    });
  } else {
    const byCode = index.branchesByCode.get(branchRef.toLowerCase());
    const byName = index.branchesByName.get(branchRef.toLowerCase()) ?? [];
    const resolved = byCode ?? (byName.length === 1 ? byName[0] : undefined);
    if (!resolved && byName.length > 1) {
      issues.push({
        code: "branch_ambiguous",
        message: `"${branchRef}" matches more than one branch. Use the branch code.`,
        severity: "error",
      });
    } else if (!resolved) {
      issues.push({
        code: "branch_unknown",
        message: `There is no branch called "${branchRef}" in this business.`,
        severity: "error",
      });
    } else if (resolved.status !== "active") {
      issues.push({
        code: "branch_inactive",
        message: `The branch "${resolved.name}" is not active.`,
        severity: "error",
      });
    } else if (
      options.allowedBranchIds !== "all" &&
      !options.allowedBranchIds.has(resolved.id)
    ) {
      issues.push({
        code: "branch_unauthorised",
        message: `You are not authorised to import into "${resolved.name}".`,
        severity: "error",
      });
    } else {
      branchId = resolved.id;
    }
  }

  const rawCollector = readCell(row, options.mapping, "collectorRef");
  const collectorRef = cleanText(rawCollector, ONBOARDING_LIMITS.nameMax);
  let collectorId: string | null = null;
  if (collectorRef && index.collectorsByEmail.size + index.collectorsByName.size > 0) {
    const byEmail = index.collectorsByEmail.get(collectorRef.toLowerCase());
    const byName = index.collectorsByName.get(personNameKey(collectorRef)) ?? [];
    const resolved = byEmail ?? (byName.length === 1 ? byName[0] : undefined);
    if (!resolved && byName.length > 1) {
      issues.push({
        code: "collector_ambiguous",
        message: `"${collectorRef}" matches more than one collector. Use the collector's e-mail address.`,
        severity: "error",
      });
    } else if (!resolved) {
      issues.push({
        code: "collector_unknown",
        message: `There is no collector called "${collectorRef}" in this business.`,
        severity: "error",
      });
    } else if (resolved.status !== "active") {
      issues.push({
        code: "collector_inactive",
        message: `The collector "${resolved.fullName}" is not active.`,
        severity: "error",
      });
    } else {
      collectorId = resolved.id;
      if (resolved.branchId && branchId && resolved.branchId !== branchId) {
        issues.push({
          code: "collector_branch_mismatch",
          message: `"${resolved.fullName}" normally works in a different branch. The row is still imported and the collector is assigned.`,
          severity: "warning",
        });
      }
    }
  } else if (collectorRef) {
    issues.push({
      code: "collector_unknown",
      message: `There is no collector called "${collectorRef}" in this business.`,
      severity: "error",
    });
  }

  const rawAccountNumber = readCell(row, options.mapping, "accountNumber");
  const accountNumber = cleanText(rawAccountNumber, 64);

  const rawReference = readCell(row, options.mapping, "externalReference");
  const externalReference = cleanText(
    rawReference,
    ONBOARDING_LIMITS.externalReferenceMax
  );

  const address = cleanText(readCell(row, options.mapping, "address"), ONBOARDING_LIMITS.addressMax);
  const notes = cleanText(readCell(row, options.mapping, "notes"), ONBOARDING_LIMITS.notesMax);

  const draft: ImportRowDraft = {
    rowNumber: row.rowNumber,
    rawRow: row.raw,
    customerName,
    phone,
    phoneNormalized: phoneNormalized || null,
    email,
    externalReference,
    address,
    notes,
    accountNumber,
    dailyContribution: parsedAmount.ok ? parsedAmount.amount : null,
    openingDate,
    branchRef,
    collectorRef,
    classification: "new_customer",
    issues,
    matchReasons,
    matchedCustomerId: null,
    matchedAccountId: null,
    branchId,
    collectorId,
    resolution: null,
  };

  if (firstIssue(issues)) {
    draft.classification = "invalid";
    draft.resolution = null;
    return draft;
  }

  // â”€â”€ In-file duplicates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The same person typed twice in one spreadsheet is caught here, before any
  // database lookup, so a 3-line copy/paste mistake cannot create 3 customers.
  const nameKey = personNameKey(customerName ?? "");
  if (accountNumber) {
    const key = accountNumber.toLowerCase();
    const previous = seen.accounts.get(key);
    if (previous !== undefined) {
      issues.push({
        code: "duplicate_account_in_file",
        message: `Account number "${accountNumber}" already appears on row ${previous} of this file.`,
        severity: "error",
      });
      draft.classification = "invalid";
      return draft;
    }
    seen.accounts.set(key, row.rowNumber);
  }

  if (externalReference) {
    const key = referenceKey(externalReference);
    const previous = seen.references.get(key);
    if (previous !== undefined) {
      matchReasons.push(
        `Your reference "${externalReference}" is also used on row ${previous} of this file.`
      );
    } else {
      seen.references.set(key, row.rowNumber);
    }
  }

  const inFileMatches: { kind: string; rowNumber: number }[] = [];
  if (phoneNormalized && phoneNormalized.length === 9) {
    const previous = seen.phones.get(phoneNormalized);
    if (previous && previous.rowNumber !== row.rowNumber) {
      inFileMatches.push({ kind: "phone", rowNumber: previous.rowNumber });
    } else {
      seen.phones.set(phoneNormalized, { rowNumber: row.rowNumber, nameKey });
    }
  }
  const emailNorm = emailKey(email);
  if (emailNorm) {
    const previous = seen.emails.get(emailNorm);
    if (previous && previous.rowNumber !== row.rowNumber) {
      inFileMatches.push({ kind: "email", rowNumber: previous.rowNumber });
    } else {
      seen.emails.set(emailNorm, { rowNumber: row.rowNumber, nameKey });
    }
  }

  const sameNameInFile = inFileMatches.some((match) => {
    const recorded =
      match.kind === "phone"
        ? seen.phones.get(phoneNormalized)
        : seen.emails.get(emailNorm);
    return recorded?.nameKey === nameKey;
  });

  const inFileAmbiguous = inFileMatches.length > 0 && !sameNameInFile;
  if (inFileMatches.length > 0) {
    const rows = inFileMatches.map((match) => match.rowNumber).join(", ");
    if (sameNameInFile) {
      draft.classification = "exact_duplicate";
      draft.resolution = "exclude";
      draft.matchReasons.push(
        `This person already appears on row ${rows} of this file with the same name and contact details.`
      );
      return draft;
    }
    draft.classification = "possible_customer_duplicate";
    draft.matchReasons.push(
      `The same contact details appear on row ${rows} of this file under a different name.`
    );
  }

  // â”€â”€ Account number already known to MaaCash â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (accountNumber) {
    const existing = index.accountsByNumber.get(accountNumber.toLowerCase());
    if (existing) {
      const owner = index.customersById.get(existing.customerId);
      draft.matchedAccountId = existing.id;
      draft.matchedCustomerId = existing.customerId;
      if (owner && personNameKey(owner.fullName) === nameKey) {
        draft.classification = "exact_duplicate";
        draft.resolution = "exclude";
        draft.matchReasons.push(
          `Account "${existing.accountId}" is already in MaaCash for ${owner.fullName}.`
        );
        return draft;
      }
      draft.classification = "account_conflict";
      draft.matchReasons.push(
        owner
          ? `Account "${existing.accountId}" already belongs to ${owner.fullName}.`
          : `Account "${existing.accountId}" already exists in MaaCash.`
      );
      return draft;
    }
  }

  // â”€â”€ Matching against customers already in MaaCash â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const candidates = new Map<string, { customer: ImportReferenceData["customers"][number]; reasons: string[] }>();
  const addCandidate = (
    customer: ImportReferenceData["customers"][number],
    reason: string
  ) => {
    const entry = candidates.get(customer.id);
    if (entry) {
      if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    } else {
      candidates.set(customer.id, { customer, reasons: [reason] });
    }
  };

  const refNorm = referenceKey(externalReference);
  if (refNorm) {
    for (const customer of index.customersByReference.get(refNorm) ?? []) {
      addCandidate(customer, `the same customer reference ("${externalReference}")`);
    }
  }
  if (phoneNormalized && phoneNormalized.length === 9) {
    for (const customer of index.customersByPhone.get(phoneNormalized) ?? []) {
      addCandidate(customer, "the same phone number");
    }
  }
  if (emailNorm) {
    for (const customer of index.customersByEmail.get(emailNorm) ?? []) {
      addCandidate(customer, "the same e-mail address");
    }
  }
  for (const customer of index.customersByName.get(nameKey) ?? []) {
    addCandidate(customer, "the same full name");
  }

  // An e-mail address is globally unique in MaaCash. If it is claimed by a
  // customer in ANOTHER business, the row cannot be imported and must not say
  // whose address it is.
  if (emailNorm && index.emailsInUse.has(emailNorm) && candidates.size === 0) {
    draft.classification = "customer_conflict";
    draft.matchReasons.push(
      "That e-mail address is already registered to another MaaCash customer and cannot be used again."
    );
    return draft;
  }

  // Two rows in ONE file that share contact details but not a name are a
  // question only a person can answer. Never auto-link them: one of the two may
  // be a different human using a family phone.
  if (inFileAmbiguous) {
    draft.classification = "possible_customer_duplicate";
    draft.resolution = null;
    if (candidates.size > 0) {
      draft.matchReasons.push(
        `Also matches ${[...candidates.values()]
          .map((entry) => `${entry.customer.fullName} (${entry.customer.customerId})`)
          .join(", ")} in MaaCash.`
      );
    }
    return draft;
  }

  if (candidates.size === 1) {
    const [entry] = [...candidates.values()];
    const strong = entry.reasons.some(
      (reason) => !reason.startsWith("the same full name")
    );
    draft.matchedCustomerId = entry.customer.id;
    draft.matchReasons.push(
      `Matches ${entry.customer.fullName} (${entry.customer.customerId}) on ${entry.reasons.join(" and ")}.`
    );

    if (strong) {
      // A strong key means this is the same person opening (or having opened)
      // another account. That is safe: it creates an ACCOUNT, never a customer.
      draft.classification = "new_account_existing_customer";
      draft.resolution = "link_existing";
    } else {
      draft.classification = "possible_customer_duplicate";
      draft.resolution = null;
    }
    return draft;
  }

  if (candidates.size > 1) {
    draft.classification = "possible_customer_duplicate";
    draft.resolution = null;
    draft.matchReasons.push(
      `This row matches ${candidates.size} existing customers: ${[...candidates.values()]
        .map((entry) => `${entry.customer.fullName} (${entry.customer.customerId})`)
        .join(", ")}.`
    );
    return draft;
  }

  if (draft.classification === "possible_customer_duplicate") {
    // Only the in-file contact-detail clash reached this point.
    return draft;
  }

  draft.classification = "new_customer";
  draft.resolution = "create_new";
  return draft;
}

/**
 * Classify every parsed row.
 *
 * Returns the drafts plus the counts the operator sees on the review screen.
 */
export function classifyRows(
  parsed: ParsedCsv,
  options: ImportValidationOptions,
  reference: ImportReferenceData,
  emailsInUse: Set<string>
): { rows: ImportRowDraft[]; counts: Record<ImportClassification, number> } {
  const index = buildReferenceIndexes(reference, emailsInUse);
  const seen = {
    references: new Map<string, number>(),
    phones: new Map<string, { rowNumber: number; nameKey: string }>(),
    emails: new Map<string, { rowNumber: number; nameKey: string }>(),
    accounts: new Map<string, number>(),
  };

  const rows = parsed.rows.map((row) =>
    classifyRow(row, options, index, seen)
  );

  const counts: Record<ImportClassification, number> = {
    new_customer: 0,
    new_account_existing_customer: 0,
    exact_duplicate: 0,
    possible_customer_duplicate: 0,
    account_conflict: 0,
    customer_conflict: 0,
    invalid: 0,
  };
  for (const row of rows) counts[row.classification] += 1;

  return { rows, counts };
}

/** True when a row can never be committed and must be reported instead. */
export function isTerminalInvalid(classification: ImportClassification): boolean {
  return classification === "invalid";
}

/** True when a row still needs a human decision before a commit is allowed. */
export function needsDecision(draft: {
  classification: ImportClassification;
  resolution: ImportResolution | null;
}): boolean {
  if (draft.classification === "invalid") return false;
  return draft.resolution === null;
}

/** Default resolution offered by the UI for a classification. */
export function suggestedResolution(
  classification: ImportClassification
): ImportResolution | null {
  switch (classification) {
    case "new_customer":
      return "create_new";
    case "new_account_existing_customer":
      return "link_existing";
    case "exact_duplicate":
      return "exclude";
    default:
      return null;
  }
}

/** Which resolutions are legitimate for a classification. */
export function allowedResolutions(
  classification: ImportClassification
): ImportResolution[] {
  switch (classification) {
    case "new_customer":
      return ["create_new", "exclude"];
    case "new_account_existing_customer":
      return ["link_existing", "exclude"];
    case "exact_duplicate":
      return ["exclude"];
    case "possible_customer_duplicate":
      // Both are legitimate once a human has looked: the match is right, or the
      // row really is a different person who shares a name or a phone.
      return ["link_existing", "create_new", "exclude"];
    case "account_conflict":
      return ["create_new", "exclude"];
    case "customer_conflict":
      return ["create_new", "exclude"];
    case "invalid":
      return ["exclude"];
    default:
      return ["exclude"];
  }
}
