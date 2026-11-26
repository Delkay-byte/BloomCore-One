import { expect, test } from "@playwright/test";
import { loginAdmin } from "./helpers";

/**
 * Anomaly investigation acceptance.
 *
 * The screen must do more than list findings: a person has to be able to own one,
 * record what they checked, and close it with a decision — and closing it must not
 * pretend the underlying record changed.
 */
test.describe("Anomaly investigations", () => {
  test.beforeEach(async ({ page }) => {
    await loginAdmin(page);
  });

  test("explains that closing a finding changes no financial record", async ({ page }) => {
    await page.goto("/admin/anomalies");
    await expect(page.getByRole("heading", { name: "Anomaly monitoring" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText(/Closing a finding never changes a transaction, a count or a balance/)
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Alert budget:/)).toBeVisible();
  });

  test("shows the scan history and the suppress list as separate records", async ({ page }) => {
    await page.goto("/admin/anomalies");
    await expect(page.getByRole("heading", { name: "Anomaly investigations" })).toBeVisible({
      timeout: 30_000,
    });
    // The operations view is available even when nothing is open, because a quiet
    // rule and a failed scheduled scan both need to stay visible.
    await expect(page.getByText("Recent scans")).toBeVisible();
    await expect(page.getByText("Deliberately quiet rules")).toBeVisible();
    await expect(page.getByText(/Nothing is suppressed|quiet until|ended/).first()).toBeVisible();
  });
});
