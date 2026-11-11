import { expect, test } from "@playwright/test";
import { loginCollector, waitForHydration } from "./helpers";

/**
 * Offline status regression coverage.
 *
 * These tests prove the displayed state follows the real connection state. They
 * do not create financial records and do not require an offline passphrase.
 */

async function openCollectorDashboard(page: import("@playwright/test").Page) {
  // Simulate browser connectivity without blocking the network: an unprepared
  // device is redirected away from the dashboard when the network is actually
  // cut, which would test the guard rather than the status logic.
  await page.addInitScript(() => {
    let online = true;
    Object.defineProperty(Navigator.prototype, "onLine", {
      configurable: true,
      get: () => online,
    });
    (window as unknown as { __setTestOnline: (value: boolean) => void }).__setTestOnline = (
      value: boolean
    ) => {
      online = value;
    };
  });
  await loginCollector(page);
  await expect(page.getByRole("button", { name: /Register New Customer/i })).toBeVisible({
    timeout: 30_000,
  });
  await waitForHydration(page, '[aria-label="Workspace status"]');
}

async function setNavigatorOnline(
  page: import("@playwright/test").Page,
  online: boolean
) {
  // Change only the browser's reported state. Dispatching a synthetic
  // `offline` event on an unprepared device would trigger the fail-closed
  // session guard and navigate to /login, which is a different behaviour.
  await page.evaluate((value) => {
    (
      window as unknown as { __setTestOnline: (next: boolean) => void }
    ).__setTestOnline(value);
  }, online);
}

async function dispatchOnline(page: import("@playwright/test").Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

async function dispatchFocus(page: import("@playwright/test").Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

async function dispatchVisibility(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test.describe("offline status transitions", () => {
  test("does not show Offline Active or a stale offline banner while online", async ({
    page,
  }) => {
    await openCollectorDashboard(page);

    const status = page.locator('[aria-label="Workspace status"]');
    await expect(status.getByText("Online", { exact: true })).toBeVisible();
    await expect(status.getByText("Offline Active", { exact: true })).toHaveCount(0);

    // Simulate network loss. The browser must report offline, not a prepared
    // workspace claiming to be online.
    await setNavigatorOnline(page, false);
    await dispatchFocus(page);
    await expect(status.getByText("Offline", { exact: true })).toBeVisible();

    // Returning connectivity must replace the offline state without a reload.
    await setNavigatorOnline(page, true);
    await dispatchFocus(page);
    await expect(status.getByText("Online", { exact: true })).toBeVisible();
    await expect(page.getByText(/You are working offline/i)).toHaveCount(0);
    await expect(status.getByText("Offline Active", { exact: true })).toHaveCount(0);
  });

  test("does not show a false attention warning with an empty queue", async ({ page }) => {
    await openCollectorDashboard(page);

    await expect(page.getByText(/collections? need attention/i)).toHaveCount(0);
    await expect(page.getByText(/need attention/i)).toHaveCount(0);

    const offlinePanel = page.getByRole("region", { name: "Offline records" });
    await expect(offlinePanel).toBeVisible();
    await expect(offlinePanel.getByText(/Saved on this device · scoped to your account/i)).toBeVisible();
  });

  test("customer registration modal uses a translucent backdrop and keeps labels", async ({
    page,
  }) => {
    await openCollectorDashboard(page);
    await page.getByRole("button", { name: /Register New Customer/i }).click();

    const dialog = page.getByRole("dialog", { name: "Register New Customer" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/Full Name/i)).toBeVisible();
    await expect(dialog.getByLabel(/Phone/i)).toBeVisible();
    await expect(dialog.getByLabel(/Daily Contribution/i)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();

    const backdrop = page.locator("div.fixed.inset-0").filter({ has: dialog });
    await expect(backdrop).toHaveClass(/bg-slate-950\/60/);
  });
});

test.describe("focus and visibility connectivity", () => {
  const status = (page: import("@playwright/test").Page) =>
    page.locator('[aria-label="Workspace status"]');

  test("focus while offline stays Offline", async ({ page }) => {
    await openCollectorDashboard(page);
    await setNavigatorOnline(page, false);
    await dispatchFocus(page);
    await expect(status(page).getByText("Offline", { exact: true })).toBeVisible();

    await dispatchFocus(page);
    await expect(status(page).getByText("Offline", { exact: true })).toBeVisible();
    await expect(status(page).getByText("Online", { exact: true })).toHaveCount(0);
  });

  test("visibility restoration while offline stays Offline", async ({ page }) => {
    await openCollectorDashboard(page);
    await setNavigatorOnline(page, false);
    await dispatchVisibility(page);
    await expect(status(page).getByText("Offline", { exact: true })).toBeVisible();

    await dispatchVisibility(page);
    await expect(status(page).getByText("Offline", { exact: true })).toBeVisible();
    await expect(status(page).getByText("Online", { exact: true })).toHaveCount(0);
  });

  test("genuine reconnection shows Online", async ({ page }) => {
    await openCollectorDashboard(page);
    await setNavigatorOnline(page, false);
    await dispatchFocus(page);
    await expect(status(page).getByText("Offline", { exact: true })).toBeVisible();

    await setNavigatorOnline(page, true);
    await dispatchOnline(page);
    await expect(status(page).getByText("Online", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  });

  test("focus while the backend is unreachable does not verify the session", async ({
    page,
  }) => {
    await openCollectorDashboard(page);
    await page.evaluate(() => {
      const holder = window as unknown as {
        __originalFetch?: typeof fetch;
      };
      holder.__originalFetch = holder.__originalFetch ?? window.fetch;
      const original = holder.__originalFetch;
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes("/api/health")
          ? Promise.reject(new Error("backend down"))
          : original(input, init)) as typeof fetch;
    });

    await dispatchFocus(page);
    await expect(
      status(page).getByText("Server unreachable", { exact: true })
    ).toBeVisible({ timeout: 30_000 });

    await page.evaluate(() => {
      const holder = window as unknown as { __originalFetch?: typeof fetch };
      if (holder.__originalFetch) window.fetch = holder.__originalFetch;
    });
    await dispatchFocus(page);
    await expect(status(page).getByText("Online", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  });
});
