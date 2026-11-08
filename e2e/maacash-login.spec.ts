import { expect, test } from "@playwright/test";
import { waitForHydration } from "./helpers";

/**
 * The three stakeholder sign-in experiences share one route and one
 * authentication contract. Each role must be identifiable before the user
 * types anything, and the password control must remain accessible.
 */

const ROLES = [
  {
    role: "momo",
    label: "MoMo Agent",
    heading: "MoMo Agent Login",
    support: /daily MoMo operations and account reconciliation/i,
  },
  {
    role: "susu",
    label: "Susu Collector",
    heading: "Susu Collector Login",
    support: /customer collections and your daily collection records/i,
  },
  {
    role: "customer",
    label: "Customer",
    heading: "Welcome Back",
    support: /Susu savings, contributions and account activity/i,
  },
] as const;

test.describe("stakeholder sign-in", () => {
  test("the shared entry point presents all three roles", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("heading", { name: "Who are you?" }).waitFor();
    await page.waitForTimeout(700);
    await expect(page.getByRole("heading", { name: "Who are you?" })).toBeVisible();
    for (const role of ROLES) {
      await expect(page.getByRole("button", { name: new RegExp(role.label) })).toBeVisible();
    }
  });

  for (const role of ROLES) {
    test(`${role.label} deep link opens its own sign-in experience`, async ({ page }) => {
      await page.goto(`/login/${role.role}`);
      await waitForHydration(page, "#identifier");
      await expect(page.getByRole("heading", { name: role.heading })).toBeVisible();
      await expect(page.getByText(role.support).first()).toBeVisible();
      await expect(page.locator('input[name="role"]')).toHaveValue(role.role);

      const password = page.locator("#password");
      await expect(password).toHaveAttribute("type", "password");
      const toggle = page.getByRole("button", { name: "Show password" });
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await toggle.click();
      await expect(page.locator("#password")).toHaveAttribute("type", "text");
      await expect(page.getByRole("button", { name: "Hide password" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });
  }

  test("changing role returns to the role chooser", async ({ page }) => {
    await page.goto("/login?role=momo");
    await waitForHydration(page, "#identifier");
    await page.getByRole("button", { name: /Change role/ }).click();
    await expect(page.getByRole("heading", { name: "Who are you?" })).toBeVisible();
  });

  test("the administrator role is never handled by the shared portal", async ({ page }) => {
    await page.goto("/login?role=admin");
    await expect(
      page.getByRole("heading", { name: /Please use the administrator login/i })
    ).toBeVisible();
  });
});
