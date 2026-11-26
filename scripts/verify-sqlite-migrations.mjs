/**
 * Prove the SQLite provisioning path on a disposable database.
 *
 * The SQLite development/test path deliberately has no migration history: the
 * migrations directory is a PostgreSQL chain (`migration_lock.toml` says
 * `provider = "postgresql"`), and SQLite is provisioned with `prisma db push`
 * from `prisma/schema.prisma`. This script verifies that path end to end
 * instead of assuming it:
 *
 *  1. A fresh disposable SQLite database is created and must contain every model
 *     in the SQLite schema.
 *  2. `prisma migrate diff` must report no drift between the database and the
 *     SQLite schema.
 *  3. A repeated push must be a no-op and must preserve existing rows.
 *  4. An additive change (a new column) must apply without destroying the rows
 *     that already exist, which is the SQLite equivalent of an upgrade
 *     rehearsal.
 *
 * Every file it touches is a guard-approved disposable test database.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { assertDisposableDatabase, repoRoot, sqliteUrlFor } from "./test-database-paths.cjs";
import { ensurePrismaClient } from "./ensure-prisma-client.mjs";

const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

function run(argv, options = {}) {
  const useShell = process.platform === "win32";
  const command = argv[0];
  const args = useShell
    ? argv.slice(1).map((arg) => `"${String(arg).replace(/"/g, '\\"')}"`)
    : argv.slice(1);
  return execFileSync(command, args, { shell: useShell, ...options });
}

function prisma(args, url, encoding = "utf8") {
  return run([NPX, "prisma", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding,
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: url },
  });
}

/** Model names declared in the SQLite schema. */
function modelNames(schemaPath) {
  const schema = fs.readFileSync(schemaPath, "utf8");
  return [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]);
}

function tablesIn(file) {
  const db = new Database(file, { readonly: true });
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "maacash-sqlite-"));
const dbFile = assertDisposableDatabase(path.join(workDir, "test.db"), { allowTempDir: true });
const url = sqliteUrlFor(dbFile);
const schemaFile = path.join(repoRoot, "prisma", "schema.prisma");

try {
  ensurePrismaClient("sqlite");

  // 1 — fresh provisioning
  prisma(["db", "push", "--schema=prisma/schema.prisma"], url);
  const models = modelNames(schemaFile);
  const tables = tablesIn(dbFile);
  const missing = models.filter((model) => !tables.includes(model));
  if (missing.length > 0) {
    throw new Error(`Fresh SQLite database is missing models: ${missing.join(", ")}`);
  }
  console.log(`1. Fresh SQLite provisioning: ${models.length} models present, ${tables.length} tables.`);

  // 2 — no drift between the database and the SQLite schema. Prisma 7 removed
  // `--from-url`, so the live database is addressed through a temporary config.
  const verifyConfig = path.join(repoRoot, "sqlite.verify.config.mjs");
  fs.writeFileSync(
    verifyConfig,
    `import { defineConfig } from "prisma/config";
` +
      `export default defineConfig({
` +
      `  schema: "prisma/schema.prisma",
` +
      `  datasource: { url: process.env.PRISMA_CLI_DATABASE_URL ?? "" },
` +
      `});
`,
    "utf8"
  );
  try {
    run(
      [
        NPX,
        "prisma",
        "migrate",
        "diff",
        "--config",
        verifyConfig,
        "--from-config-datasource",
        "--to-schema",
        "prisma/schema.prisma",
        "--exit-code",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        cwd: repoRoot,
        env: { ...process.env, PRISMA_CLI_DATABASE_URL: url },
      }
    );
  } finally {
    fs.rmSync(verifyConfig, { force: true });
  }
  console.log("2. SQLite schema drift: none (migrate diff exit 0).");

  // 3 — seed rows and prove a repeated push is a safe no-op
  const db = new Database(dbFile);
  db.prepare(
    `INSERT INTO "BusinessTenant" ("id","code","name","status","onboardingStatus","momoEnabled","susuEnabled","createdAt","updatedAt")
     VALUES ('sqlite-tenant','SL-1','SQLite Tenant','ACTIVE','COMPLETED',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
  ).run();
  db.prepare(
    `INSERT INTO "Customer" ("id","tenantId","customerId","fullName","phone","status","portalEnabled","createdAt","updatedAt")
     VALUES ('sqlite-cust','sqlite-tenant','SL-C-1','Existing Customer','+233200000002','active',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
  ).run();
  db.close();

  prisma(["db", "push", "--schema=prisma/schema.prisma"], url);
  const afterRepeat = new Database(dbFile, { readonly: true });
  const surviving = afterRepeat
    .prepare(`SELECT "fullName" FROM "Customer" WHERE "id" = 'sqlite-cust'`)
    .all();
  afterRepeat.close();
  if (surviving.length !== 1 || surviving[0].fullName !== "Existing Customer") {
    throw new Error("A repeated SQLite push did not preserve existing rows.");
  }
  console.log("3. Repeated SQLite push: no-op, existing rows preserved.");

  // 4 — additive change applies without data loss
  const additiveSchema = path.join(workDir, "schema-additive.prisma");
  const schemaText = fs.readFileSync(schemaFile, "utf8");
  const patched = schemaText.replace(
    /(model Customer \{[\s\S]*?\n\})/,
    (block) => block.replace(/\n\}/, `\n  retentionNote String?\n}`)
  );
  if (patched === schemaText) throw new Error("Could not build the additive schema rehearsal.");
  fs.writeFileSync(additiveSchema, patched, "utf8");
  prisma(["db", "push", `--schema=${additiveSchema}`], url);

  const additive = new Database(dbFile, { readonly: true });
  const columns = additive.prepare(`PRAGMA table_info("Customer")`).all().map((row) => row.name);
  const stillThere = additive.prepare(`SELECT COUNT(*) AS n FROM "Customer"`).get();
  additive.close();
  if (!columns.includes("retentionNote")) {
    throw new Error("The additive SQLite column was not created.");
  }
  if (stillThere.n !== 1) {
    throw new Error("The additive SQLite change lost existing rows.");
  }
  console.log("4. Additive SQLite upgrade: new column added, existing rows preserved.");
  console.log("\nAll SQLite provisioning rehearsals passed.");
} catch (error) {
  console.error("\nSQLite rehearsal FAILED:", error.message);
  if (error.stdout) console.error(String(error.stdout));
  if (error.stderr) console.error(String(error.stderr));
  process.exitCode = 1;
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
