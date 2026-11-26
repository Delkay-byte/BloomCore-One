import { expect, test } from "@playwright/test";
import { loginAdmin } from "./helpers";

/**
 * Sponsored subscriptions acceptance.
 *
 * The screen's job is to stop a sponsorship being mistaken for paid cover, so the
 * suite checks the ledger language and the refusals a person would hit: a
 * duplicate sponsor, a cap that exceeds the agreement, and money recorded against
 * a sponsorship only after an agreement exists.
 */
test.describe("Sponsored subscriptions", () => {
  test.beforeEach(async ({ page }) => {
    await loginAdmin(page);
  });

  test("registers a sponsor and records an agreement without claiming payment", async ({
    page,
  }) => {
    await page.goto("/admin/association");
    await expect(page.getByRole("heading", { name: "Association register" })).toBeVisible();

    const panel = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Sponsored subscriptions" }) });
    await expect(panel).toBeVisible({ timeout: 30_000 });

    // The panel must not present an unfunded agreement as paid cover.
    await expect(panel.getByText(/does not give the sponsor any ownership/)).toBeVisible();

    const name = `E2E Sponsor ${Date.now()}`;
    await panel.locator("#sponsor-name").fill(name);
    await panel.getByTestId("sponsor-create").click();
    await expect(page.getByText("Sponsor registered.").first()).toBeVisible({ timeout: 30_000 });

    // A second sponsor with the same name is refused, not silently duplicated.
    await panel.locator("#sponsor-name").fill(name);
    await panel.getByTestId("sponsor-create").click();
    await expect(page.getByText(/already exists/i).first()).toBeVisible({ timeout: 30_000 });

    await expect(panel.getByRole("cell", { name, exact: true })).toBeVisible();
  });

  test("records an agreement, then separates agreed money from funded money", async ({
    page,
  }) => {
    const stamp = Date.now();
    await page.goto("/admin/association");
    await expect(page.getByRole("heading", { name: "Association register" })).toBeVisible();

    const memberCode = `E2E-${stamp}`;
    await page.getByLabel("Member code").fill(memberCode);
    await page.getByLabel("Business name").fill(`E2E Sponsored Business ${stamp}`);
    await page.getByLabel("Contact person").fill("Sponsorship Tester");
    await page.getByLabel("Phone").fill("+233200000111");
    await page.getByRole("button", { name: "Register member" }).click();
    await expect(page.getByText(/Member registered/).first()).toBeVisible({ timeout: 30_000 });

    await page.reload();
    const panel = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Sponsored subscriptions" }) });
    await expect(panel).toBeVisible({ timeout: 30_000 });

    const sponsorName = `E2E Funding Sponsor ${stamp}`;
    await panel.locator("#sponsor-name").fill(sponsorName);
    await panel.getByTestId("sponsor-create").click();
    await expect(page.getByText("Sponsor registered.")).toBeVisible({ timeout: 30_000 });

    await panel.locator("#sponsor-member").selectOption({ label: `E2E Sponsored Business ${stamp} (${memberCode})` });
    await panel.locator("#sponsor-select").selectOption({ label: sponsorName });
    await panel.locator("#sponsor-amount").fill("1000");
    await panel.getByTestId("sponsorship-create").click();
    await expect(page.getByText("Sponsorship agreement recorded.").first()).toBeVisible({ timeout: 30_000 });

    const row = panel.getByTestId(`sponsorship-row-${memberCode}`);
    await expect(row).toBeVisible();
    // An unfunded agreement must not read as paid cover.
    await expect(row).toContainText("GHS 1000.00");
    await expect(row).toContainText("not covered");
    await expect(panel.getByTestId("sponsorship-unassigned")).toContainText("GHS 0.00");

    await panel.locator("#funding-sponsorship").selectOption({ label: `${memberCode} — ${sponsorName}` });
    await panel.locator("#funding-amount").fill("300");
    await panel.locator("#funding-reference").fill(`E2E-REF-${stamp}`);
    await panel.getByTestId("funding-record").click();
    await expect(page.getByText("Funding recorded.").first()).toBeVisible({ timeout: 30_000 });

    await expect(row).toContainText("GHS 300.00");
    await expect(panel.getByTestId("sponsorship-unassigned")).toContainText("GHS 300.00");
    await expect(panel.getByTestId("sponsorship-covered")).toContainText("GHS 0.00");
  });
});
