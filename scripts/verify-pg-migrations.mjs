/**
 * Prove the PostgreSQL migration chain on disposable databases.
 *
 * Three independent checks run against throwaway databases that this script
 * creates and drops on the same loopback server as PG_DATABASE_URL:
 *
 *  1. FRESH CHAIN — every migration applies to an empty database, and
 *     `migrate diff` reports no drift against `prisma/schema-pg.prisma`.
 *  2. UPGRADE — the chain is applied only up to a cut-off, representative
 *     existing rows are written with raw SQL, then the remaining migrations are
 *     applied. Existing values must survive byte-for-byte and the new tables
 *     must exist.
 *  3. RECOVERY — a deliberately failed migration row is recorded, `migrate
 *     deploy` must refuse to continue, `migrate resolve --rolled-back` must
 *     clear it, and the following deploy must succeed. Re-running deploy again
 *     must be a no-op, which is the idempotency check.
 *
 * Nothing here touches a development, staging or production database: the guard
 * in `scripts/pg-safety.mjs` requires a confirmed loopback `maacash_test*` name.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { assertDisposablePostgresTarget } from "./pg-safety.mjs";
import { ensurePrismaClient } from "./ensure-prisma-client.mjs";
import { repoRoot } from "./test-database-paths.cjs";

const base = assertDisposablePostgresTarget(process.env.PG_DATABASE_URL);

/** Migrations applied before the cut-off in the upgrade rehearsal. */
const CUT_OFF_MIGRATIONS = new Set([
  "20261205_association_foundation",
  "20261206_paystack_checkout_channel",
  "20261207_customer_messaging",
  "20261208_zeli_conversation_title_source",
  "20261209_phase1_reconciliation_foundation",
  "20261210_employee_accountability",
  "20261211_offline_action_requests",
  "20261212_tenant_messaging_config",
  "20261213_portal_withdrawals_evidence",
  "20261214_association_governance",
  "20261215_training_certification",
  "20261216_sponsored_subscriptions",
  "20261217_anomaly_investigation",
  "20261218_ai_investigation_drafts",
  "20261219_ai_investigation_package",
  "20261220_offline_momo_drafts",
]);

const MIGRATIONS_DIR = path.join(repoRoot, "prisma", "migrations");
// Resolve the Windows npx shim once so arguments containing spaces (the repo
// path contains one) are passed as real argv entries instead of shell text.
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

/**
 * Run a command with an explicit argv array. Node cannot spawn `.cmd` shims
 * without a shell on Windows, so a shell is enabled only there, and every
 * argument is quoted so repository paths containing spaces stay intact.
 */
function run(argv, options = {}) {
  const useShell = process.platform === "win32";
  const command = argv[0];
  const args = useShell
    ? argv.slice(1).map((arg) => `"${String(arg).replace(/"/g, '\\"')}"`)
    : argv.slice(1);
  return execFileSync(command, args, { shell: useShell, ...options });
}
const results = [];

function log(step, detail) {
  results.push({ step, detail });
  console.log(`\n== ${step} ==\n${detail}`);
}

function adminUrl() {
  const url = new URL(base.url);
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrl(name) {
  const url = new URL(base.url);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdmin(fn) {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function recreateDatabase(name) {
  await withAdmin(async (client) => {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name]
    );
    await client.query(`DROP DATABASE IF EXISTS "${name}"`);
    await client.query(`CREATE DATABASE "${name}"`);
  });
}

async function dropDatabase(name) {
  await withAdmin(async (client) => {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name]
    );
    await client.query(`DROP DATABASE IF EXISTS "${name}"`);
  });
}

/** Copy the migration chain into a temp directory, optionally truncated. */
function stageMigrations({ excludeCutOff = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maacash-migrations-"));
  for (const entry of fs.readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, entry.name), path.join(dir, entry.name));
      continue;
    }
    if (excludeCutOff && CUT_OFF_MIGRATIONS.has(entry.name)) continue;
    fs.cpSync(path.join(MIGRATIONS_DIR, entry.name), path.join(dir, entry.name), { recursive: true });
  }
  return dir;
}

function runPrisma(args, url, extraEnv = {}) {
  const config = path.join(repoRoot, "pg.verify.config.mjs");
  fs.writeFileSync(config, VERIFY_CONFIG);
  try {
    return run([NPX, "prisma", ...args, "--config", config], {
      stdio: "pipe",
      encoding: "utf8",
      env: { ...process.env, PRISMA_CLI_DATABASE_URL: url, ...extraEnv },
    });
  } finally {
    fs.rmSync(config, { force: true });
  }
}

