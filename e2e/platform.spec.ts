import { expect, test } from "@playwright/test";
import { loginPlatform } from "./helpers";

test.describe("Platform Zeli control centre", () => {
  test.beforeEach(async ({ page }) => {
    await loginPlatform(page);
  });

  test("shows provider hard-off status and aggregated adoption", async ({ page }) => {
    await page.goto("/platform/zeli");
    await expect(page.getByTestId("platform-zeli")).toBeVisible();
    await expect(
      page.getByText("External AI processing is currently disabled.", { exact: false })
    ).toBeVisible();
    await expect(page.getByText("DeepSeek", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Disabled by code policy")).toBeVisible();
    await expect(page.getByText("Never granted", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: /Enable DeepSeek/i })).toHaveCount(0);
  });

  test("grants, audits and revokes an entitlement with a mandatory reason", async ({ page }) => {
    await page.goto("/platform/zeli");
    const row = page.getByRole("row", { name: /E2E Bloom Business B/ });
    await row.getByRole("button", { name: /Manage/ }).click();
    await expect(page.getByTestId("zeli-entitlement-panel")).toBeVisible();
    await expect(page.getByText("No Zeli Analytics entitlement exists.")).toBeVisible();

    await page.locator("textarea").first().fill("Approved paid pilot pending owner sign-off");
    await page.getByRole("button", { name: "Grant entitlement" }).click();
    await expect(page.getByText("Entitlement granted recorded.")).toBeVisible();
    await expect(page.getByText("granted", { exact: true }).first()).toBeVisible();

    const history = page.getByTestId("zeli-entitlement-panel");
    await expect(history.getByText("approved paid pilot", { exact: false })).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("textarea").first().fill("Pilot ended and access must close immediately");
    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Entitlement revoke recorded.")).toBeVisible();
    await expect(history.getByText("revoked", { exact: true }).first()).toBeVisible();
  });

  test("does not expose tenant financial records on the platform page", async ({ page }) => {
    await page.goto("/platform/zeli");
    await expect(page.getByText("GH₵500.00")).toHaveCount(0);
    await expect(page.getByText("E2E Customer A")).toHaveCount(0);
    await expect(page.getByText("E2E-S-001")).toHaveCount(0);
  });
});
