import { expect, test } from "@playwright/test";

const PASSWORD = "E2ePass123!";

async function fillAdminLogin(page: import("@playwright/test").Page) {
  await page.goto("/admin/login");
  await page.locator("#email").fill("e2e-admin-a@test.local");
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
}

test.describe("tab-session fail-closed behaviour", () => {
  test("blocked service workers cannot authenticate through a cookie", async ({
    browser,
  }) => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await fillAdminLogin(page);

    await expect(
      page.getByText(/could not establish an isolated tab session/i)
    ).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/admin\/login/);
    expect(
      (await context.cookies()).filter((c) =>
        /^bik-(admin|worker|collector|customer|platform)-session$/.test(c.name)
      )
    ).toHaveLength(0);

    await page.goto("/admin/dashboard");
    await expect(page).toHaveURL(/\/login/);
    await context.close();
  });

  test("unavailable IndexedDB shows a clear disabled-session notice", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(window, "indexedDB", {
        configurable: true,
        get: () => undefined,
      });
    });
    await page.goto("/admin/login");
    await expect(page.getByTestId("tab-session-unsupported")).toBeVisible();
    await page.locator("#email").fill("e2e-admin-a@test.local");
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(
      page.getByText(/cannot safely support independent tab sessions/i)
    ).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/login/);
    expect(
      (await context.cookies()).filter((c) =>
        /^bik-(admin|admin)-session$/.test(c.name)
      )
    ).toHaveLength(0);
    await context.close();
  });
});
