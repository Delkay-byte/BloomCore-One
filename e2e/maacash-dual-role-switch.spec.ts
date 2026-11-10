import { expect, test } from "@playwright/test";
import {
  COLLECTOR,
  DUAL_ROLE,
  WORKER,
  loginCollector,
  loginWorker,
  pageJson,
} from "./helpers";

type MeResponse = {
  module?: string;
  tenant?: { id?: string; modules?: string[] } | null;
};

/**
 * A person with both capabilities uses one authenticated identity and switches
 * dashboards in place. No password, authenticator code or role-selection screen.
 */
test.describe("dual-role dashboard switching", () => {
  test("switches MoMo -> Susu -> MoMo without signing in again", async ({ page }) => {
    await loginWorker(page, DUAL_ROLE);

    await expect(page.getByText("Current dashboard")).toBeVisible();
    await expect(page.getByText("MoMo Agent Dashboard", { exact: true })).toBeVisible();

    // Cancel leaves the current dashboard untouched.
    await page.getByRole("button", { name: "Switch to Susu Collector" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByText("Switch to Susu Collector?")).toBeVisible();
    await page.getByRole("button", { name: "Stay Here" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/worker\/dashboard/);

    // Confirm opens the Susu workspace directly.
    await page.getByRole("button", { name: "Switch to Susu Collector" }).click();
    await page.getByRole("button", { name: "Yes, Switch" }).click();
    await page.waitForURL(/\/collector\/dashboard/, { timeout: 30_000 });
    await expect(page.getByText("Susu Collector Dashboard", { exact: true })).toBeVisible();
    await expect(page.locator("#identifier")).toHaveCount(0);
    await expect(page.locator("#password")).toHaveCount(0);

    // Regression: a dual-role worker-role account in the Susu tab must resolve
    // the Susu session and its tenant. This used to return tenant: null, which
    // produced "The signed-in business could not be confirmed." and made the
    // saved queue unreadable.
    const susuMe = await pageJson<MeResponse>(
      page,
      "/api/auth/me?module=susu"
    );
    expect(susuMe.module).toBe("susu");
    expect(susuMe.tenant?.id).toBeTruthy();

    const neutralMe = await pageJson<MeResponse>(page, "/api/auth/me");
    expect(neutralMe.module).toBe("susu");
    expect(neutralMe.tenant?.id).toBe(susuMe.tenant?.id);

    await expect(
      page.getByText("The signed-in business could not be confirmed.")
    ).toHaveCount(0);

    const offlinePanel = page.getByRole("region", { name: "Offline records" });
    await expect(offlinePanel).toBeVisible();
    await expect(
      offlinePanel.getByText("Saved-record details could not be read")
    ).toHaveCount(0);
    await expect(
      offlinePanel.getByText("Synced. No unsynchronized offline records on this device.")
    ).toBeVisible({ timeout: 30_000 });

    // Switch back on the same session.
    await page.getByRole("button", { name: "Switch to MoMo Agent" }).click();
    await expect(page.getByText("Switch to MoMo Agent?")).toBeVisible();
    await page.getByRole("button", { name: "Yes, Switch" }).click();
    await page.waitForURL(/\/worker\/dashboard/, { timeout: 30_000 });
    await expect(page.getByText("MoMo Agent Dashboard", { exact: true })).toBeVisible();
    await expect(page.locator("#identifier")).toHaveCount(0);

    const momoMe = await pageJson<MeResponse>(page, "/api/auth/me");
    expect(momoMe.module).toBe("momo");
    expect(momoMe.tenant?.id).toBe(susuMe.tenant?.id);

    // And back to Susu: the same tenant/user queue must still be readable.
    await page.getByRole("button", { name: "Switch to Susu Collector" }).click();
    await page.getByRole("button", { name: "Yes, Switch" }).click();
    await page.waitForURL(/\/collector\/dashboard/, { timeout: 30_000 });
    await expect(
      page
        .getByRole("region", { name: "Offline records" })
        .getByText("Synced. No unsynchronized offline records on this device.")
    ).toBeVisible({ timeout: 30_000 });
  });

  test("a MoMo-only agent sees no Susu switch", async ({ page }) => {
    await loginWorker(page, WORKER);
    await expect(page.getByText("Current dashboard")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Switch to Susu Collector" })
    ).toHaveCount(0);
  });

  test("a Susu-only collector sees no MoMo switch", async ({ page }) => {
    await loginCollector(page, COLLECTOR);
    await expect(page.getByText("Current dashboard")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Switch to MoMo Agent" })
    ).toHaveCount(0);
  });
});
