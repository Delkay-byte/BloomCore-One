import { expect, type Page } from "@playwright/test";
import { test } from "@playwright/test";
import {
  loginWorker,
  pageJson,
  waitForHydration,
} from "./helpers";

/**
 * MoMo acceptance.
 *
 * Covers the reported failure surface (`/api/auth/me?module=momo`), the
 * server-resolved worker workspace, and all three reconciliation outcomes. The
 * tests run against the isolated E2E database only.
 */

async function openDailyAccount(page: Page, id: string) {
  await page.goto(`/worker/daily/${id}`);
  await waitForHydration(page, "#opening-cash");
}

async function fillMoney(page: Page, id: string, value: number) {
  await page.locator(id).fill(String(value));
}

async function submitFromReview(page: Page) {
  await page.getByRole("button", { name: "Review and submit" }).click();
  const dialog = page.getByRole("dialog", { name: "Submit today's account?" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectSubmitted(page: Page) {
  await expect(
    page.getByRole("dialog", { name: "Account submitted" })
  ).toBeVisible({ timeout: 30_000 });
  await page.waitForURL(/\/worker\/dashboard/, { timeout: 30_000 });
}

test.describe("MoMo worker workspace", () => {
  test("resolves the worker session on the server and keeps auth responses uncached", async ({
    page,
    context,
  }) => {
    const meRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/auth/me")) meRequests.push(request.url());
    });

    await loginWorker(page);

    // First paint is server-resolved: the agent and assigned branch are on
    // screen without waiting for a client auth lookup.
    await expect(
      page.getByRole("heading", { name: /E2E MoMo Agent/ })
    ).toBeVisible();
    await expect(page.getByText("E2E Accra Branch").first()).toBeVisible();

    // The failing endpoint path must not be fetched by the workspace itself.
    expect(
      meRequests.filter((url) => url.includes("/api/auth/me?module=momo"))
    ).toHaveLength(0);

    const me = await pageJson<{
      userId: string;
      role: string;
      modules?: string[];
      locationId?: string;
      tenant?: { id: string; momoEnabled: boolean };
    }>(page, "/api/auth/me?module=momo");
    expect(me.userId).toBe("e2e-worker-user");
    expect(me.role).toBe("worker");
    expect(me.modules).toContain("momo");
    expect(me.locationId).toBe("e2e-location-a");
    expect(me.tenant?.id).toBe("e2e-tenant-a");
    expect(me.tenant?.momoEnabled).toBe(true);

    const cacheControl = await page.evaluate(async () => {
      const response = await fetch("/api/auth/me?module=momo", {
        cache: "no-store",
      });
      return response.headers.get("cache-control");
    });
    expect(cacheControl).toContain("no-store");

    // The same URL in a fresh tab carries no credential.
    const fresh = await context.newPage();
    await fresh.goto("/api/auth/me?module=momo");
    await expect(fresh.getByText("Not authenticated")).toBeVisible();

    // A worker tab cannot read another module's identity.
    for (const otherModule of ["admin", "susu", "customer"]) {
      const other = await pageJson<{ error?: string }>(
        page,
        `/api/auth/me?module=${otherModule}`
      );
      expect(other.error).toBe("Not authenticated");
    }

    // Refresh keeps the same tab-scoped identity.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /E2E MoMo Agent/ })
    ).toBeVisible();
    expect(
      (await pageJson<{ userId: string }>(page, "/api/auth/me?module=momo"))
        .userId
    ).toBe("e2e-worker-user");
  });

  test("opens today's account and submits a balanced reconciliation", async ({
    page,
  }) => {
    await loginWorker(page);

    const start = page.getByRole("button", { name: "Start daily account" });
    const resume = page.getByRole("link", { name: /Continue account/ });
    if (await start.isVisible().catch(() => false)) {
      await start.click();
    } else {
      await resume.click();
    }
    await page.waitForURL(/\/worker\/daily\//, { timeout: 30_000 });
    await waitForHydration(page, "#opening-cash");

    await fillMoney(page, "#opening-cash", 100);
    await fillMoney(page, "#opening-float", 500);
    await fillMoney(page, "#closing-cash", 600);
    await fillMoney(page, "#closing-float", 0);

    await expect(page.getByText("Balanced", { exact: true }).first()).toBeVisible();

    const dialog = await submitFromReview(page);
    await expect(dialog.getByText("Balanced", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Submit account" }).click();
    await expectSubmitted(page);

    await expect(page.getByText("Today's account has been submitted")).toBeVisible();
  });

  test("submits a positive difference without forcing a balance", async ({
    page,
  }) => {
    await loginWorker(page);
    await openDailyAccount(page, "e2e-daily-positive");

    await fillMoney(page, "#opening-cash", 100);
    await fillMoney(page, "#opening-float", 500);
    await fillMoney(page, "#closing-cash", 650);
    await fillMoney(page, "#closing-float", 0);

    await expect(page.getByText("Positive difference").first()).toBeVisible();
    const dialog = await submitFromReview(page);
    await expect(
      dialog.getByText("Positive difference", { exact: true })
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Submit account" }).click();
    await expectSubmitted(page);
  });

  test("blocks a shortage submission until the worker explains it", async ({
    page,
  }) => {
    await loginWorker(page);
    await openDailyAccount(page, "e2e-daily-shortage");

    await fillMoney(page, "#opening-cash", 100);
    await fillMoney(page, "#opening-float", 500);
    await fillMoney(page, "#closing-cash", 550);
    await fillMoney(page, "#closing-float", 0);

    await expect(
      page.getByText("Shortage — Investigation Required")
    ).toBeVisible();

    const dialog = await submitFromReview(page);
    await expect(
      dialog.getByText("Explain the shortage in section 06 before submitting.")
    ).toBeVisible();
    const submit = dialog.getByRole("button", { name: "Submit account" });
    await expect(submit).toBeDisabled();

    // The counted figures stay exactly as entered.
    await expect(page.locator("#closing-cash")).toHaveValue("550");
    await page
      .locator("#reconciliation-note")
      .fill("Cash removed for an unrecorded supplier payment; receipt pending.");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expectSubmitted(page);

    await expect(
      page.getByText(/Short .*explanation required/).first()
    ).toBeVisible();
  });

  test("persists a draft across a refresh", async ({ page }) => {
    await loginWorker(page);
    await page.goto("/worker/dashboard");
    await waitForHydration(page, "text=Recent reports");

    // Use a dedicated seeded draft and save without submitting.
    await openDailyAccount(page, "e2e-daily-draft");
    await fillMoney(page, "#opening-cash", 77);
    await fillMoney(page, "#opening-float", 123);
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText(/Draft saved successfully/).first()).toBeVisible();

    await page.reload();
    await waitForHydration(page, "#opening-cash");
    await expect(page.locator("#opening-cash")).toHaveValue("77");
    await expect(page.locator("#opening-float")).toHaveValue("123");
  });
});
