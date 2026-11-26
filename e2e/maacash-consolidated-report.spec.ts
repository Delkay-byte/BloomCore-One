import { expect, test } from "@playwright/test";
import { loginAdmin } from "./helpers";

/**
 * Consolidated MoMo report acceptance.
 *
 * The audit's objection was that figures were labelled as income or profit when they
 * were volume or an operational movement, and that a missing close looked like a
 * quiet day. The screen has to be honest about both.
 */
test.describe("Consolidated MoMo report", () => {
  test.beforeEach(async ({ page }) => {
    await loginAdmin(page);
  });

  test("separates position, flow and missing closes", async ({ page }) => {
    await page.goto("/admin/reports/consolidated");
    await expect(
      page.getByRole("heading", { name: "Consolidated MoMo report" })
    ).toBeVisible({ timeout: 30_000 });

    await expect(page.getByRole("heading", { name: "Branch position" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Flow and result" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What is missing" })).toBeVisible();

    // Volume must never be presented as income, and the result must never be profit.
    await expect(page.getByText("Principal in").first()).toBeVisible();
    await expect(page.getByText("Money moved (not income)").first()).toBeVisible();
    await expect(page.getByText(/Net operating result/).first()).toBeVisible();
    await expect(page.getByText(/not profit/).first()).toBeVisible();

    await expect(page.getByText(/expected branch days have a/)).toBeVisible();
    await expect(page.getByText(/Export CSV/)).toBeVisible();
  });

  test("shows a per-figure dictionary with formulas", async ({ page }) => {
    await page.goto("/admin/reports/consolidated");
    await expect(page.getByText(/Metric dictionary/)).toBeVisible({ timeout: 30_000 });
    await page.getByText(/Metric dictionary/).click();
    await expect(page.getByText(/Excludes: Principal, float and any customer money/)).toBeVisible();
  });
});
