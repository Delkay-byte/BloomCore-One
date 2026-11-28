import { expect, test } from "@playwright/test";
import { loginAdmin, loginCustomer, CUSTOMER } from "./helpers";

/**
 * Truthful capability statuses across the product.
 *
 * The rules that matter more than the styling: an unavailable provider must say
 * so plainly with its one honest status (Available / Sandbox / Not configured /
 * Unavailable / Manual process / Requires owner setup), a capability must never
 * wear two contradictory labels, work that already functions — manually
 * recorded MoMo, CSV statement import, reports, customer access — must carry no
 * provider notice at all, and nothing may offer a live provider action.
 */
test.describe("External integration notices", () => {
  test.beforeEach(async ({ page }) => {
    await loginAdmin(page);
  });

  test("labels every provider capability with its one truthful status", async ({ page }) => {
    await page.goto("/admin/integrations");
    await expect(
      page.getByRole("heading", { name: "Integrations & Provider Capabilities" })
    ).toBeVisible();

    // Every unbuilt integration is labelled Unavailable in its own card.
    // Nothing is labelled "Coming soon" any more: a capability has exactly
    // one status, and an unavailable capability must not also look planned.
    for (const label of [
      "MTN Mobile Money",
      "Telecel Cash",
      "AT Money",
      "Bank feeds",
      "Identity verification",
      "Customer payment status",
    ]) {
      const card = page.locator("article").filter({ hasText: label });
      await expect(card.getByText("Unavailable", { exact: true }), label).toBeVisible();
    }

    // In this deployment no SMS provider has been selected, so the SMS card
    // says "Not configured" rather than "Unavailable".
    const sms = page.locator("article").filter({ hasText: "SMS live delivery" });
    await expect(sms.getByText("Not configured", { exact: true })).toBeVisible();

    // Accounting is a real, supported manual workflow.
    const accounting = page.locator("article").filter({ hasText: "Accounting export" });
    await expect(accounting.getByText("Manual process", { exact: true })).toBeVisible();

    // WhatsApp Cloud API credentials come from the deployment configuration,
    // which the owner supplies: owner setup, not a broken integration.
    const whatsapp = page.locator("article").filter({ hasText: "WhatsApp receipts" });
    await expect(whatsapp.getByText("Requires owner setup", { exact: true })).toBeVisible();

    // The legend explains what each status means.
    await expect(page.getByRole("heading", { name: "How to read the statuses" })).toBeVisible();

    // The per-card delivery disclaimer is consolidated, not repeated ten times.
    await expect(page.getByText("Does not deliver outside MaaCash")).toHaveCount(0);

    // The page must not offer any live provider action.
    await expect(
      page.getByRole("button", { name: /connect|test send|sync now|send now/i })
    ).toHaveCount(0);
  });

  test("keeps the notice off WhatsApp while SMS delivery is marked", async ({ page }) => {
    await page.goto("/admin/messaging");
    await expect(page.getByRole("heading", { name: "Message delivery" })).toBeVisible();

    const smsRow = page
      .locator("li")
      .filter({ hasText: /SMS provider:/ })
      .first();
    await expect(smsRow.getByTestId("coming-soon")).toBeVisible({ timeout: 30_000 });

    const whatsappRow = page
      .locator("li")
      .filter({ hasText: /WhatsApp provider:/ })
      .first();
    await expect(whatsappRow).toBeVisible();
    await expect(whatsappRow.getByTestId("coming-soon")).toHaveCount(0);

    const smsToggle = page.getByLabel(/Send receipts over SMS/);
    await expect(smsToggle).toBeVisible();
    await expect(
      page.locator("label").filter({ hasText: "Send receipts over SMS" }).getByTestId("coming-soon")
    ).toBeVisible();
    await expect(
      page
        .locator("label")
        .filter({ hasText: "Send receipts over WhatsApp" })
        .getByTestId("coming-soon")
    ).toHaveCount(0);
  });

  test("leaves the manual and already-working workflows unmarked", async ({ page }) => {
    // Statement import works from a CSV the business uploads, so no provider notice.
    await page.goto("/admin/reconciliation");
    await expect(
      page.getByRole("heading", { name: "Provider Statement Reconciliation" })
    ).toBeVisible();
    await expect(page.getByText(/Statement file \(CSV\)/)).toBeVisible();
    await expect(page.getByTestId("coming-soon")).toHaveCount(0);

    // Reports are computed from this business's own records.
    await page.goto("/admin/reports/consolidated");
    await expect(page.getByTestId("coming-soon")).toHaveCount(0);

    // Manually recorded MoMo keeps working without any provider notice.
    await page.goto("/admin/ledger");
    await expect(page.getByRole("heading", { name: "MoMo transaction ledger" })).toBeVisible();
    await expect(page.getByTestId("coming-soon")).toHaveCount(0);
  });

  test("shows the customer portal without a provider notice", async ({ page }) => {
    await loginCustomer(page, CUSTOMER);
    await page.goto("/customer/withdrawals");
    await expect(page.getByTestId("coming-soon")).toHaveCount(0);
    await expect(page.getByRole("main")).toBeVisible();
  });
});
