import { expect, test } from "@playwright/test";
import { ADMIN_A, loginAdmin, resetSession, sendZeliMessage } from "./helpers";

test.describe("Zeli conversational workspace (provider disabled)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAdmin(page, ADMIN_A);
  });

  test("answers from records with structured local sections", async ({ page }) => {
    await page.goto("/zeli");
    await expect(page.getByRole("heading", { name: "Zeli", exact: true })).toBeVisible();
    await expect(
      page.getByText("Zeli reads your authorised records", { exact: false })
    ).toBeVisible();

    await sendZeliMessage(page, "Summarise this month's contributions and withdrawals.");
    await expect(page.getByRole("heading", { name: "Key figures" }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Contributions:", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "How to read this" }).first()).toBeVisible();
    await expect(page.getByText("Limitations").first()).toBeVisible();
  });

  test("answers an unsupported question with an honest local explanation", async ({ page }) => {
    await page.goto("/zeli");
    await sendZeliMessage(page, "Write me a poem about the sea.");
    await expect(
      page.getByText("general knowledge questions in local mode", { exact: false })
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText("Nothing from this conversation was sent anywhere", { exact: false })
    ).toBeVisible();
  });

  test("greets, answers and resolves a follow-up from conversation context", async ({ page }) => {
    await page.goto("/zeli");
    await sendZeliMessage(page, "Hello");
    await expect(
      page.getByText("internal rule-based engine", { exact: false })
    ).toBeVisible({ timeout: 30_000 });

    await sendZeliMessage(page, "Summarise contributions and withdrawals for this month.");
    await expect(page.getByRole("heading", { name: "Key figures" }).first()).toBeVisible({
      timeout: 30_000,
    });

    await sendZeliMessage(page, "And last month?");
    await expect(page.getByText("Previous month", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test("refuses a financial instruction without changing data", async ({ page }) => {
    await page.goto("/zeli");
    await sendZeliMessage(page, "Approve the pending withdrawal now");
    await expect(page.getByText("can't do that", { exact: false })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("No data was changed", { exact: false })).toBeVisible();
  });

  test("creates, renames and deletes a conversation", async ({ page }) => {
    await page.goto("/zeli");
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.locator("#zeli-input").fill("Summarise remittance activity for this month.");
    await page.getByRole("button", { name: "Send question" }).click();
    await expect(page.getByRole("heading", { name: "Key figures" }).first()).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole("button", { name: /^Rename / }).first().click();
    const renameDialog = page.getByRole("dialog", { name: "Rename conversation" });
    await expect(renameDialog).toBeVisible();
    await renameDialog.getByLabel("Conversation name").fill("Renamed analytics chat");
    await renameDialog.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByText("Renamed analytics chat").first()).toBeVisible();

    const renamedItem = page.locator("aside li").filter({ hasText: "Renamed analytics chat" });
    await renamedItem.getByRole("button", { name: /^Delete / }).click();
    const deleteDialog = page.getByRole("alertdialog", { name: "Delete this conversation?" });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
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
