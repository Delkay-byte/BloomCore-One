import { expect, test } from "@playwright/test";
import {
  loginAdmin,
  loginCollector,
  loginCustomer,
  waitForHydration,
  PASSWORD,
} from "./helpers";

/**
 * Role workflows: Susu collector, customer portal and tenant administrator.
 * Every fixture lives in the isolated E2E database.
 */

test.describe("Susu collector workflow", () => {
  test("searches an assigned customer and records a collection", async ({
    page,
  }) => {
    await loginCollector(page);
    await expect(
      page.getByRole("heading", { name: /E2E Collector/ })
    ).toBeVisible();
    await expect(page.getByText("Today's Collections")).toBeVisible({
      timeout: 30_000,
    });

    const search = page.getByPlaceholder("Search customers...");
    await search.fill("E2E Customer B");
    await expect(page.getByText("E2E Customer B")).toBeVisible();
    await page.getByRole("button", { name: "Collect", exact: true }).first().click();

    const dialog = page.getByRole("dialog", { name: "Record Collection" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("E2E Customer B")).toBeVisible();
    // Prefilled with the expected amount; the collector can adjust it.
    await dialog.locator("#collect-amount").fill("20");
    await dialog.getByRole("button", { name: "Record Contribution" }).click();

    await expect(page.getByRole("status").filter({ hasText: "E2E Customer B" })).toContainText(
      "1 day(s) covered"
    );
    await expect(page.getByRole("dialog", { name: "Record Collection" })).toBeHidden();
    await expect(
      page.getByText("Collected Today").first()
    ).toBeVisible();
    await expect(page.getByText(/E2E Customer B/).first()).toBeVisible();
  });
});

test.describe("customer portal workflow", () => {
  test("loads savings, payments, statement, withdrawals, profile and settings", async ({
    page,
  }) => {
    await loginCustomer(page);
    await expect(
      page.getByRole("heading", { name: /E2E Customer A/ })
    ).toBeVisible();
    await expect(page.getByText("Current 31-Day Cycle")).toBeVisible({
      timeout: 30_000,
    });

    const menu = page.getByRole("button", { name: "Open menu" });

    await menu.click();
    await page.getByRole("menuitem", { name: "My Payments" }).click();
    await expect(page.getByRole("heading", { name: "My Payments" })).toBeVisible();

    await menu.click();
    await page.getByRole("menuitem", { name: "My Statement" }).click();
    await expect(
      page.getByRole("heading", { name: "My Account Statement" })
    ).toBeVisible();
    await expect(page.getByText("Payment").first()).toBeVisible();

    await menu.click();
    await page.getByRole("menuitem", { name: "My Withdrawals" }).click();
    await expect(
      page.getByRole("heading", { name: "My Withdrawals" })
    ).toBeVisible();

    await menu.click();
    await page.getByRole("menuitem", { name: "My Profile" }).click();
    await expect(page.getByRole("heading", { name: "My Profile" })).toBeVisible();
    await expect(page.getByText("E2E-C-001").first()).toBeVisible();

    await menu.click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByText("E2E Customer A").first()).toBeVisible();
  });

  test("signs out through the in-app confirmation dialog only", async ({
    page,
  }) => {
    await loginCustomer(page);
    const menu = page.getByRole("button", { name: "Open menu" });

    await menu.click();
    await page.getByRole("menuitem", { name: "Sign Out" }).click();
    const dialog = page.getByRole("dialog", { name: "Sign out of MaaCash?" });
    await expect(dialog).toBeVisible();

    // Escape keeps the customer signed in.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/customer\/dashboard/);

    await menu.click();
    await page.getByRole("menuitem", { name: "Sign Out" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login\?role=customer/, { timeout: 30_000 });
  });
});

test.describe("tenant administrator workflow", () => {
  test("renders both entitled modules on the dashboard", async ({ page }) => {
    await loginAdmin(page);
    await expect(page.getByRole("heading", { name: /E2E Admin A/ })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "MoMo module" })
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("region", { name: "Susu module" })
    ).toBeVisible();
  });

  test("withdraws only after the administrator's own password is verified", async ({
    page,
  }) => {
    await loginAdmin(page);
    await page.goto("/susu/admin/withdrawals");
    await waitForHydration(page, "text=E2E Customer A");

    await page.getByRole("button", { name: /Process Withdrawal/ }).click();
    const search = page.getByPlaceholder("Search by name, ID, or phone...");
    await search.fill("E2E Customer A");
    await page
      .getByRole("button", { name: /E2E Customer A/ })
      .first()
      .click();
    await page.locator('input[placeholder="Amount to withdraw"]').fill("20");
    await page
      .getByRole("button", { name: "Process Withdrawal", exact: true })
      .click();

    const dialog = page.getByRole("dialog", { name: "Confirm your identity" });
    await expect(dialog).toBeVisible();

    // Another password is rejected...
    await dialog.locator("#reauth-password").fill("NotTheAdminPassword1!");
    await dialog.getByRole("button", { name: "Confirm Withdrawal" }).click();
    await expect(dialog.getByText("Incorrect password")).toBeVisible();

    // ...and the administrator's own password completes the withdrawal.
    await dialog.locator("#reauth-password").fill(PASSWORD);
    await dialog.getByRole("button", { name: "Confirm Withdrawal" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Withdrawal processed" })
    ).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toBeHidden();
  });

  test("shows remittance discrepancies and MoMo reports", async ({ page }) => {
    await loginAdmin(page);
    await page.goto("/susu/admin/remittances");
    await expect(
      page.getByRole("heading", { name: "Collector Money Handed In" })
    ).toBeVisible();
    await expect(page.getByText("E2E Collector").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Short").first()).toBeVisible();

    await page.goto("/admin/reports");
    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
    await expect(
      page.getByRole("table").getByText("E2E Accra Branch").first()
    ).toBeVisible({ timeout: 30_000 });
  });
});