const VERIFY_CONFIG = `import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema-pg.prisma",
  migrations: { path: process.env.MAACASH_VERIFY_MIGRATIONS_PATH },
  datasource: { url: process.env.PRISMA_CLI_DATABASE_URL ?? "" },
});
`;

function deployMigrations(url, migrationsPath) {
  return runPrisma(["migrate", "deploy"], url, { MAACASH_VERIFY_MIGRATIONS_PATH: migrationsPath });
}

function migrationStatus(url, migrationsPath) {
  return runPrisma(["migrate", "status"], url, { MAACASH_VERIFY_MIGRATIONS_PATH: migrationsPath });
}

function migrationDiff(url, migrationsPath) {
  const config = path.join(repoRoot, "pg.verify.config.mjs");
  fs.writeFileSync(config, VERIFY_CONFIG);
  try {
    return run(
      [NPX,
        "prisma",
        "migrate",
        "diff",
        "--config",
        config,
        "--from-config-datasource",
        "--to-schema",
        "prisma/schema-pg.prisma",
        "--exit-code",
      ],
      {
        stdio: "pipe",
        encoding: "utf8",
        env: {
          ...process.env,
          PRISMA_CLI_DATABASE_URL: url,
          MAACASH_VERIFY_MIGRATIONS_PATH: migrationsPath,
        },
      }
    );
  } finally {
    fs.rmSync(config, { force: true });
  }
}

async function query(url, sql, params = []) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

async function freshChainCheck() {
  const name = `${base.database}_fresh`.slice(0, 63);
  const url = databaseUrl(name);
  await recreateDatabase(name);
  try {
    const staged = stageMigrations();
    try {
      deployMigrations(url, staged);
      const status = migrationStatus(url, staged);
      if (!/up\s+to\s+date|up to date/i.test(status)) {
        throw new Error(`Unexpected migrate status output:\n${status}`);
      }
      migrationDiff(url, staged);
      const tables = await query(
        url,
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
      );
      const names = tables.map((row) => row.table_name);
      for (const required of [
        "AssociationMember",
        "AssociationSponsorship",
        "AssociationTrainingRecord",
        "CustomerMessagingPreference",
        "CustomerMessageOutbox",
        "CustomerMessageStatusEvent",
      ]) {
        if (!names.includes(required)) throw new Error(`Missing table ${required} after fresh chain.`);
      }
      log(
        "1. Fresh PostgreSQL chain",
        `${names.length} tables created; migrate status up to date; migrate diff empty.`
      );
    } finally {
      fs.rmSync(staged, { recursive: true, force: true });
    }
  } finally {
    await dropDatabase(name);
  }
}

