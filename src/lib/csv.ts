/**
 * CSV generation for every download in MaaCash.
 *
 * Free-text fields can contain commas, quotes, newlines and spreadsheet
 * formula prefixes. A single escaping rule keeps exports readable and prevents
 * CSV formula injection.
 */

const FORMULA_PREFIX = /^[=@\t\r]/;
const SIGNED_FORMULA_PREFIX = /^[+-]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

function isPlainNumber(value: string): boolean {
  return PLAIN_NUMBER.test(value);
}

/**
 * Format one CSV cell.
 *
 * A leading `=`, `@`, tab or carriage return is always prefixed with an
 * apostrophe. A leading `+` or `-` is prefixed unless the whole value is a
 * plain number, so negative money remains numeric.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  const dangerous =
    FORMULA_PREFIX.test(text) ||
    (SIGNED_FORMULA_PREFIX.test(text) && !isPlainNumber(text));
  if (dangerous) text = `'${text}`;
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function buildCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** Blob helper used by browser downloads. */
export function csvBlob(rows: unknown[][]): Blob {
  return new Blob([buildCsv(rows)], { type: "text/csv;charset=utf-8" });
}
