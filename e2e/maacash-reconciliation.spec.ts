import { expect, test, type Page } from "@playwright/test";
import { loginAdmin } from "./helpers";

/**
 * Reconciliation acceptance: the provider statement importer, the liquidity
 * board and the exception queue, exercised through the browser against the
 * seeded branch and its two recorded MTN movements.
 *
 * The seeded statement day is the third of last month at 09:10 and 09:25 UTC, so
 * the CSV is generated with the same calendar day rather than a fixed date.
 */

function statementDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 3));
}

function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function csv(lines: string[]): string {
  return [
    "Transaction ID,Date,Direction,Amount,Fee,Balance,Description",
    ...lines,
  ].join("\n");
}

async function importStatement(page: Page, fileName: string, body: string) {
  await page.goto("/admin/reconciliation");
  await expect(page.getByRole("heading", { name: "Provider Statement Reconciliation" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "text/csv",
    buffer: Buffer.from(body, "utf8"),
  });
  await page.getByRole("button", { name: "Import statement" }).click();
}

test.describe("Provider statement reconciliation", () => {
  test.beforeEach(async ({ page }) => {
    await loginAdmin(page);
  });

  test("imports a statement, matches one line automatically and reports the unmatched one", async ({
    page,
  }) => {
    const day = dayStamp(statementDay());
    await importStatement(
      page,
      "mtn-statement-match.csv",
      csv([
        `MP240103.0910.A10001,${day} 09:10,Credit,250.00,0.00,1250.00,Cash in at E2E Accra Branch`,
        `MP240103.0940.A10009,${day} 09:40,Credit,90.00,0.00,1340.00,Cash in not in the ledger`,
      ])
    );

    // The summary is honest about what happened: one auto match, one line with
    // no counterpart, and nothing posted to the ledger.
    await expect(page.getByText(/Nothing was posted to the ledger/).first()).toBeVisible({
      timeout: 30_000,
    });

    const detail = page.locator("table").first();
    await expect(detail.getByText("MP240103.0910.A10001")).toBeVisible();
    await expect(detail.getByText("MP240103.0940.A10009")).toBeVisible();
    await expect(detail.getByText("matched", { exact: true })).toBeVisible();
    await expect(detail.getByText("unmatched", { exact: true })).toBeVisible();

    // Re-importing identical bytes is refused rather than silently duplicated.
    await importStatement(
      page,
      "mtn-statement-match.csv",
      csv([
        `MP240103.0910.A10001,${day} 09:10,Credit,250.00,0.00,1250.00,Cash in at E2E Accra Branch`,
        `MP240103.0940.A10009,${day} 09:40,Credit,90.00,0.00,1340.00,Cash in not in the ledger`,
      ])
    );
    await expect(
      page.getByText(/This exact statement file has already been imported/).first()
    ).toBeVisible({ timeout: 30_000 });
  });

  test("manually matches an unmatched line and never claims provider confirmation", async ({
    page,
  }) => {
    const day = dayStamp(statementDay());
    await importStatement(
      page,
      "mtn-statement-manual.csv",
      csv([
        // One cedi more than the recorded cash-out, one minute away in time, with
        // a reference the provider never issued. Automatic matching refuses a
        // different amount, so only a human can pair it with the record.
        `UNKNOWN-REF-77,${day} 09:26,Debit,121.00,0.00,1220.00,Cash out at the branch`,
      ])
    );
    await expect(page.getByText(/Nothing was posted to the ledger/).first()).toBeVisible({
      timeout: 30_000,
    });

    const row = page.locator("table").first().locator("tbody tr").first();
    await expect(row.getByText("unmatched")).toBeVisible();
    await row.getByRole("button", { name: "Find record" }).click();

    const picker = row.getByLabel(/Internal record for line/);
    await expect(picker).toBeVisible();
    await expect(picker.locator("option")).toHaveCount(1);
    await row.getByRole("button", { name: "Match", exact: true }).click();

    await expect(
      page.getByText(/The internal record was not changed and is still unconfirmed/).first()
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("table").first().getByText("manual")).toBeVisible();

    // An automatic match cannot be undone from this screen.
    const matchedRow = page.locator("table").first().locator("tbody tr").first();
    await expect(matchedRow.getByRole("button", { name: "Remove match" })).toBeVisible();
    await matchedRow.getByRole("button", { name: "Remove match" }).click();
    await expect(page.getByText("Manual match removed.").first()).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("Branch liquidity", () => {
  test.beforeEach(async ({ page }) => {
    await loginAdmin(page);
  });

  test("requires an explanation before a short branch can be submitted", async ({ page }) => {
    const businessDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await page.goto("/admin/liquidity");
    await expect(page.getByRole("heading", { name: "Branch Liquidity" })).toBeVisible();
    await page.getByLabel("Business date").fill(businessDate);
    await expect(page.getByText("E2E Accra Branch")).toBeVisible({ timeout: 30_000 });

    await page.getByLabel("Cash opening declared").fill("500.00");
    await page.getByLabel("Cash counted close").fill("450.00");

    // A short line with no explanation is refused by the server, and the
    // operator is told exactly what is missing.
    await page.getByRole("button", { name: "Save snapshot" }).click();
    await expect(
      page.getByText(/needs an explanation of at least 10 characters/).first()
    ).toBeVisible({ timeout: 30_000 });

    await page
      .getByLabel("Cash explanation")
      .fill("Till count short; recounting the notes with the branch supervisor.");
    await page.getByRole("button", { name: "Save snapshot" }).click();
    await expect(page.getByText(/Snapshot saved for E2E Accra Branch/).first()).toBeVisible({
      timeout: 30_000,
    });

    // Submitting locks the figures for review; review records the decision.
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByText(/Snapshot submitted for review/).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(
      page.getByText(/A reconciliation case was opened for the shortfall/).first()
    ).toBeVisible({
      timeout: 30_000,
    });

    // The opened case is a real case in the queue, with the snapshot linked.
    await page.goto("/admin/reconciliation/exceptions");
    await expect(page.getByRole("heading", { name: "Reconciliation Cases" })).toBeVisible();
    const caseButton = page
      .locator("section")
      .first()
      .getByRole("button", { name: /Liquidity shortfall/ });
    await expect(caseButton).toBeVisible({ timeout: 30_000 });
    await caseButton.click();
    await expect(page.getByText("branchLiquiditySnapshot")).toBeVisible();
    await expect(
      page.getByText(/It never edits, reverses or deletes a financial record/)
    ).toBeVisible();
  });
});
