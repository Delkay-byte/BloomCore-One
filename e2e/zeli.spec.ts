import { expect, test } from "@playwright/test";
import { ADMIN_A, loginAdmin, resetSession, sendZeliMessage } from "./helpers";

test.describe("Zeli conversational workspace (provider disabled)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAdmin(page, ADMIN_A);
  });

  test("shows provider status and answers a supported question from records", async ({ page }) => {
    await page.goto("/zeli");
    await expect(
      page.getByText("External AI processing is currently disabled.", { exact: false })
    ).toBeVisible();

    await sendZeliMessage(page, "Summarise this month's contributions and withdrawals.");
    await expect(page.getByText("CALCULATED FACT", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Contributions:", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Computed from your records").first()).toBeVisible();
  });

  test("answers an unsupported question with an honest limitation", async ({ page }) => {
    await page.goto("/zeli");
    await sendZeliMessage(page, "Write me a poem about the sea.");
    await expect(page.getByText("outside the set", { exact: false })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("will not invent an answer", { exact: false })).toBeVisible();
  });

  test("creates, renames and deletes a conversation", async ({ page }) => {
    await page.goto("/zeli");
    await page.getByRole("button", { name: "New" }).click();
    await page.locator("#zeli-input").fill("Summarise remittance activity for this month.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("CALCULATED FACT", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });

    page.once("dialog", (dialog) => dialog.accept("Renamed analytics chat"));
    await page.getByRole("button", { name: /^Rename / }).first().click();
    await expect(page.getByText("Renamed analytics chat").first()).toBeVisible();

    const renamedItem = page.locator("aside li").filter({ hasText: "Renamed analytics chat" });
    page.once("dialog", (dialog) => dialog.accept());
    await renamedItem.getByRole("button", { name: /^Delete / }).click();
    await expect(page.locator("aside").getByText("Renamed analytics chat")).toHaveCount(0);
  });

  test("does not expose the platform control centre to a tenant administrator", async ({ page }) => {
    await page.goto("/platform/zeli");
    await page.waitForURL(/\/platform\/login/, { timeout: 20_000 });
    await expect(page).toHaveURL(/\/platform\/login/);
  });

  test("tenant B cannot open tenant A analytics", async ({ page }) => {
    await resetSession(page);
    await loginAdmin(page, "e2e-admin-b@test.local");
    await page.goto("/admin/zeli-analytics");
    await page.waitForURL(/\/admin\/zeli-analytics\/upgrade/, { timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: "Analytics is not enabled for this business" })
    ).toBeVisible();
    await expect(page.getByText("E2E Bloom Business A")).toHaveCount(0);
  });
});
