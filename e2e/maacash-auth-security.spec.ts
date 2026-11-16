import { expect, test } from "@playwright/test";

/**
 * Public authentication security screens. These tests use no real account and
 * never request a password reset for a live address.
 */
test.describe("authentication security screens", () => {
  test("login exposes the email reset entry point", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /Susu Collector/ }).click();
    await expect(page.getByRole("link", { name: "Forgot password?" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Forgot password?" })).toHaveAttribute(
      "href",
      "/forgot-password"
    );
  });

  test("forgot password returns the same generic confirmation for an unknown address", async ({
    page,
  }) => {
    await page.goto("/forgot-password");
    await page.locator("#reset-email").fill("nobody-auth-test@example.com");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("Check your inbox")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/If that address belongs to a verified/i)).toBeVisible();
  });

  test("reset screen without a token asks for a new link", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(page.getByText("Reset link missing")).toBeVisible();
    await expect(page.getByRole("link", { name: "Request a new link" })).toBeVisible();
  });

  test("verification screen without a token offers a resend", async ({ page }) => {
    await page.goto("/verify-email");
    await expect(
      page.getByRole("heading", { name: "Request another verification email" })
    ).toBeVisible();
    await expect(page.locator("#verify-email")).toBeVisible();
  });

  test("required password change without a challenge fails closed", async ({ page }) => {
    await page.goto("/password-upgrade?required=1");
    await expect(page.getByText("Password change session expired")).toBeVisible({
      timeout: 30_000,
    });
  });
});