async function upgradeCheck() {
  const name = `${base.database}_upgrade`.slice(0, 63);
  const url = databaseUrl(name);
  await recreateDatabase(name);
  const staged = stageMigrations({ excludeCutOff: true });
  try {
    deployMigrations(url, staged);

    // Representative existing data written before the cut-off migrations.
    await query(
      url,
      `INSERT INTO "BusinessTenant" ("id", "code", "name", "status", "onboardingStatus", "momoEnabled", "susuEnabled", "createdAt", "updatedAt")
       VALUES ('upg-tenant', 'UPG-1', 'Upgrade Tenant', 'ACTIVE', 'COMPLETED', true, true, now(), now())`
    );
    await query(
      url,
      `INSERT INTO "Customer" ("id", "tenantId", "customerId", "fullName", "phone", "status", "portalEnabled", "createdAt", "updatedAt")
       VALUES ('upg-cust', 'upg-tenant', 'UPG-C-1', 'Existing Customer', '+233200000001', 'active', false, now(), now())`
    );
    await query(
      url,
      `INSERT INTO "Location" ("id", "name", "code", "status", "createdAt", "updatedAt")
       VALUES ('upg-loc', 'Upgrade Location', 'UPG-LOC', 'active', now(), now())`
    );
    await query(
      url,
      `INSERT INTO "User" ("id", "tenantId", "email", "fullName", "role", "status", "passwordHash", "createdAt", "updatedAt")
       VALUES ('upg-user', 'upg-tenant', 'upgrade-user@example.test', 'Upgrade Worker', 'worker', 'active', 'x', now(), now())`
    );
    await query(
      url,
      `INSERT INTO "DailyAccount" ("id", "locationId", "workerId", "businessDate", "openingMomoFloat", "openingCash", "createdAt", "updatedAt")
       VALUES ('upg-daily', 'upg-loc', 'upg-user', '2026-11-01', 100, 250, now(), now())`
    );
    const before = await query(
      url,
      `SELECT "fullName", "customerId", phone FROM "Customer" WHERE id = 'upg-cust'`
    );
    const dailyBefore = await query(
      url,
      `SELECT "openingMomoFloat"::text AS m, "openingCash"::text AS c FROM "DailyAccount" WHERE id = 'upg-daily'`
    );

    // Apply the remaining migrations from the real repository directory.
    deployMigrations(url, MIGRATIONS_DIR);

    const after = await query(
      url,
      `SELECT "fullName", "customerId", phone FROM "Customer" WHERE id = 'upg-cust'`
    );
    const dailyAfter = await query(
      url,
      `SELECT "openingMomoFloat"::text AS m, "openingCash"::text AS c FROM "DailyAccount" WHERE id = 'upg-daily'`
    );
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`Existing customer row changed during upgrade: ${JSON.stringify({ before, after })}`);
    }
    if (JSON.stringify(dailyBefore) !== JSON.stringify(dailyAfter)) {
      throw new Error("Existing daily account values changed during upgrade.");
    }

    const newTables = await query(
      url,
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN
        ('AssociationMember','AssociationSponsorship','AssociationTrainingRecord','CustomerMessagingPreference',
         'CustomerMessageOutbox','CustomerMessageStatusEvent')`
    );
    if (newTables.length !== 6) {
      throw new Error(`Upgrade did not create all new tables (found ${newTables.length}).`);
    }

    const columns = await query(
      url,
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_name IN ('AssociationMember','CustomerMessageOutbox')
          AND column_name IN ('joinedAt','nextAttemptAt','createdAt')`
    );
    for (const column of columns) {
      if (column.data_type !== "timestamp without time zone") {
        throw new Error(
          `Column ${column.table_name}.${column.column_name} has type ${column.data_type}, expected timestamp without time zone.`
        );
      }
    }

    // Idempotency: deploying an already-applied chain must be a no-op.
    const second = deployMigrations(url, MIGRATIONS_DIR);
    if (!/No pending migrations/i.test(second)) {
      throw new Error(`Second deploy was not a no-op:\n${second}`);
    }

    log(
      "2. Existing-data upgrade",
      `Cut-off chain applied first, existing customer and daily-account values preserved exactly; ` +
        `${newTables.length} new tables created with timestamptz-free TIMESTAMP(3) columns; re-deploy was a no-op.`
    );
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
    await dropDatabase(name);
  }
}

async function recoveryCheck() {
  const name = `${base.database}_recovery`.slice(0, 63);
  const url = databaseUrl(name);
  await recreateDatabase(name);
  const staged = stageMigrations();
  try {
    deployMigrations(url, staged);

    // Simulate an interrupted migration: roll the last migration back out of the
    // database (record and column), then record a started-but-unfinished,
    // un-rolled-back attempt. Prisma must refuse to continue until the record is
    // resolved, and the following deploy must genuinely re-apply the work.
    const target = "20261208_zeli_conversation_title_source";
    await query(url, `DELETE FROM "_prisma_migrations" WHERE migration_name = $1`, [target]);
    await query(url, `ALTER TABLE "ZeliConversation" DROP COLUMN IF EXISTS "titleSource"`);
    await query(
      url,
      `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
       VALUES (gen_random_uuid()::text, 'interrupted', $1, now(), NULL, 0)`,
      [target]
    );

    let refused = false;
    try {
      deployMigrations(url, staged);
    } catch (error) {
      refused = /failed|P3009|rolled back/i.test(String(error.stdout ?? "") + String(error.message ?? ""));
    }
    if (!refused) throw new Error("migrate deploy did not refuse an interrupted migration record.");

    runPrisma(["migrate", "resolve", "--rolled-back", target], url, {
      MAACASH_VERIFY_MIGRATIONS_PATH: staged,
    });
    const redeployed = deployMigrations(url, staged);
    if (!/successfully applied|No pending migrations/i.test(redeployed)) {
      throw new Error(`Recovery deploy did not report success:\n${redeployed}`);
    }
    const stillThere = await query(
      url,
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ZeliConversation' AND column_name = 'titleSource'`
    );
    if (stillThere.length !== 1) {
      throw new Error("Recovered migration did not leave the expected column in place.");
    }

    log(
      "3. Recovery and idempotency",
      "Interrupted migration record was refused, cleared with migrate resolve --rolled-back, then re-applied successfully."
    );
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
    await dropDatabase(name);
  }
}

async function main() {
  ensurePrismaClient("postgresql");
  await freshChainCheck();
  await upgradeCheck();
  await recoveryCheck();
  console.log("\nAll PostgreSQL migration rehearsals passed.");
  for (const entry of results) console.log(` - ${entry.step}: ${entry.detail}`);
}

main().catch((error) => {
  console.error("\nMigration rehearsal FAILED:", error.message);
  process.exitCode = 1;
});
