import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginWorker, waitForHydration } from "./helpers";

/**
 * Responsive and draft-state checks. These are local assertions and run in the
 * normal suite. Screenshots are opt-in: set CAPTURE_EVIDENCE=1 when an artifact
 * is needed, e.g. CAPTURE_EVIDENCE=1 npx playwright test e2e/maacash-evidence.spec.ts
 */

const WIDTHS = [360, 390, 768, 1280];
const OUTPUT = path.resolve(
  __dirname,
  "../docs/reports/evidence/maacash-draft-login-landing"
);

function shotPath(name: string, width: number) {
  return path.join(OUTPUT, `${name}-${width}.png`);
}

async function capture(page: Page, name: string, width: number, fullPage = true) {
  if (!process.env.CAPTURE_EVIDENCE) return;
  await page.screenshot({ path: shotPath(name, width), fullPage });
}

test.describe("MaaCash visual evidence", () => {
  test.beforeAll(() => {
    if (process.env.CAPTURE_EVIDENCE) fs.mkdirSync(OUTPUT, { recursive: true });
  });

  for (const width of WIDTHS) {
    test(`landing and sign-in at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });

      await page.goto("/");
      await page.waitForTimeout(900);
      const landingOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      );
      expect(landingOverflow).toBeLessThanOrEqual(1);
      await capture(page, "landing", width);
      await capture(page, "landing-hero", width, false);

      await page.goto("/login");
      await page.getByRole("heading", { name: "Who are you?" }).waitFor();
      await capture(page, "login-roles", width);

      for (const role of ["momo", "susu", "customer"]) {
        await page.goto(`/login?role=${role}`);
        await waitForHydration(page, "#identifier");
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth
        );
        expect(overflow).toBeLessThanOrEqual(1);
        await capture(page, `login-${role}`, width);
      }
    });
  }

  test("draft list, saving, saved and restored states at 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginWorker(page);
    await page.goto("/worker/dashboard");
    await waitForHydration(page, "text=Recent reports");
    await capture(page, "draft-list", 1280);

    await page.goto("/worker/daily/e2e-daily-draft");
    await waitForHydration(page, "#opening-cash");
    await page.locator("#opening-cash").fill("64.50");
    await page.locator("#opening-float").fill("120.00");
    await page.locator("#reconciliation-note").fill("Evidence capture draft.");

    await capture(page, "draft-saving", 1280);

    await page.getByRole("button", { name: "Save as Draft" }).click();
    await expect(page.getByText(/Draft saved successfully/).first()).toBeVisible({
      timeout: 30_000,
    });
    await capture(page, "draft-saved", 1280);

    await page.reload();
    await waitForHydration(page, "#opening-cash");
    await expect(page.locator("#opening-cash")).toHaveValue("64.5");
    await capture(page, "draft-restored", 1280);

    // Failure state: take the browser offline and keep the typed values.
    await page.context().setOffline(true);
    await page.locator("#opening-cash").fill("65.00");
    await page.getByRole("button", { name: "Save as Draft" }).click();
    await expect(page.getByText(/We couldn't save your draft/).first()).toBeVisible({
      timeout: 30_000,
    });
    await capture(page, "draft-save-failure", 1280);
  });
});
