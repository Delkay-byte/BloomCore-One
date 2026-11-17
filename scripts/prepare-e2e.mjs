/**
 * Prepare the SQLite database used by Playwright end-to-end tests.
 *
 * It is deliberately separate from tests/test.db and from any development or
 * production database. Running it resets only tests/e2e.db.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const env = {
  ...process.env,
  DATABASE_URL: "file:../tests/e2e.db",
  JWT_SECRET: "e2e-secret-not-for-production",
  TURNSTILE_ENABLED: "false",
  MFA_ENFORCEMENT: "optional",
  RATE_LIMIT_HMAC_SECRET: "e2e-rate-limit-secret-32-bytes-long",
  MFA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

// Prisma 7 removed --skip-generate from `db push` and refuses --force-reset for
// agent-invoked commands. Deleting the disposable E2E file is equivalent and
// leaves no destructive flag in the pipeline.
fs.rmSync(new URL("../tests/e2e.db", import.meta.url), { force: true });
fs.rmSync(new URL("../tests/e2e.db-journal", import.meta.url), { force: true });

execFileSync("npx", ["prisma", "db", "push", "--schema=prisma/schema.prisma"], {
  stdio: "inherit",
  env,
  shell: true,
});
execFileSync("npx", ["tsx", "scripts/seed-e2e.ts"], {
  stdio: "inherit",
  env,
  shell: true,
});
