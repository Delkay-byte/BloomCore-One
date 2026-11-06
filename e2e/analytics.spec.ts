import { expect, test } from "@playwright/test";
import { ADMIN_A, loginAdmin, pageFetch, resetSession } from "./helpers";

test.describe("Zeli Business Intelligence workspace", () => {
  test.beforeEach(async ({ page }) => {
    await loginAdmin(page, ADMIN_A);
  });

  test("renders server-computed KPIs, charts and a rule-based explanation", async ({ page }) => {
    await page.goto("/admin/zeli-analytics");
    await expect(page.getByTestId("zeli-analytics-dashboard")).toBeVisible();
    await expect(page.getByRole("heading", { name: "E2E Bloom Business A" })).toBeVisible();
    await expect(page.getByText("Current aggregate")).toBeVisible();

    // Contributions are 350 + 150; reversed 9999 is excluded.
    await expect(page.getByText("GH₵500.00").first()).toBeVisible();
    await expect(page.getByText("GH₵9,999.00")).toHaveCount(0);
    await expect(page.getByText("Detected patterns")).toBeVisible();
    await expect(page.getByText("Remittance variance needs review", { exact: false }).first()).toBeVisible();

    // At least four charts render.
    expect(await page.locator(".recharts-responsive-container").count()).toBeGreaterThanOrEqual(4);

    await page.getByRole("button", { name: /Explain Contributions and withdrawals/ }).click();
    await expect(page.getByTestId("zeli-explanation")).toBeVisible();
    await expect(page.getByTestId("zeli-explanation").getByText("CALCULATED FACT").first()).toBeVisible();
    await expect(page.getByTestId("zeli-explanation").getByText("UNVERIFIED HYPOTHESIS").first()).toBeVisible();
  });

  test("filters the reporting period and branch, and exports aggregates", async ({ page }) => {
    await page.goto("/admin/zeli-analytics");
    await page.getByRole("button", { name: "Previous month" }).click();
    await expect(page).toHaveURL(/period=previous_month/);
    await expect(page.getByText("GH₵275.00").first()).toBeVisible();

    await page.getByRole("button", { name: "This month" }).click();
    await page.getByRole("combobox", { name: "Branch" }).selectOption("e2e-location-a");
    await expect(page).toHaveURL(/location=e2e-location-a/);
    await expect(page.getByText("E2E Accra Branch", { exact: false }).first()).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("zeli-export").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^zeli-analytics-.*\.csv$/);
  });

  test("refreshes aggregates on demand", async ({ page }) => {
    await page.goto("/admin/zeli-analytics");
    await page.getByTestId("zeli-refresh").click();
    await expect(page.getByText("Last successful refresh:", { exact: false })).toBeVisible();
    await expect(page.getByText("Stale data")).toHaveCount(0);
  });

  test("does not leak tenant B in exports or analytics", async ({ page }) => {
    await page.goto("/admin/zeli-analytics");
    await expect(page.getByText("E2E Bloom Business B")).toHaveCount(0);
    const response = await pageFetch(page, "/api/zeli/analytics/export?period=this_month");
    expect(response.status).toBe(200);
    expect(response.body).toContain("E2E Bloom Business A");
    const body = response.body;
    expect(body).not.toContain("E2E Bloom Business B");
    expect(body).not.toContain("E2E Customer A");
  });

  test("denies a tenant without entitlement and hides the navigation item", async ({ page }) => {
    await resetSession(page);
    await loginAdmin(page, "e2e-admin-b@test.local");
    await page.goto("/admin/dashboard");
    await expect(page.getByRole("link", { name: "Zeli Business Intelligence" })).toHaveCount(0);
    const response = await pageFetch(page, "/api/zeli/analytics/export");
    expect(response.status).toBe(403);
  });
});
