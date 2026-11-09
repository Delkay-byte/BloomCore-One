/**
 * MaaCash deployment preparation.
 *
 * Production schema changes are applied ONLY through reviewed Prisma migrations
 * against prisma/schema-pg.prisma. There is no db push fallback: a failed
 * migration stops the release.
 *
 * This script is an operator/CI helper. The Render build command intentionally
 * does not run migrations; apply them before promoting the application commit.
 *
 * Usage:
 *   DATABASE_URL=... DIRECT_URL=... JWT_SECRET=... node scripts/prepare-deploy.mjs
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function run(label, command, args, env = process.env) {
  console.log(`  $ ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  if (result.error || result.status !== 0) {
    console.error(`\nDeployment preparation stopped: ${label} failed.`);
    process.exit(result.status || 1);
  }
}

console.log("");
console.log("MaaCash - Deployment Preparation");
console.log("");

const dbUrl = process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET;
const appEnv = process.env.APP_ENV || "production";

if (!dbUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
if (!jwtSecret) {
  console.error("JWT_SECRET is not set.");
  process.exit(1);
}

const isPostgres =
  dbUrl.startsWith("postgresql://") || dbUrl.startsWith("postgres://");
if (!isPostgres) {
  console.error(
    "Deployment preparation requires PostgreSQL. SQLite is development/test only."
  );
  process.exit(1);
}
if (!process.env.DIRECT_URL) {
  console.error(
    "DIRECT_URL is required for Prisma migration administration against PostgreSQL."
  );
  process.exit(1);
}
if (/ep-.*\.neon\.tech/i.test(dbUrl) && appEnv !== "production") {
  console.error("A Neon database is configured outside a production environment.");
  process.exit(1);
}

console.log(`Environment: ${appEnv}`);
console.log("Database: PostgreSQL (connection configured)");
console.log("Schema: prisma/schema-pg.prisma");
console.log("JWT_SECRET: configured");
console.log("");

run("prisma generate", NPX, [
  "prisma",
  "generate",
  "--schema=prisma/schema-pg.prisma",
]);

// A failed migration must stop the release. Never replace this with db push.
run("prisma migrate deploy", NPX, [
  "prisma",
  "migrate",
  "deploy",
  "--schema=prisma/schema-pg.prisma",
]);

run("prisma migrate status", NPX, [
  "prisma",
  "migrate",
  "status",
  "--schema=prisma/schema-pg.prisma",
]);

run("npm run build", NPM, ["run", "build"]);

console.log("");
console.log("Deployment preparation complete.");
console.log(
  "The reviewed migration chain is applied. Promote the matching application commit."
);
console.log("");
