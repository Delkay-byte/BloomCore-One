import { expect, test } from "@playwright/test";
import {
  ADMIN_A,
  ADMIN_B,
  clearTabSession,
  loginAdmin,
  loginCollector,
  logoutTab,
  pageJson,
} from "./helpers";

/**
 * Real-browser acceptance for independent tab sessions.
 *
 * All pages share one BrowserContext (one browser profile), which is exactly
 * the case where cookies would otherwise leak authentication between tabs.
 */

test.describe("independent tab sessions", () => {
  test("two tabs authenticate as different administrators and refresh independently", async ({
    page,
    context,
  }) => {
    await loginAdmin(page, ADMIN_A);
    const tabAUrl = page.url();

    const tabB = await context.newPage();
    // A clean tab receives no mapping, even though the same browser profile has
    // an authenticated tab open.
    await tabB.goto("/admin/dashboard");
    await expect(tabB).toHaveURL(/\/login/);

    await loginAdmin(tabB, ADMIN_B);

    const meA = await pageJson<{ userId: string; email: string }>(
      page,
      "/api/auth/me?module=admin"
    );
    const meB = await pageJson<{ userId: string; email: string }>(
      tabB,
      "/api/auth/me?module=admin"
    );
    expect(meA.userId).toBe("e2e-user-a");
    expect(meB.userId).toBe("e2e-user-b");
    expect(meA.email).toBe(ADMIN_A);
    expect(meB.email).toBe(ADMIN_B);

    await page.reload();
    await tabB.reload();
    expect(
      (await pageJson<{ userId: string }>(page, "/api/auth/me?module=admin")).userId
    ).toBe("e2e-user-a");
    expect(
      (await pageJson<{ userId: string }>(tabB, "/api/auth/me?module=admin")).userId
    ).toBe("e2e-user-b");

    // The copied URL itself carries no credential.
    expect(tabAUrl).not.toMatch(/token|session=|jwt/i);
    for (const cookie of await context.cookies()) {
      expect(cookie.name).not.toMatch(/^bik-(admin|worker|collector|customer|platform)-session$/);
    }
  });

  test("a forced worker stop fails closed without cross-tab leakage", async ({
    page,
    context,
  }) => {
    await loginAdmin(page, ADMIN_A);
    const cdp = await context.newCDPSession(page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await page.reload();

    // The forced stop may leave this tab unauthenticated until it signs in
    // again. It must never adopt another tab's identity or a cookie.
    if (page.url().includes("/admin/dashboard")) {
      expect(
        (await pageJson<{ userId: string }>(page, "/api/auth/me?module=admin")).userId
      ).toBe("e2e-user-a");
    } else {
      await expect(page).toHaveURL(/\/login/);
      expect(
        (await context.cookies()).filter((c) =>
          /^bik-(admin|worker|collector|customer|platform)-session$/.test(c.name)
        )
      ).toHaveLength(0);
    }

    const fresh = await context.newPage();
    await fresh.goto("/admin/dashboard");
    await expect(fresh).toHaveURL(/\/login/);
  });

  test("logging out one tab leaves the other authenticated", async ({
    page,
    context,
  }) => {
    await loginAdmin(page, ADMIN_A);
    const tabB = await context.newPage();
    await loginAdmin(tabB, ADMIN_B);

    expect(await logoutTab(page)).toBe(200);
    await page.goto("/admin/dashboard");
    await expect(page).toHaveURL(/\/login/);

    await tabB.goto("/admin/dashboard");
    await expect(tabB).toHaveURL(/\/admin\/dashboard/);
    const meB = await pageJson<{ userId: string }>(
      tabB,
      "/api/auth/me?module=admin"
    );
    expect(meB.userId).toBe("e2e-user-b");

    // The revoked tab cannot restore its session by reloading.
    await page.reload();
    await expect(page).toHaveURL(/\/login/);
  });

  test("copied authenticated URL and opener tab do not inherit a session", async ({
    page,
    context,
  }) => {
    await loginAdmin(page, ADMIN_A);
    const authenticatedUrl = page.url();

    const copied = await context.newPage();
    await copied.goto(authenticatedUrl);
    await expect(copied).toHaveURL(/\/login/);

    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.evaluate(() => {
        window.open("/admin/dashboard", "_blank");
      }),
    ]);
    await popup.waitForLoadState();
    await expect(popup).toHaveURL(/\/login/);

    // Tab A is unchanged by either attempt.
    expect(
      (await pageJson<{ userId: string }>(page, "/api/auth/me?module=admin")).userId
    ).toBe("e2e-user-a");
  });

  test("different roles coexist with isolated permissions and tenant scope", async ({
    page,
    context,
  }) => {
    await loginAdmin(page, ADMIN_A);
    const collectorTab = await context.newPage();
    await loginCollector(collectorTab);

    const adminMe = await pageJson<{ role: string; tenant?: { id: string } }>(
      page,
      "/api/auth/me?module=admin"
    );
    const collectorMe = await pageJson<{
      role: string;
      modules?: string[];
      tenant?: { id: string };
    }>(collectorTab, "/api/auth/me?module=susu");

    expect(adminMe.role).toBe("admin");
    expect(collectorMe.role).toBe("collector");
    expect(collectorMe.modules).toContain("susu");
    expect(adminMe.tenant?.id).toBe("e2e-tenant-a");
    expect(collectorMe.tenant?.id).toBe("e2e-tenant-a");

    // A collector token cannot open the admin surface.
    const crossRole = await pageJson<{ error?: string }>(
      collectorTab,
      "/api/auth/me?module=admin"
    );
    expect(crossRole.error).toBe("Not authenticated");

    await collectorTab.goto("/admin/dashboard");
    await expect(collectorTab).toHaveURL(/\/login|\/unauthorized/);

    // Clearing the collector tab does not disturb the admin tab.
    await clearTabSession(collectorTab);
    expect(
      (await pageJson<{ userId: string }>(page, "/api/auth/me?module=admin")).userId
    ).toBe("e2e-user-a");
  });
});
