import { defineConfig, devices } from "@playwright/test";
import { e2eDatabase } from "./scripts/test-database-paths.cjs";
import { e2eServerEnv } from "./scripts/e2e-env.cjs";

/**
 * Browser tests for Zeli and the analytics workspace.
 *
 * `npm run test:e2e` prepares a dedicated SQLite database with two synthetic
 * tenants, then starts the app on port 3100. The database path is resolved by
 * `scripts/test-database-paths.cjs`, which is also used by the preparation
 * script, so preparation and runtime can never disagree about the file.
 *
 * CI may point the suite at hosted staging with E2E_BASE_URL; no production
 * target is used.
 */
const baseURL = process.env.E2E_BASE_URL || "http://localhost:3100";
const e2eDbUrl = e2eDatabase().url;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // The mobile project owns the Android-sized shell tests, the offline status spec
      // and the phone-width sign-in card check. Its narrow layout hides the marketing
      // panel that some desktop login assertions read, so those stay desktop-only.
      testIgnore:
        /mobile\.spec\.ts|maacash-offline-status\.spec\.ts|maacash-auth-security\.spec\.ts|deployment-smoke\.spec\.ts/,
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      // `maacash-coming-soon` and `maacash-login-mobile` are the phone-width checks for
      // the notices and the four sign-in cards.
      testMatch:
        /(mobile|maacash-offline-status|maacash-auth-security|maacash-coming-soon|maacash-login-mobile)\.spec\.ts/,
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run build && npx next start -p 3100",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 360_000,
        // Provider credentials are blanked here, so the browser suite can never
        // reach a live payment, messaging or AI provider.
        env: e2eServerEnv(e2eDbUrl),
      },
});
