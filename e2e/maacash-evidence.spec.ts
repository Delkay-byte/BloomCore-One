import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginWorker, waitForHydration } from "./helpers";

/**
 * Visual evidence capture. Run explicitly:
 *   CAPTURE_EVIDENCE=1 npx playwright test e2e/maacash-evidence.spec.ts
 *
 * The spec also checks the four required widths for horizontal overflow before
 * writing a screenshot.
 */

const WIDTHS = [360, 390, 768, 1280];
const OUTPUT = path.resolve(
  __dirname,
  "../docs/reports/evidence/maacash-draft-login-landing"
);

function shotPath(name: string, width: number) {
  return path.join(OUTPUT, `${name}-${width}.png`);
}

test.describe("MaaCash visual evidence", () => {
  test.skip(!process.env.CAPTURE_EVIDENCE, "Set CAPTURE_EVIDENCE=1 to capture screenshots");

  test.beforeAll(() => {
    fs.mkdirSync(OUTPUT, { recursive: true });
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
      await page.screenshot({ path: shotPath("landing", width), fullPage: true });
      await page.screenshot({ path: shotPath("landing-hero", width), fullPage: false });

      await page.goto("/login");
      await page.getByRole("heading", { name: "Who are you?" }).waitFor();
      await page.screenshot({ path: shotPath("login-roles", width), fullPage: true });

      for (const role of ["momo", "susu", "customer"]) {
        await page.goto(`/login?role=${role}`);
        await waitForHydration(page, "#identifier");
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth
        );
        expect(overflow).toBeLessThanOrEqual(1);
        await page.screenshot({ path: shotPath(`login-${role}`, width), fullPage: true });
      }
    });
  }

  test("draft list, saving, saved and restored states at 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginWorker(page);
    await page.goto("/worker/dashboard");
    await waitForHydration(page, "text=Recent reports");
    await page.screenshot({ path: shotPath("draft-list", 1280), fullPage: true });

    await page.goto("/worker/daily/e2e-daily-draft");
    await waitForHydration(page, "#opening-cash");
    await page.locator("#opening-cash").fill("64.50");
    await page.locator("#opening-float").fill("120.00");
    await page.locator("#reconciliation-note").fill("Evidence capture draft.");

    await page.screenshot({ path: shotPath("draft-saving", 1280), fullPage: true });

    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText(/Draft saved successfully/).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({ path: shotPath("draft-saved", 1280), fullPage: true });

    await page.reload();
    await waitForHydration(page, "#opening-cash");
    await expect(page.locator("#opening-cash")).toHaveValue("64.5");
    await page.screenshot({ path: shotPath("draft-restored", 1280), fullPage: true });

    // Failure state: take the browser offline and keep the typed values.
    await page.context().setOffline(true);
    await page.locator("#opening-cash").fill("65.00");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText(/We couldn't save your draft/).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({ path: shotPath("draft-save-failure", 1280), fullPage: true });
  });
});
