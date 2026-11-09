import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loginAdmin, loginWorker, waitForHydration } from "./helpers";

/**
 * Visual and behavioural evidence for the MaaCash improvements.
 * Screenshots are generated evidence only; the suite also asserts meaning.
 */

const DIR = join("test-results", "maacash-improvements");
mkdirSync(DIR, { recursive: true });

async function shot(page: Page, name: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(DIR, `${name}-${width}.png`), fullPage: true });
}

async function noOverflow(page: Page) {
  const size = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(size.scroll).toBeLessThanOrEqual(size.client + 2);
}

test.describe("simplified MoMo closing and customer Account Number", () => {
  test("agent form shows only approved fields at every width", async ({ page }) => {
    await loginWorker(page);
    await page.goto("/worker/daily/e2e-daily-draft");
    await waitForHydration(page, "#opening-cash");

    await expect(page.getByText("START OF DAY")).toBeVisible();
    await expect(page.getByText("END OF DAY")).toBeVisible();
    await expect(page.getByText("Debts Collected", { exact: true })).toBeVisible();
    await expect(page.getByText("Total Expenses", { exact: true })).toBeVisible();
    await expect(page.locator("#customer-deposit")).toHaveCount(0);
    await expect(page.locator("#additional-cash")).toHaveCount(0);

    await page.locator("#opening-cash").fill("100");
    await page.locator("#opening-float").fill("500");
    await page.locator("#closing-cash").fill("550");
    await page.locator("#closing-float").fill("50");
    await page.locator("#commission").fill("5");
    await page.locator("#debts-collected").fill("20");
    // Start from a clean expense list; this draft may carry saved rows.
    const removeExpense = page.getByRole("button", { name: /Remove expense/ });
    while ((await removeExpense.count()) > 0) {
      await removeExpense.first().click();
    }
    await page.getByRole("button", { name: "+ Add Expense" }).click();
    await page.locator("#expense-desc-0").fill("Transport");
    await page.locator("#expense-amount-0").fill("25");
    await expect(page.getByText("BALANCED", { exact: true }).first()).toBeVisible();

    for (const width of [360, 390, 768, 1280]) {
      await shot(page, "momo-daily-editable", width);
      await noOverflow(page);
    }
  });

  test("customer sign-in names only phone or Account Number", async ({ page }) => {
    await page.goto("/login?role=customer");
    await waitForHydration(page, "#identifier");
    await expect(page.getByText("Phone Number or Account Number")).toBeVisible();
    await expect(page.getByText(/Customer ID/)).toHaveCount(0);
    for (const width of [360, 390, 768, 1280]) {
      await shot(page, "customer-login", width);
      await noOverflow(page);
    }
  });

  test("customer creation shows one prominent Account Number", async ({ page }) => {
    await loginAdmin(page);
    await page.goto("/susu/admin/customers");
    await waitForHydration(page, "h1");
    await page.getByRole("button", { name: /New Customer/ }).click();
    const stamp = Date.now().toString().slice(-6);
    await page.locator('[name="fullName"]').fill(`Evidence Customer ${stamp}`);
    await page.locator('[name="phone"]').fill(`+23324${stamp}0`);
    await page.locator('[name="dailyContribution"]').fill("25");
    await page.getByRole("button", { name: "Create Customer" }).click();

    await expect(
      page.getByRole("heading", { name: "Customer Account Created Successfully" })
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Account Number", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Print Account Summary/ })).toBeVisible();
    await expect(page.getByText(/Customer ID/)).toHaveCount(0);

    for (const width of [390, 1280]) {
      await shot(page, "customer-created", width);
      await noOverflow(page);
    }
  });

  test("staff directory exposes one-identity dual-role controls", async ({ page }) => {
    await loginAdmin(page);
    await page.goto("/admin/staff");
    await waitForHydration(page, "h1");
    await expect(page.getByRole("columnheader", { name: "Modules" })).toBeVisible();
    await shot(page, "staff-dual-role", 1280);
  });

  test("Zeli conversation delete uses an in-app modal", async ({ page }) => {
    await loginAdmin(page);
    await page.goto("/zeli");
    await page.getByRole("button", { name: "New" }).click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /^Delete / }).first().click();
    const dialog = page.getByRole("dialog", { name: "Delete this conversation?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Delete conversation" })).toBeVisible();
    await shot(page, "zeli-delete-modal", 390);
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });
});
