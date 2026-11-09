import { expect, test } from "@playwright/test";
import {
  COLLECTOR,
  DUAL_ROLE,
  WORKER,
  loginCollector,
  loginWorker,
} from "./helpers";

/**
 * A person with both capabilities uses one authenticated identity and switches
 * dashboards in place. No password, authenticator code or role-selection screen.
 */
test.describe("dual-role dashboard switching", () => {
  test("switches MoMo -> Susu -> MoMo without signing in again", async ({ page }) => {
    await loginWorker(page, DUAL_ROLE);

    await expect(page.getByText("Current dashboard")).toBeVisible();
    await expect(page.getByText("MoMo Agent Dashboard", { exact: true })).toBeVisible();

    // Cancel leaves the current dashboard untouched.
    await page.getByRole("button", { name: "Switch to Susu Collector" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByText("Switch to Susu Collector?")).toBeVisible();
    await page.getByRole("button", { name: "Stay Here" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/worker\/dashboard/);

    // Confirm opens the Susu workspace directly.
    await page.getByRole("button", { name: "Switch to Susu Collector" }).click();
    await page.getByRole("button", { name: "Yes, Switch" }).click();
    await page.waitForURL(/\/collector\/dashboard/, { timeout: 30_000 });
    await expect(page.getByText("Susu Collector Dashboard", { exact: true })).toBeVisible();
    await expect(page.locator("#identifier")).toHaveCount(0);
    await expect(page.locator("#password")).toHaveCount(0);

    // Switch back on the same session.
    await page.getByRole("button", { name: "Switch to MoMo Agent" }).click();
    await expect(page.getByText("Switch to MoMo Agent?")).toBeVisible();
    await page.getByRole("button", { name: "Yes, Switch" }).click();
    await page.waitForURL(/\/worker\/dashboard/, { timeout: 30_000 });
    await expect(page.getByText("MoMo Agent Dashboard", { exact: true })).toBeVisible();
    await expect(page.locator("#identifier")).toHaveCount(0);
  });

  test("a MoMo-only agent sees no Susu switch", async ({ page }) => {
    await loginWorker(page, WORKER);
    await expect(page.getByText("Current dashboard")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Switch to Susu Collector" })
    ).toHaveCount(0);
  });

  test("a Susu-only collector sees no MoMo switch", async ({ page }) => {
    await loginCollector(page, COLLECTOR);
    await expect(page.getByText("Current dashboard")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Switch to MoMo Agent" })
    ).toHaveCount(0);
  });
});
