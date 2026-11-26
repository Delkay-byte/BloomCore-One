/**
 * Prepare the disposable SQLite database used by the unit/integration suite.
 *
 * The path is fixed by `scripts/test-database-paths.cjs` (repo-local
 * `tests/test.db`) so the Vitest environment and any manual inspection agree on
 * one file. The database is disposable: no development or production database
 * can be reached through this script.
 */
import { execFileSync } from "node:child_process";
import { unitDatabase } from "./test-database-paths.cjs";
import { ensurePrismaClient } from "./ensure-prisma-client.mjs";

const { file, url } = unitDatabase();

console.log(`Preparing disposable unit database: ${file}`);

ensurePrismaClient("sqlite");

execFileSync("npx", ["prisma", "db", "push", "--schema=prisma/schema.prisma"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url },
  shell: true,
});
