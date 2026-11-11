import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests for Zeli and the analytics workspace.
 *
 * `npm run test:e2e` prepares a dedicated SQLite database (tests/e2e.db) with
 * two synthetic tenants, then starts the app on port 3100. CI may point the
 * suite at hosted staging with E2E_BASE_URL; no production target is used.
 */
const baseURL = process.env.E2E_BASE_URL || "http://localhost:3100";

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
      // The mobile project owns the Android-sized shell tests and the offline
      // status spec, so CI runs each exactly once.
      testIgnore: /mobile\.spec\.ts|maacash-offline-status\.spec\.ts/,
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      testMatch: /(mobile|maacash-offline-status)\.spec\.ts/,
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run build && npx next start -p 3100",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 360_000,
        env: {
          DATABASE_URL: "file:../tests/e2e.db",
          JWT_SECRET: "e2e-secret-not-for-production",
          TURNSTILE_ENABLED: "false",
          MFA_ENFORCEMENT: "optional",
          RATE_LIMIT_HMAC_SECRET: "e2e-rate-limit-secret-32-bytes-long",
          MFA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
});
