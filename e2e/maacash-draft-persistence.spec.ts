import { expect, test } from "@playwright/test";
import {
  PASSWORD,
  loginAdmin,
  loginWorker,
  waitForHydration,
} from "./helpers";

/**
 * Regression coverage for the draft lifecycle.
 *
 * These tests run against the isolated E2E database and the real UI. They do
 * not submit a financial record unless a test explicitly asks for it.
 */

const DRAFT_ID = "e2e-daily-draft";

async function openDraft(page: import("@playwright/test").Page, id = DRAFT_ID) {
  await page.goto(`/worker/daily/${id}`);
  await waitForHydration(page, "#opening-cash");
}

async function fillMoney(page: import("@playwright/test").Page, selector: string, value: string) {
  await page.locator(selector).fill(value);
}

async function fillCompleteDraft(page: import("@playwright/test").Page) {
  await fillMoney(page, "#opening-cash", "77.25");
  await fillMoney(page, "#opening-float", "123.50");
  await fillMoney(page, "#additional-cash", "10.00");
  await fillMoney(page, "#additional-float", "20.50");
  await fillMoney(page, "#customer-deposit", "30.75");
  await fillMoney(page, "#cash-out", "5.25");
  await fillMoney(page, "#airtime-sold", "2.50");
  await fillMoney(page, "#commission", "1.75");
  await fillMoney(page, "#closing-cash", "100.50");
  await fillMoney(page, "#closing-float", "50.25");
  await page.locator("#reconciliation-note").fill(
    "Short by GH₵0.50 — customer paid with a torn note. Follow up tomorrow."
  );

  await page.getByRole("button", { name: /Add expense/ }).click();
  await page.locator("#expense-desc-0").fill("Transport — “trotro”");
  await page.locator("#expense-amount-0").fill("5.50");
  await page.getByRole("button", { name: /Add expense/ }).click();
  await page.locator("#expense-desc-1").fill("Data & airtime, shop");
  await page.locator("#expense-amount-1").fill("12.25");
}

test.describe("draft persistence", () => {
  test("server draft restores every field after leaving and returning", async ({ page }) => {
    await loginWorker(page);
    await openDraft(page);
    await fillCompleteDraft(page);

    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText(/Draft saved successfully/).first()).toBeVisible({
      timeout: 30_000,
    });

    // Leave the page entirely, as a user would at the end of a shift.
    await page.goto("/worker/dashboard");
    await openDraft(page);

    await expect(page.locator("#opening-cash")).toHaveValue("77.25");
    await expect(page.locator("#opening-float")).toHaveValue("123.5");
    await expect(page.locator("#additional-cash")).toHaveValue("10");
    await expect(page.locator("#additional-float")).toHaveValue("20.5");
    await expect(page.locator("#customer-deposit")).toHaveValue("30.75");
    await expect(page.locator("#cash-out")).toHaveValue("5.25");
    await expect(page.locator("#airtime-sold")).toHaveValue("2.5");
    await expect(page.locator("#commission")).toHaveValue("1.75");
    await expect(page.locator("#closing-cash")).toHaveValue("100.5");
    await expect(page.locator("#closing-float")).toHaveValue("50.25");
    await expect(page.locator("#reconciliation-note")).toHaveValue(
      /torn note/
    );
    await expect(page.locator("#expense-desc-0")).toHaveValue(/Transport/);
    await expect(page.locator("#expense-amount-0")).toHaveValue("5.5");
    await expect(page.locator("#expense-desc-1")).toHaveValue(/Data/);
    await expect(page.locator("#expense-amount-1")).toHaveValue("12.25");

    // Re-saving updates the same draft, not a duplicate record.
    await fillMoney(page, "#cash-out", "6.00");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText(/Draft saved successfully/).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.reload();
    await waitForHydration(page, "#opening-cash");
    await expect(page.locator("#cash-out")).toHaveValue("6");
  });

  test("unsaved input survives a refresh through the scoped local draft", async ({ page }) => {
    await loginWorker(page);
    await openDraft(page);

    await fillMoney(page, "#opening-cash", "88.88");
    await fillMoney(page, "#opening-float", "44.44");
    await page.locator("#reconciliation-note").fill("Local draft survives a refresh.");

    // No Save draft click: the autosave indicator must confirm the local write.
    await expect(page.getByText(/Draft saved successfully/).first()).toBeVisible({
      timeout: 30_000,
    });

    await page.reload();
    await waitForHydration(page, "#opening-cash");
    await expect(page.locator("#opening-cash")).toHaveValue("88.88");
    await expect(page.locator("#opening-float")).toHaveValue("44.44");
    await expect(page.locator("#reconciliation-note")).toHaveValue(/Local draft/);
  });

  test("a failed server save reports an error, keeps the values and retries", async ({ page, context }) => {
    await loginWorker(page);
    await openDraft(page);
    await fillMoney(page, "#opening-cash", "55.55");

    // Take the browser offline: the server action never reaches the server.
    await context.setOffline(true);

    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(
      page.getByText(/We couldn't save your draft/).first()
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#opening-cash")).toHaveValue("55.55");
    await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled();

    await context.setOffline(false);
    await page.getByRole("button", { name: /Retry save/ }).click();
    await expect(page.getByText(/Draft saved successfully/).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator("#opening-cash")).toHaveValue("55.55");
  });

  test("rapid edits persist the latest value, not an older request", async ({ page }) => {
    await loginWorker(page);
    await openDraft(page);

    await fillMoney(page, "#cash-out", "1");
    await fillMoney(page, "#cash-out", "2");
    await fillMoney(page, "#cash-out", "3");
    await page.waitForTimeout(1_500);

    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText(/Draft saved successfully/).first()).toBeVisible({
      timeout: 30_000,
    });

    await page.reload();
    await waitForHydration(page, "#opening-cash");
    await expect(page.locator("#cash-out")).toHaveValue("3");
  });

  test("a draft cannot be opened from another tenant", async ({ page }) => {
    await loginAdmin(page, "e2e-admin-b@test.local");
    await page.goto("/admin/reports/e2e-daily-draft");
    await expect(page.getByText(/Report not found/i)).toBeVisible({ timeout: 30_000 });
  });

  test("a MoMo-only administrator can save and restore a create-form draft", async ({ page }) => {
    await page.goto("/admin/login");
    await waitForHydration(page, "#email");
    await page.locator("#email").fill("e2e-admin-c@test.local");
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/admin\/dashboard/, { timeout: 30_000 });

    await page.goto("/admin/workers");
    await waitForHydration(page, "text=Workers");
    await page.getByRole("button", { name: /Add Worker/ }).click();

    await page.locator('[name="fullName"]').fill("Draft Worker");
    await page.locator('[name="email"]').fill("draft.worker@test.local");
    await page.locator('[name="phone"]').fill("+233200000777");
    // Let the debounced write that contains all three fields complete.
    await page.waitForTimeout(1_200);

    await expect(page.getByText(/Draft saved successfully/).first()).toBeVisible({
      timeout: 30_000,
    });

    await page.reload();
    await waitForHydration(page, "text=Workers");
    await page.getByRole("button", { name: /Add Worker/ }).click();

    await expect(page.locator('[name="fullName"]')).toHaveValue("Draft Worker");
    await expect(page.locator('[name="email"]')).toHaveValue("draft.worker@test.local");
    await expect(page.locator('[name="phone"]')).toHaveValue("+233200000777");
  });
});
