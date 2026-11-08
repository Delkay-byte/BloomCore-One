import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  loginAdmin,
  loginCollector,
  loginCustomer,
  loginWorker,
  waitForHydration,
} from "./helpers";

/**
 * Responsive evidence sweep.
 *
 * Captures the primary surfaces at 360, 390, 768 and 1280 CSS pixels into
 * `test-results/responsive/` (generated evidence, not committed). The narrow
 * widths also assert that the document itself does not scroll sideways; any
 * wide data table is expected to scroll inside its own container.
 */

const WIDTHS = [360, 390, 768, 1280] as const;
const EVIDENCE_DIR = join("test-results", "responsive");

mkdirSync(EVIDENCE_DIR, { recursive: true });

async function capture(page: Page, role: string, width: number, slug: string) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(250);
  await page.screenshot({
    path: join(EVIDENCE_DIR, `${role}-${width}-${slug}.png`),
    fullPage: true,
  });
}

async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

test.describe("responsive sweep", () => {
  test("login", async ({ page }) => {
    await page.goto("/login");
    await waitForHydration(page, "text=MoMo Agent");
    for (const width of WIDTHS) {
      await capture(page, "login", width, "roles");
      await expectNoPageOverflow(page);
    }
  });

  test("worker dashboard and daily account", async ({ page }) => {
    await loginWorker(page);
    await expect(
      page.getByRole("heading", { name: /E2E MoMo Agent/ })
    ).toBeVisible();

    for (const width of WIDTHS) {
      await capture(page, "worker", width, "dashboard");
      await expectNoPageOverflow(page);
    }

    await page.goto("/worker/daily/e2e-daily-a");
    await waitForHydration(page, "text=Physical cash at close");
    for (const width of WIDTHS) {
      await capture(page, "worker", width, "daily-readonly");
    }
  });

  test("collector dashboard", async ({ page }) => {
    await loginCollector(page);
    await expect(page.getByText("Today's Collections")).toBeVisible({
      timeout: 30_000,
    });
    for (const width of WIDTHS) {
      await capture(page, "collector", width, "dashboard");
      await expectNoPageOverflow(page);
    }
  });

  test("customer dashboard and statement", async ({ page }) => {
    await loginCustomer(page);
    await expect(
      page.getByRole("heading", { name: /E2E Customer A/ })
    ).toBeVisible();
    for (const width of WIDTHS) {
      await capture(page, "customer", width, "dashboard");
      await expectNoPageOverflow(page);
    }

    await page.goto("/customer/statement");
    await expect(
      page.getByRole("heading", { name: "My Account Statement" })
    ).toBeVisible();
    for (const width of WIDTHS) {
      await capture(page, "customer", width, "statement");
    }
  });

  test("administration", async ({ page }) => {
    await loginAdmin(page);
    await expect(
      page.getByRole("region", { name: "MoMo module" })
    ).toBeVisible({ timeout: 30_000 });
    for (const width of WIDTHS) {
      await capture(page, "admin", width, "dashboard");
    }

    await page.goto("/susu/admin/withdrawals");
    await waitForHydration(page, "text=E2E Customer A");
    for (const width of WIDTHS) {
      await capture(page, "admin", width, "withdrawals");
    }

    await page.goto("/admin/reports");
    await waitForHydration(page, "h1");
    for (const width of WIDTHS) {
      await capture(page, "admin", width, "reports");
    }
  });
});
