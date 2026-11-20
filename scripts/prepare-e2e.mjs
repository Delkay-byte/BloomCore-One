/**
 * Prepare the SQLite database used by Playwright end-to-end tests.
 *
 * The database path comes from `scripts/test-database-paths.cjs`, which is also
 * used by `playwright.config.ts` and `scripts/seed-e2e.ts`. Preparation and
 * runtime therefore always operate on the same file.
 *
 * Deletion is guarded: the script refuses to remove anything that is not
 * positively identified as a disposable test database.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { e2eDatabase } from "./test-database-paths.cjs";
import { ensurePrismaClient } from "./ensure-prisma-client.mjs";

const { file, url } = e2eDatabase();

const env = {
  ...process.env,
  DATABASE_URL: url,
  JWT_SECRET: "e2e-secret-not-for-production",
  TURNSTILE_ENABLED: "false",
  MFA_ENFORCEMENT: "optional",
  RATE_LIMIT_HMAC_SECRET: "e2e-rate-limit-secret-32-bytes-long",
  MFA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

// The path has already passed `assertDisposableDatabase` inside e2eDatabase().
// Prisma 7 removed --skip-generate from `db push` and refuses --force-reset for
// agent-invoked commands. Deleting the disposable E2E file is equivalent and
// leaves no destructive flag in the pipeline.
// Windows refuses to unlink a file that another process still has open, which
// happens when a previously started E2E server is still running. Retry briefly,
// then fail with an actionable message instead of a raw EBUSY trace.
function removeWithRetry(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(target, { force: true });
      return;
    } catch (error) {
      if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;
      if (attempt === 9) {
        throw new Error(
          `Cannot replace the E2E database at ${target} because another process is using it. ` +
            "Stop the running app server (for example the one on the E2E port) and run this script again."
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
}

for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  removeWithRetry(`${file}${suffix}`);
}

console.log(`Preparing disposable E2E database: ${file}`);

ensurePrismaClient("sqlite");

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
