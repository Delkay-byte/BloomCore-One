/**
 * Prepare the SQLite database used by Playwright end-to-end tests.
 *
 * It is deliberately separate from tests/test.db and from any development or
 * production database. Running it resets only tests/e2e.db.
 */
import { execFileSync } from "node:child_process";

const env = {
  ...process.env,
  DATABASE_URL: "file:../tests/e2e.db",
  JWT_SECRET: "e2e-secret-not-for-production",
  TURNSTILE_ENABLED: "false",
  MFA_ENFORCEMENT: "optional",
  RATE_LIMIT_HMAC_SECRET: "e2e-rate-limit-secret-32-bytes-long",
  MFA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

execFileSync("npx", ["prisma", "db", "push", "--force-reset", "--skip-generate"], {
  stdio: "inherit",
  env,
  shell: true,
});
execFileSync("npx", ["tsx", "scripts/seed-e2e.ts"], {
  stdio: "inherit",
  env,
  shell: true,
});
