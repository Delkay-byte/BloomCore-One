import { expect, test } from "@playwright/test";
import { loginAdmin } from "./helpers";

/**
 * Operations policy acceptance: the switches a business administrator can set,
 * and the honest statement of what each one enforces.
 *
 * Enforcement itself is covered by tests/employee-accountability.test.ts against
 * the real server actions; this suite proves the setting is reachable, saved and
 * still in force after a reload.
 */
test.describe("Operations policy", () => {
  test.beforeEach(async ({ page }) => {
    await loginAdmin(page);
  });

  test("saves the shift and shared-device rules and keeps them after a reload", async ({
    page,
  }) => {
    await page.goto("/admin/policy");
    await expect(page.getByRole("heading", { name: "Operations Policy" })).toBeVisible();
    await expect(page.getByText("This business is running on the product defaults.")).toBeVisible({
      timeout: 30_000,
    });

    // The default statements must not claim a control that is not enforced.
    await expect(page.getByText(/Shifts are optional/)).toBeVisible();
    await expect(page.getByText(/rely on the signed-in session only/)).toBeVisible();

    const shiftSwitch = page.getByLabel("Require a shift before a day can close");
    const proofSwitch = page.getByLabel(
      "Require the actor's own password for sensitive counts"
    );
    await shiftSwitch.check();
    await proofSwitch.check();
    await expect(page.getByText("Unsaved changes")).toBeVisible();

    await page
      .getByPlaceholder(/three branches share one till/i)
      .fill("E2E policy: two branches share one tablet at the counter.");
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(
      page.getByText(/Policy saved. The change is audited with the previous values./).first()
    ).toBeVisible({ timeout: 30_000 });

    // The summary text follows the saved values rather than staying on defaults.
    await expect(page.getByText(/Shifts are required/)).toBeVisible();
    await expect(page.getByText(/the actor enters their own password again/i)).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Require a shift before a day can close")).toBeChecked({
      timeout: 30_000,
    });
    await expect(
      page.getByLabel("Require the actor's own password for sensitive counts")
    ).toBeChecked();
    await expect(page.getByText(/Last saved/)).toBeVisible();
  });
});
