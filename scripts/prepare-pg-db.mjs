/**
 * Prepare the disposable PostgreSQL database used by the integration suite.
 *
 * Fails closed: the target must be an explicitly confirmed, loopback, disposable
 * `maacash_test*` database. Production, Neon and Render targets are refused.
 * The script applies the real migration chain with `prisma migrate deploy`, then
 * reports only host and database name.
 */
import { execFileSync } from "node:child_process";
import { assertDisposablePostgresTarget } from "./pg-safety.mjs";
import { ensurePrismaClient } from "./ensure-prisma-client.mjs";

const target = assertDisposablePostgresTarget(process.env.PG_DATABASE_URL);

console.log(`Preparing disposable PostgreSQL database "${target.database}" on ${target.host}`);

// The PostgreSQL suite needs the PostgreSQL generated client.
ensurePrismaClient("postgresql");

execFileSync("npx", ["prisma", "migrate", "deploy", "--config", "prisma.pg.config.ts"], {
  stdio: "inherit",
  env: { ...process.env, PRISMA_CLI_DATABASE_URL: target.url },
  shell: true,
});
