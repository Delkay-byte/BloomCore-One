/**
 * Reporting terminology regression.
 *
 * The daily accountability increase is commission + debt recovery + other
 * income - expenses. It is not accounting profit, revenue or customer volume.
 * These screens must not drift back to calling it profit.
 */

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

describe("financial reporting language", () => {
  const screens = [
    "src/app/admin/(workspace)/dashboard/page.tsx",
    "src/app/admin/(workspace)/reports/page.tsx",
    "src/app/admin/(workspace)/reports/[id]/page.tsx",
    "src/app/admin/(workspace)/history/[id]/correct/CorrectionForm.tsx",
    "src/app/worker/daily/[id]/page.tsx",
  ];

  it("does not label the accountability increase as profit", () => {
    for (const file of screens) {
      const content = source(file);
      expect(content, file).not.toMatch(/Net daily profit/i);
      expect(content, file).not.toMatch(/Profit retained/i);
      expect(content, file).not.toMatch(/Profit withdrawn/i);
    }
  });

  it("uses explicit accountability and revenue definitions", () => {
    expect(source("src/app/admin/(workspace)/reports/page.tsx")).toContain(
      "Net Accountability Increase"
    );
    expect(source("src/app/worker/daily/[id]/page.tsx")).toContain(
      "Net accountability increase"
    );
    expect(source("src/app/admin/(workspace)/reports/[id]/page.tsx")).toContain(
      "not accounting profit or revenue"
    );
    expect(source("src/app/admin/(workspace)/dashboard/page.tsx")).toContain(
      "Not revenue or accounting profit"
    );
  });

  it("labels performance income as operating revenue and discloses its basis", () => {
    const page = source("src/app/admin/(workspace)/performance/page.tsx");
    expect(page).toContain('label="Operating revenue"');
    expect(page).toContain("source.definitions.revenue");
    expect(page).toContain("source.definitions.cashMovement");
    expect(page).toContain("How each metric is defined");
  });
});
