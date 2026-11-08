import { expect, test } from "@playwright/test";
import { ADMIN_A, loginAdmin } from "./helpers";

test.describe("Daily-account correction screen", () => {
  test("shows original values, requires reason and confirmation, and keeps history", async ({
    page,
  }) => {
    await loginAdmin(page, ADMIN_A);
    await page.goto("/admin/history/e2e-daily-a/correct");
    await expect(page.getByRole("heading", { name: "Correct daily account" })).toBeVisible();
    await expect(page.getByText("Original:", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Revision history (0)")).toBeVisible();

    const debts = page.getByLabel("Debts Collected");
    await debts.fill("250");
    await page
      .getByRole("textbox", { name: /Correction reason/ })
      .fill("Debts collected figure omitted from the original submission");
    await page.getByRole("button", { name: "Save correction" }).click();
    // Confirmation is mandatory.
    await expect(
      page.getByText("Confirm that you have reviewed the original and proposed values.")
    ).toBeVisible();

    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Save correction" }).click();
    await expect(
      page.getByText("Correction saved. The previous values are preserved in revision history.")
    ).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect(page.getByText("Revision history (1)")).toBeVisible();
    await expect(page.getByText("Debts collected figure omitted", { exact: false }).first()).toBeVisible();
  });

  test("denies a tenant administrator from another business", async ({ page }) => {
    await loginAdmin(page, "e2e-admin-b@test.local");
    await page.goto("/admin/history/e2e-daily-a/correct");
    await expect(page.getByRole("heading", { name: "Correct daily account" })).toHaveCount(0);
  });
});
