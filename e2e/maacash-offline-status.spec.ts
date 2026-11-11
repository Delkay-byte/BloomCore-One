import { expect, test } from "@playwright/test";
import { loginCollector, waitForHydration } from "./helpers";

/**
 * Offline status regression coverage.
 *
 * These tests prove the displayed state follows the real connection state. They
 * do not create financial records and do not require an offline passphrase.
 */

async function openCollectorDashboard(page: import("@playwright/test").Page) {
  await loginCollector(page);
  await expect(page.getByRole("button", { name: /Register New Customer/i })).toBeVisible({
    timeout: 30_000,
  });
  await waitForHydration(page, '[aria-label="Workspace status"]');
}

test.describe("offline status transitions", () => {
  test("does not show Offline Active or a stale offline banner while online", async ({
    page,
  }) => {
    await openCollectorDashboard(page);

    const status = page.locator('[aria-label="Workspace status"]');
    await expect(status.getByText("Online", { exact: true })).toBeVisible();
    await expect(status.getByText("Offline Active", { exact: true })).toHaveCount(0);

    // Simulate network loss. The browser must report offline, not a prepared
    // workspace claiming to be online.
    await page.context().setOffline(true);
    await expect(status.getByText("Offline", { exact: true })).toBeVisible();

    // Returning connectivity must replace the offline state without a reload.
    await page.context().setOffline(false);
    await expect(status.getByText("Online", { exact: true })).toBeVisible();
    await expect(page.getByText(/You are working offline/i)).toHaveCount(0);
    await expect(status.getByText("Offline Active", { exact: true })).toHaveCount(0);
  });

  test("does not show a false attention warning with an empty queue", async ({ page }) => {
    await openCollectorDashboard(page);

    await expect(page.getByText(/collections? need attention/i)).toHaveCount(0);
    await expect(page.getByText(/need attention/i)).toHaveCount(0);

    const offlinePanel = page.getByRole("region", { name: "Offline records" });
    await expect(offlinePanel).toBeVisible();
    await expect(offlinePanel.getByText(/Saved on this device · scoped to your account/i)).toBeVisible();
  });

  test("customer registration modal uses a translucent backdrop and keeps labels", async ({
    page,
  }) => {
    await openCollectorDashboard(page);
    await page.getByRole("button", { name: /Register New Customer/i }).click();

    const dialog = page.getByRole("dialog", { name: "Register New Customer" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/Full Name/i)).toBeVisible();
    await expect(dialog.getByLabel(/Phone/i)).toBeVisible();
    await expect(dialog.getByLabel(/Daily Contribution/i)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();

    const backdrop = page.locator("div.fixed.inset-0").filter({ has: dialog });
    await expect(backdrop).toHaveClass(/bg-slate-950\/60/);
  });
});
