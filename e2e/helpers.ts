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
export const COLLECTOR = "e2e-collector@test.local";
export const PASSWORD = "E2ePass123!";

export async function loginAdmin(page: Page, email = ADMIN_A) {
  await page.goto("/admin/login");
  await waitForHydration(page, "#email");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/admin\/(dashboard|first-login)/, { timeout: 30_000 });
  // The login client hands the session to this tab's service worker before
  // navigating. Wait for the authenticated shell to confirm that handoff.
  await page.waitForTimeout(750);
}

export async function loginCollector(page: Page, email = COLLECTOR) {
  await page.goto("/login");
  await waitForHydration(page, "text=Susu Collector");
  await page.getByRole("button", { name: /Susu Collector/ }).click();
  await waitForHydration(page, "#identifier");
  await page.locator("#identifier").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/collector\/(dashboard|first-login)/, { timeout: 30_000 });
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

/** Clear only this tab's session mapping; other tabs in the context keep theirs. */
export async function clearTabSession(page: Page) {
  if (page.url() === "about:blank") return;
  await page
    .evaluate(async () => {
      navigator.serviceWorker.controller?.postMessage({ type: "clear" });
      sessionStorage.clear();
      await new Promise((resolve) => setTimeout(resolve, 250));
    })
    .catch(() => undefined);
}

export async function resetSession(page: Page) {
  await clearTabSession(page);
  await page.context().clearCookies();
  await page.goto("/admin/login");
}

/** Fetch through the page so the service worker adds this tab's session. */
export async function pageFetch(
  page: Page,
  path: string
): Promise<{ status: number; body: string }> {
  return page.evaluate(async (target) => {
    const response = await fetch(target, { cache: "no-store" });
    return { status: response.status, body: await response.text() };
  }, path);
}

export async function pageJson<T = Record<string, unknown>>(
  page: Page,
  path: string
): Promise<T> {
  const response = await pageFetch(page, path);
  return JSON.parse(response.body) as T;
}

/** Revoke this tab's server session through its own authenticated request. */
export async function logoutTab(page: Page) {
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/auth/logout", { method: "POST" });
    return response.status;
  });
  await clearTabSession(page);
  return status;
}

export async function sendZeliMessage(page: Page, message: string) {
  await waitForHydration(page, "#zeli-input");
  await page.locator("#zeli-input").fill(message);
  await page.getByRole("button", { name: "Send" }).click();
}
