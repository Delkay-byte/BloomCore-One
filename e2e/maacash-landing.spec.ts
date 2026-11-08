import { expect, test } from "@playwright/test";

/**
 * Public landing page: destinations, product accuracy and responsive layout.
 */

const WIDTHS = [360, 390, 768, 1280];

test.describe("public landing page", () => {
  test("keeps the brand, navigation and sign-in destination", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // The stylesheet imports Noto Sans for the Ghana cedi glyph. A CI
      // sandbox without outbound TLS cannot fetch it; that is not an
      // application error and the system font stack still renders the page.
      if (/fonts\.googleapis\.com|Failed to load resource/i.test(message.text())) return;
      consoleErrors.push(message.text());
    });

    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: /Manage your MoMo and Susu business/i })
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "MaaCash home" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign In", exact: true }).first()).toHaveAttribute(
      "href",
      /^\/(login|workspace)$/
    );

    for (const label of ["Features", "Who We Serve", "About", "Contact"]) {
      await expect(page.getByRole("link", { name: label, exact: true }).first()).toBeVisible();
    }

    await expect(page.getByRole("heading", { name: "MoMo operations" }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Susu management" }).first()).toBeVisible();
    await expect(page.getByText(/A product by BloomCore Technologies/i)).toBeVisible();

    const title = await page.title();
    expect(title).toContain("MaaCash");
    expect(consoleErrors).toEqual([]);
  });

  test("anchors and links work", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Explore MaaCash" }).click();
    await expect(page.locator("#platform")).toBeVisible();

    await page.locator('a[href="#momo"]').first().click();
    await expect(page.locator("#momo")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Close the day/ })).toBeVisible();

    await page.locator("#susu").scrollIntoViewIfNeeded();
    await expect(page.getByRole("heading", { name: /Every collection against/ })).toBeVisible();

    await page.getByRole("link", { name: "Sign In", exact: true }).first().click();
    await expect(page).toHaveURL(/\/login/);
  });

  for (const width of WIDTHS) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }

  test("mobile navigation opens, closes on Escape and links to sign-in", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const menu = page.getByRole("button", { name: "Open menu" });
    await menu.click();
    await expect(page.getByRole("button", { name: "Close menu" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await expect(
      page.locator("#marketing-mobile-nav").getByRole("link", { name: "Features" })
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );

    await page.getByRole("button", { name: "Open menu" }).click();
    await page.locator("#marketing-mobile-nav").getByRole("link", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/workspace|\/login/);
  });
});
