import { expect, test, type Page } from "@playwright/test";
import {
  clearTabSession,
  loginAdmin,
  loginCollector,
  loginCustomer,
  loginPlatform,
  loginWorker,
  waitForHydration,
} from "./helpers";
import { restoreOperationalPolicy } from "./policy-restore";

/**
 * Post-write RSC session regression.
 *
 * A successful Server Action that revalidates a path must not bounce a valid
 * per-tab session to sign-in. The old failure was a second verification of the
 * same single-use proof during Next's re-render of the route.
 */

function watchBounces(page: Page): string[] {
  const bounces: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (
      url.includes("reason=tenant_unavailable") ||
      /\/(admin|worker|collector|customer|platform)\/login/.test(url)
    ) {
      bounces.push(url);
    }
  });
  return bounces;
}

test.describe("post-write RSC session", () => {
  test.afterAll(() => restoreOperationalPolicy());

  test("admin policy write keeps the tab, survives navigation and reload", async ({
    page,
  }) => {
    await loginAdmin(page);
    const bounces = watchBounces(page);
    await page.goto("/admin/policy");
    await expect(page.getByRole("heading", { name: "Operations Policy" })).toBeVisible();

    const shift = page.getByLabel("Require a shift before a day can close");
    const before = await shift.isChecked();
    await (before ? shift.uncheck() : shift.check());
    await page.getByRole("button", { name: /Save/ }).first().click();

    await page.waitForTimeout(1500);
    expect(bounces, bounces.join("\n")).toEqual([]);
    expect(page.url()).not.toMatch(/\/admin\/login/);
    await expect(page.getByRole("heading", { name: "Operations Policy" })).toBeVisible();

    // Subsequent client navigation keeps the session.
    await page.locator('a[href^="/admin/"]:visible').first().click();
    await page.waitForTimeout(700);
    expect(bounces, bounces.join("\n")).toEqual([]);
    await expect(page.getByRole("heading").first()).toBeVisible();

    // Full reload reads persisted server truth.
    await page.goto("/admin/policy");
    await expect(await shift.isChecked()).toBe(!before);
  });

  test("each role survives a post-login RSC navigation", async ({ browser }) => {
    const cases = [
      { login: loginWorker, prefix: "/worker/" },
      { login: loginCollector, prefix: "/collector/" },
      { login: loginCustomer, prefix: "/customer/" },
      { login: loginPlatform, prefix: "/platform/" },
    ] as const;
    for (const item of cases) {
      const context = await browser.newContext({
        baseURL: process.env.E2E_BASE_URL || "http://localhost:3100",
      });
      const page = await context.newPage();
      try {
        await item.login(page);
        const bounces = watchBounces(page);
        await waitForHydration(page, "body");
        const link = page.locator(`a[href^="${item.prefix}"]`).first();
        if (await link.count()) await link.click();
        else await page.reload();
        await page.waitForTimeout(700);
        expect(bounces, bounces.join("\n")).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });

  test("cleared and forged sessions still fail closed", async ({
    page,
    browser,
  }) => {
    await loginAdmin(page);
    await clearTabSession(page);
    await page.goto("/admin/dashboard");
    await expect(page).toHaveURL(/\/admin\/login/);

    const forged = await page.request.get("/api/audit", {
      headers: { "x-bloomcore-tab-proof": "invalid.invalid" },
    });
    expect([401, 403]).toContain(forged.status());

    // A fresh, unauthenticated browser context proves a speculative prefetch
    // receives no protected data rather than relying on this tab's cookies.
    const anonymous = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL || "http://localhost:3100",
    });
    try {
      const prefetch = await anonymous.request.get("/admin/dashboard", {
        headers: { "next-router-prefetch": "1" },
        maxRedirects: 0,
      });
      expect([404, 307, 302, 401, 403]).toContain(prefetch.status());
      const body = await prefetch.text();
      expect(body).not.toContain("Recent reports");
    } finally {
      await anonymous.close();
    }
  });

  test("five consecutive clean policy writes never bounce", async ({ browser }) => {
    for (let i = 0; i < 5; i++) {
      const context = await browser.newContext({
        baseURL: process.env.E2E_BASE_URL || "http://localhost:3100",
      });
      const page = await context.newPage();
      try {
        await loginAdmin(page);
        const bounces = watchBounces(page);
        await page.goto("/admin/policy");
        const shift = page.getByLabel("Require a shift before a day can close");
        await (await shift.isChecked() ? shift.uncheck() : shift.check());
        await page.getByRole("button", { name: /Save/ }).first().click();
        await page.waitForTimeout(1200);
        expect(bounces, `iteration ${i}: ${bounces.join("\n")}`).toEqual([]);
        expect(page.url()).not.toMatch(/\/admin\/login/);
      } finally {
        await context.close();
      }
    }
  });
});
