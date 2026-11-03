import type { Page } from "@playwright/test";

/** Wait until React has hydrated the subtree that owns the selector. */
export async function waitForHydration(page: Page, selector: string) {
  await page.locator(selector).first().waitFor({ state: "visible", timeout: 60_000 });
  // Give the client bundle a moment to attach handlers before invoking a
  // server action. The server remains the authorization boundary.
  await page.waitForTimeout(700);
}

export const ADMIN_A = "e2e-admin-a@test.local";
export const ADMIN_B = "e2e-admin-b@test.local";
export const PLATFORM = "e2e-platform@test.local";
export const PASSWORD = "E2ePass123!";

export async function loginAdmin(page: Page, email = ADMIN_A) {
  await page.goto("/admin/login");
  await waitForHydration(page, "#email");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/admin\/(dashboard|first-login)/, { timeout: 30_000 });
  // The app marks the tab during login. Playwright sometimes navigates before
  // the client helper runs, so set the same tab-scoped marker explicitly. The
  // server cookie remains the real authorization boundary.
  await page.evaluate(() => sessionStorage.setItem("bik-tab-session", "1"));
  await page.waitForTimeout(750);
}

export async function loginPlatform(page: Page) {
  await page.goto("/platform/login");
  await waitForHydration(page, "#email");
  await page.locator("#email").fill(PLATFORM);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/platform\/(dashboard|first-login)/, { timeout: 30_000 });
  await page.waitForTimeout(750);
}

export async function resetSession(page: Page) {
  await page.context().clearCookies();
  await page.evaluate(() => sessionStorage.clear());
  await page.goto("/admin/login");
}

export async function sendZeliMessage(page: Page, message: string) {
  await waitForHydration(page, "#zeli-input");
  await page.locator("#zeli-input").fill(message);
  await page.getByRole("button", { name: "Send" }).click();
}
