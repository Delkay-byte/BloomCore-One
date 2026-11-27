/**
 * CSV parsing for the customer migration importer.
 *
 * The parser is deliberately strict and bounded, because everything it returns
 * came from a file an operator downloaded from another system:
 *
 *   * RFC 4180 quoting, CRLF or LF line endings, BOM tolerated.
 *   * A hard cap on bytes, columns, rows and cell length, so a 200 MB file or a
 *     single 5 MB cell cannot exhaust memory or the database.
 *   * No formula evaluation and no HTML: values are data, not markup.
 *   * Delimiter is detected from the header line (comma, semicolon or tab)
 *     because "Save as CSV" means different things in different locales.
 *
 * This module never touches the database and never decides what a row means.
 */

import { buildCsv } from "@/lib/csv";

export const CSV_LIMITS = {
  /** 4 MB of text is roughly 40,000 realistic rows; the row cap binds first. */
  maxChars: 4 * 1024 * 1024,
  maxRows: 5_000,
  maxColumns: 40,
  maxCellChars: 500,
} as const;

export type CsvDelimiter = "," | ";" | "\t";

export interface ParsedCsv {
  headers: string[];
  /** Data rows, each padded to the header width. */
  rows: { rowNumber: number; cells: string[]; raw: string }[];
  delimiter: CsvDelimiter;
  /** Number of data rows before the cap was applied. */
  truncatedRows: number;
}

export type CsvParseResult =
  | { ok: true; data: ParsedCsv }
  | { ok: false; error: string };

/** Strip a UTF-8 BOM so the first header cell is not "\uFEFFName". */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Pick the delimiter that splits the header line into the most sensible number
 * of fields. Ties favour the comma, which is what "CSV" means by default.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts: { delimiter: CsvDelimiter; count: number }[] = [
    { delimiter: ",", count: 0 },
    { delimiter: ";", count: 0 },
    { delimiter: "\t", count: 0 },
  ];
  let inQuotes = false;
  for (let i = 0; i < firstLine.length; i++) {
    const char = firstLine[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    const hit = counts.find((entry) => entry.delimiter === char);
    if (hit) hit.count += 1;
  }
  counts.sort((a, b) => b.count - a.count);
  return counts[0].count === 0 ? "," : counts[0].delimiter;
}

/**
 * Split the whole document into records.
 *
 * Returns the raw record text as well as its cells so a rejected row can be
 * shown back to the operator exactly as it appeared in their file.
 */
function splitRecords(
  text: string,
  delimiter: CsvDelimiter
): { cells: string[]; raw: string }[] {
  const records: { cells: string[]; raw: string }[] = [];
  let cells: string[] = [];
  let field = "";
  let raw = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    cells.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push({ cells, raw: raw.replace(/\r$/, "") });
    cells = [];
    raw = "";
  };

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          raw += '""';
          i += 2;
          continue;
        }
        inQuotes = false;
        raw += char;
        i += 1;
        continue;
      }
      field += char;
      raw += char;
      i += 1;
      continue;
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true;
      raw += char;
      i += 1;
      continue;
    }
    if (char === delimiter) {
      endField();
      raw += char;
      i += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      const isCrLf = char === "\r" && text[i + 1] === "\n";
      raw += isCrLf ? "\r\n" : char;
      i += isCrLf ? 2 : 1;
      endRecord();
      continue;
    }
    field += char;
    raw += char;
    i += 1;
  }

  // A trailing newline must not produce a phantom empty record.
  if (field.length > 0 || cells.length > 0) endRecord();
  return records;
}

/**
 * Parse and bound a CSV document.
 *
 * Header cells are trimmed and de-duplicated (a second "Phone" column becomes
 * "Phone (2)") so a mapping UI can address every column unambiguously.
 */
export function parseCsv(input: string): CsvParseResult {
  if (typeof input !== "string") {
    return { ok: false, error: "The file could not be read as text." };
  }
  const text = stripBom(input);
  if (!text.trim()) {
    return { ok: false, error: "The file is empty." };
  }
  if (text.length > CSV_LIMITS.maxChars) {
    return {
      ok: false,
      error: "The file is larger than 4 MB. Split it into smaller batches.",
    };
  }
  // NUL bytes mean the operator uploaded a binary file (or a .xls renamed to
  // .csv). Guessing at encodings here would corrupt real names.
  if (text.includes("\u0000")) {
    return {
      ok: false,
      error:
        "This file is not plain CSV text. Re-save it as CSV (UTF-8) and try again.",
    };
  }

  const delimiter = detectDelimiter(text);
  const records = splitRecords(text, delimiter).filter(
    (record) => record.cells.some((cell) => cell.trim() !== "")
  );

  if (records.length === 0) {
    return { ok: false, error: "The file has no readable rows." };
  }

  const headerRecord = records[0];
  if (headerRecord.cells.length > CSV_LIMITS.maxColumns) {
    return {
      ok: false,
      error: `The file has more than ${CSV_LIMITS.maxColumns} columns.`,
    };
  }

  const seen = new Map<string, number>();
  const headers = headerRecord.cells.map((cell, index) => {
    const base = cell.trim() || `Column ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });

  if (headers.every((header) => /^Column \d+$/.test(header))) {
    return {
      ok: false,
      error:
        "The first row must contain column headings so the columns can be matched.",
    };
  }

  const dataRecords = records.slice(1);
  const truncatedRows =
    dataRecords.length > CSV_LIMITS.maxRows
      ? dataRecords.length - CSV_LIMITS.maxRows
      : 0;

  const rows = dataRecords.slice(0, CSV_LIMITS.maxRows).map((record, index) => {
    const cells = headers.map((_, column) => {
      const value = record.cells[column] ?? "";
      return value.length > CSV_LIMITS.maxCellChars
        ? value.slice(0, CSV_LIMITS.maxCellChars)
        : value;
    });
    return {
      // Row numbers are 1-based over the DATA rows, so "row 3" in a report is
      // the third customer, which is what an operator counts on screen.
      rowNumber: index + 1,
      cells,
      raw: record.raw.slice(0, 1_000),
    };
  });

  return { ok: true, data: { headers, rows, delimiter, truncatedRows } };
}

/** A stable digest of the header row, so a re-map cannot read a different file. */
export async function hashHeaderRow(headers: string[]): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256")
    .update(headers.map((header) => header.trim()).join("\u001f"))
    .digest("hex");
}

/** SHA-256 of a file's exact bytes, used to detect a re-uploaded file. */
export async function hashFileBytes(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

/** The download template shown to operators before they prepare a file. */
export function buildImportTemplateCsv(): string {
  return buildCsv([
    [
      "Full name",
      "Phone",
      "Branch code",
      "Account number",
      "Daily contribution",
      "Opening date (YYYY-MM-DD)",
      "Collector email",
      "Customer reference",
      "Email",
      "Address",
      "Notes",
    ],
    [
      "Ama Mensah",
      "0241234567",
      "ACC",
      "",
      "20",
      "2019-03-01",
      "",
      "BOOK-1042",
      "",
      "Adum, Kumasi",
      "Migrated from the 2019 paper register",
    ],
    [
      "Kofi Boateng",
      "+233201234567",
      "KSI",
      "KS-204",
      "50",
      "2020-07-15",
      "",
      "BOOK-1043",
      "",
      "",
      "",
    ],
  ]);
}
