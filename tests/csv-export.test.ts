import { describe, expect, it } from "vitest";
import { buildCsv, csvCell } from "@/lib/csv";

describe("CSV export safety", () => {
  it("keeps plain numbers numeric, including negative money", () => {
    expect(csvCell(-350.5)).toBe("-350.5");
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell(-12)).toBe("-12");
  });

  it("neutralises spreadsheet formula prefixes", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe(
      "\"'=HYPERLINK(\"\"http://x\"\")\""
    );
    expect(csvCell("@SUM(A1:A2)")).toBe("'@SUM(A1:A2)");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("\t=cmd")).toBe("'\t=cmd");
  });

  it("quotes commas, quotes, carriage returns and newlines", () => {
    expect(csvCell("Ama, Mensah")).toBe('"Ama, Mensah"');
    expect(csvCell('He said "paid"')).toBe('"He said ""paid"""');
    expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("builds CRLF rows and applies escaping to every cell", () => {
    const csv = buildCsv([
      ["Date", "Notes", "Amount"],
      ["2026-12-05", "=cmd", -100],
    ]);
    expect(csv).toBe("Date,Notes,Amount\r\n2026-12-05,'=cmd,-100");
    expect(csv.split("\r\n")).toHaveLength(2);
  });
});
