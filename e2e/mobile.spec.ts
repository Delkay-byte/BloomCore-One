import { expect, test } from "@playwright/test";
import {
  ADMIN_A,
  DUAL_ROLE,
  loginAdmin,
  loginWorker,
  sendZeliMessage,
} from "./helpers";

test.describe("Zeli on a mobile viewport", () => {
  test("keeps the conversation selector, input and analytics usable", async ({ page }) => {
    await loginAdmin(page, ADMIN_A);
    await page.goto("/zeli");
    await expect(page.locator("#zeli-conversation-mobile")).toBeVisible();
    await expect(page.locator("#zeli-input")).toBeVisible();
    await sendZeliMessage(page, "Show outstanding operational exceptions.");
    await expect(page.getByText("CALCULATED FACT", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });

    await page.goto("/admin/zeli-analytics");
    await expect(page.getByTestId("zeli-analytics-dashboard")).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Export CSV" })).toBeVisible();
  });
});

test.describe("dual-role switch on Android-sized screen", () => {
  test("switch control and confirmation stay visible and tap-friendly", async ({ page }) => {
    await loginWorker(page, DUAL_ROLE);
    const switchButton = page.getByRole("button", { name: "Switch to Susu Collector" });
    await expect(switchButton).toBeVisible();
    const box = await switchButton.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect((box?.width ?? 0) <= (page.viewportSize()?.width ?? 0)).toBe(true);

    await switchButton.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("button", { name: "Stay Here" })).toBeVisible();
    const confirm = page.getByRole("button", { name: "Yes, Switch" });
    await expect(confirm).toBeVisible();
    expect((await confirm.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(36);
    await confirm.click();
    await page.waitForURL(/\/collector\/dashboard/, { timeout: 30_000 });
    await expect(page.getByText("Susu Collector Dashboard", { exact: true })).toBeVisible();
  });
});
