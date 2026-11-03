import { expect, test } from "@playwright/test";
import { ADMIN_A, loginAdmin, sendZeliMessage } from "./helpers";

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
