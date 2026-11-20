import { expect, test } from "@playwright/test";
import { ADMIN_A, CUSTOMER, loginAdmin, loginCustomer } from "./helpers";

/**
 * The customer's own withdrawal request, the printable statement, and the
 * office's decision.
 *
 * A request never moves money: the customer sees it waiting, the office declines
 * with a reason, and the customer sees the outcome. The printable statement is
 * the same ledger in a document layout.
 */
test.describe("Customer withdrawal request", () => {
  test("a customer asks to withdraw and sees the request waiting", async ({ page }) => {
    await loginCustomer(page, CUSTOMER);
    await page.goto("/customer/withdrawals");
    await expect(page.getByRole("heading", { name: "My Withdrawals" })).toBeVisible();
    await expect(
      page.getByText(/A request does not move money/i)
    ).toBeVisible();

    await page.getByLabel(/Amount you want/).fill("1");
    await page
      .getByLabel(/Why do you need it/)
      .fill("I need a small amount for transport this week.");
    await page.getByRole("button", { name: "Send request" }).click();

    // The same notice also appears in the notification centre, so the page body
    // is asserted to prove the screen itself reacted.
    await expect(
      page.getByRole("main").getByText(/Request WRQ-.* sent/i)
    ).toBeVisible({ timeout: 20_000 });
    // The request is visible as waiting, and the form is replaced by its status.
    await expect(page.getByText(/Waiting for the office/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel this request" })).toBeVisible();
  });

  test("the printable statement shows the ledger and a print action", async ({ page }) => {
    await loginCustomer(page, CUSTOMER);
    await page.goto("/customer/statement/print");
    await expect(page.getByRole("heading", { name: "Savings statement" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Print or save as PDF/ })).toBeVisible();
    await expect(page.getByText(/not a bank statement/i)).toBeVisible();
  });

  test("the office sees the request and declines it with a reason", async ({ page }) => {
    await loginAdmin(page, ADMIN_A);
    await page.goto("/susu/admin/withdrawal-requests");
    await expect(
      page.getByRole("heading", { name: "Withdrawal requests" })
    ).toBeVisible();

    const card = page.locator("article").filter({ hasText: "WRQ-" }).first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole("button", { name: "Decline" }).click();

    const dialog = page.getByRole("dialog", { name: "Decline withdrawal request" });
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel("Reason for declining")
      .fill("Please come to the branch with your card so we can pay you.");
    await dialog.getByRole("button", { name: "Decline request" }).click();

    await expect(
      page.locator("#app-main").getByText(/declined\.$/)
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("tab", { name: "Declined" }).click();
    await expect(page.getByText(/Please come to the branch with your card/i)).toBeVisible();
  });
});
