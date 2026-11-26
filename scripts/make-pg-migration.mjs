/**
 * Generates the PostgreSQL migration for a schema change, then leaves the file
 * in prisma/migrations for review.
 *
 * Prisma cannot diff straight from a migrations directory without a shadow
 * database, so this applies the existing chain to a throwaway database first and
 * diffs that database against prisma/schema-pg.prisma.
 *
 * Usage: node scripts/make-pg-migration.mjs <migration-directory-name>
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./test-database-paths.cjs";

const PRISMA_CLI = path.join(repoRoot, "node_modules", "prisma", "build", "index.js");
const name = process.argv[2];
if (!name || !/^[0-9]{8}_[a-z0-9_]+$/.test(name)) {
  console.error("Usage: node scripts/make-pg-migration.mjs <YYYYMMDD_snake_name>");
  process.exit(1);
}

const base = process.env.PG_ADMIN_URL;
if (!base) {
  console.error("PG_ADMIN_URL is required, e.g. postgresql://postgres@127.0.0.1:55441");
  process.exit(1);
}
if (!/127\.0\.0\.1|localhost/.test(base)) {
  console.error("Refusing to run against a non-local PostgreSQL host.");
  process.exit(1);
}

const dbName = `maacash_gen_${Date.now()}`;
const url = `${base.replace(/\/$/, "")}/${dbName}`;
const config = path.join(repoRoot, "pg.gen.config.mjs");

function run(args, extraEnv = {}) {
  // The Prisma CLI is executed through node directly: a shell would mangle the
  // backslashes and spaces in this repository's path.
  return execFileSync(process.execPath, [PRISMA_CLI, ...args], {
    cwd: repoRoot,
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, PRISMA_CLI_DATABASE_URL: url, ...extraEnv },
  });
}

function psql(statement, database) {
  execFileSync(
    process.env.PSQL_BIN ?? "psql",
    ["-h", "127.0.0.1", "-p", new URL(base).port, "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", "-c", statement],
    { stdio: "pipe", encoding: "utf8", env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? "" } }
  );
}

fs.writeFileSync(
  config,
  `import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema-pg.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.PRISMA_CLI_DATABASE_URL ?? "" },
});
`
);

try {
  psql(`CREATE DATABASE "${dbName}"`, "postgres");
  run(["migrate", "deploy", "--config", config]);

  const sql = run([
    "migrate",
    "diff",
    "--config",
    config,
    "--from-config-datasource",
    "--to-schema",
    "prisma/schema-pg.prisma",
    "--script",
  ]);

  if (!sql.trim()) {
    console.log("No drift: the migration chain already matches prisma/schema-pg.prisma.");
    process.exit(0);
  }

  const target = path.join(repoRoot, "prisma", "migrations", name);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "migration.sql"), sql, "utf8");
  console.log(`Wrote ${path.relative(repoRoot, path.join(target, "migration.sql"))}`);
  console.log(sql.trim().split("\n").length, "lines of SQL");
} finally {
  fs.rmSync(config, { force: true });
  try {
    psql(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`, "postgres");
  } catch (error) {
    console.warn("Could not drop the throwaway database:", error.message);
  }
}
