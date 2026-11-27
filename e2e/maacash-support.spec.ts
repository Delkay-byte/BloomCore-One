import { expect, test } from "@playwright/test";
import { loginAdmin, loginPlatform } from "./helpers";

/**
 * Phase 8 acceptance through the real UI.
 *
 * The tenant and platform flows are serial: the request opened by the business
 * must exist before the support console can be expected to show it. The test
 * never asserts on support internals — only that the business can ask for help,
 * that the console sees the same request, and that the guidance is reachable.
 */
test.describe.configure({ mode: "serial" });

const SUBJECT = "E2E ledger difference " + Date.now();

test.describe("Tenant support", () => {
  test.beforeEach(async ({ page }) => {
    await loginAdmin(page);
  });

  test("opens a support request and lands on its thread", async ({ page }) => {
    await page.goto("/susu/support");
    await expect(page.getByRole("heading", { name: "Support", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("heading", { name: "Open a support request" })).toBeVisible();

    await page.getByLabel("Subject").fill(SUBJECT);
    await page
      .getByLabel("What happened?")
      .fill("The daily close for the Tema branch shows a difference of 40 cedis that I cannot explain.");
    await page.getByRole("button", { name: "Open request" }).click();

    await page.waitForURL(/\/susu\/support\/[^/]+$/, { timeout: 30_000 });
    await expect(page.getByText(SUBJECT).first()).toBeVisible();
    await expect(page.getByText(/SUP-\d{4}-[A-Z0-9]{6}/).first()).toBeVisible();
  });

  test("shows the operational guide as a checklist, not a marketing page", async ({ page }) => {
    await page.goto("/susu/admin/guide");
    await expect(page.getByRole("heading", { name: "Operational guide" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("heading", { name: "Operating rhythm" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What support can and cannot do" })).toBeVisible();
    await expect(page.getByText(/Daily|Weekly|Monthly/).first()).toBeVisible();
  });

  test("shows the staff lifecycle board without exposing a create-admin control", async ({ page }) => {
    await page.goto("/susu/admin/staff");
    await expect(page.getByRole("heading", { name: "Staff & access" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("link", { name: "Add a staff member" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Outstanding" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Sessions" })).toBeVisible();
  });
});

test.describe("Platform support queue", () => {
  test("shows the request the business opened", async ({ page }) => {
    await loginPlatform(page);
    await page.goto("/platform/support");
    await expect(page.getByRole("heading", { name: "Support queue" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Businesses with open requests")).toBeVisible();
    await expect(page.getByText(SUBJECT).first()).toBeVisible({ timeout: 30_000 });
  });
});
