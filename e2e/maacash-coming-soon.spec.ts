import { expect, test } from "@playwright/test";
import { loginAdmin, loginCustomer, CUSTOMER } from "./helpers";

/**
 * "Coming soon" markers on unavailable external integrations.
 *
 * Two rules matter more than the styling: an unavailable provider action must say so
 * plainly, and the marker must never spread onto work that already functions —
 * manually recorded MoMo, CSV statement import, reports, customer access. WhatsApp is
 * explicitly excluded because the owner is building that integration.
 */
test.describe("External integration notices", () => {
  test.beforeEach(async ({ page }) => {
    await loginAdmin(page);
  });

  test("marks every unavailable provider and only those", async ({ page }) => {
    await page.goto("/admin/integrations");
    await expect(page.getByRole("heading", { name: "Integration readiness" })).toBeVisible();

    const badges = page.getByTestId("coming-soon");
    await expect(badges.first()).toBeVisible({ timeout: 30_000 });

    // Each unbuilt integration is named in a card that carries the marker.
    for (const label of [
      "MTN operational integration",
      "Telecel operational integration",
      "AT Money operational integration",
      "SMS live delivery",
      "Banking integration",
      "Accounting integration",
      "External customer identity verification",
    ]) {
      const card = page.locator("article").filter({ hasText: label });
      await expect(card.getByTestId("coming-soon"), label).toBeVisible();
    }

    // WhatsApp is being built by the owner: no "Coming soon" marker on it.
    const whatsapp = page.locator("article").filter({ hasText: "WhatsApp receipts" });
    await expect(whatsapp).toBeVisible();
    await expect(whatsapp.getByTestId("coming-soon")).toHaveCount(0);

    // The marker is announced, not just coloured.
    await expect(badges.first()).toHaveAttribute("aria-label", /not available yet/i);

    // It stays legible without covering the card on a phone-sized screen.
    const badge = badges.first();
    const box = await badge.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(40);
    expect(box!.width).toBeLessThan(260);
    await expect(badge).toBeInViewport();

    // Nothing on the page offers a live provider action.
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
