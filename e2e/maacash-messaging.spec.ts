import { expect, test } from "@playwright/test";
import { ADMIN_A, CUSTOMER, loginAdmin, loginCustomer } from "./helpers";
import { restoreMessagingConfig } from "./messaging-restore";

/**
 * Message delivery settings and the customer's proof-of-ownership step.
 *
 * The browser proves the two things a person can see: a business switch changes
 * what the queue would do, and a customer who types a number is asked for a code
 * instead of being treated as opted in.
 */
test.describe("Message delivery settings", () => {
  test.afterAll(() => {
    // These switches are business-wide; leaving them on would change what other
    // specs could send, so the fixture is returned to its default.
    restoreMessagingConfig();
  });

  test("a business switches WhatsApp on and sees what a receipt would do", async ({
    page,
  }) => {
    await loginAdmin(page, ADMIN_A);
    await page.goto("/admin/messaging");
    await expect(page.getByRole("heading", { name: "Message delivery" })).toBeVisible();

    const whatsapp = page.getByLabel("Send receipts over WhatsApp");
    await expect(whatsapp).not.toBeChecked();
    await whatsapp.check();
    await page.getByRole("button", { name: /Save settings/ }).click();

    // The notice also appears in the notification centre, so scope the assertion
    // to the page body to prove the page itself updated.
    await expect(
      page.locator("#app-main").getByText("Messaging settings saved.")
    ).toBeVisible();
    // No provider is configured for this deployment, so the honest state is
    // that delivery is not possible yet, shown in the readiness panel.
    await expect(page.getByText(/not configured for this deployment/)).toBeVisible();
    await expect(
      page
        .getByRole("main")
        .getByText(/WhatsApp:.*(receipt would be sent|not registered|not approved)/i)
    ).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Message delivery" })
    ).toBeVisible();
    await expect(page.getByLabel("Send receipts over WhatsApp")).toBeChecked();
  });

  test("a registered template shows its approval state", async ({ page }) => {
    await loginAdmin(page, ADMIN_A);
    await page.goto("/admin/messaging");
    await page.getByRole("button", { name: "Save template" }).click();
    await expect(
      page.locator("#app-main").getByText("Template saved as approved by provider.")
    ).toBeVisible();
    await expect(page.getByRole("cell", { name: "maacash_receipt" })).toBeVisible();
  });

  test("a customer who types a number is asked to confirm it", async ({ page }) => {
    await loginCustomer(page, CUSTOMER);
    await page.goto("/customer/settings");
    await expect(page.getByRole("heading", { name: "Receipt messages" })).toBeVisible();

    await page.getByLabel("WhatsApp number").fill("+233200000999");
    await page
      .getByLabel(/I confirm this number is mine and I agree to receive WhatsApp receipts/i)
      .check();
    await page.getByRole("button", { name: /Save receipt preferences/ }).click();

    const card = page.getByRole("region", { name: "Receipt messages" });
    await expect(card.getByText(/confirmation code/i).first()).toBeVisible();
    await expect(card.getByRole("textbox", { name: "Confirmation code" })).toBeVisible();
    // Until the code comes back, no receipt may go to that number.
    await expect(
      card.getByText(/Not confirmed yet, so no WhatsApp receipt/)
    ).toBeVisible();
  });
});
