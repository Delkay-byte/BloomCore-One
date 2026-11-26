import { expect, test } from "@playwright/test";

/**
 * The role chooser at phone width.
 *
 * Four cards must fit, stay legible and stay tappable on a phone-sized screen — an
 * owner who cannot find their own sign-in on a handset will assume there is none.
 * Desktop coverage of the same four cards lives in `maacash-login.spec.ts`; this file
 * is the phone-width check and runs in the mobile project only.
 */
test.describe("sign-in cards", () => {
  test("shows four reachable role cards", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Who are you?" })).toBeVisible();

    const owner = page.getByTestId("login-card-business-owner");
    await expect(owner).toBeVisible({ timeout: 30_000 });
    await expect(owner).toContainText("Business Owner");

    for (const label of ["MoMo Agent", "Susu Collector", "Customer"]) {
      await expect(page.getByRole("button", { name: new RegExp(label) })).toBeVisible();
    }

    // Tap targets stay comfortable and the card does not overflow the viewport.
    const box = await owner.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(64);
    const viewport = page.viewportSize();
    if (viewport) {
      expect(box!.width).toBeLessThanOrEqual(viewport.width);
    }
    await expect(owner).toBeInViewport();
  });

  test("the owner card opens the canonical administrator sign-in", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("login-card-business-owner").click();
    await page.waitForURL(/\/admin\/login/, { timeout: 30_000 });
    await expect(page.locator("#email")).toBeVisible({ timeout: 30_000 });
  });
});
