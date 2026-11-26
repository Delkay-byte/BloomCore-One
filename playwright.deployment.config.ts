import { defineConfig, devices } from "@playwright/test";

/**
 * Deployment-only smoke suite. It is NOT part of `npm run test:e2e`.
 *
 * These read-only checks require an explicitly authorised deployed origin.
 * Never point this suite at an unknown or shared environment. No mutation is
 * performed, but the target must still be an owner-authorised deployment or
 * isolated staging environment.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /deployment-smoke\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // No webServer: the target origin is supplied by MAACASH_CANONICAL_ORIGIN.
  // Tests skip when it is absent. The retired Render hostname is out of scope.
});
