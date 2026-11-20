/**
 * Keep the generated Prisma client aligned with the database being prepared.
 *
 * The SQLite and PostgreSQL schemas share one generated client location, so a
 * PostgreSQL run must generate the PostgreSQL client and the next SQLite run
 * must generate the SQLite client again. Skipping that step produced a
 * confusing `provider "sqlite"` error inside `tests/pg-setup.ts`.
 *
 * This helper detects the provider of the currently generated client and only
 * regenerates when it differs, so ordinary runs stay fast.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./test-database-paths.cjs";

const GENERATED_SCHEMA = path.join(repoRoot, "node_modules", ".prisma", "client", "schema.prisma");

/** Read the datasource provider of the currently generated client, if any. */
export function generatedProvider() {
  try {
    const schema = fs.readFileSync(GENERATED_SCHEMA, "utf8");
    const datasource = schema.slice(schema.indexOf("datasource"));
    return /provider\s*=\s*"([^"]+)"/.exec(datasource)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Ensure the generated client matches `provider` ("sqlite" or "postgresql").
 * Returns true when a regeneration actually happened.
 */
export function ensurePrismaClient(provider) {
  const schemaFile = provider === "postgresql" ? "prisma/schema-pg.prisma" : "prisma/schema.prisma";
  if (generatedProvider() === provider) {
    console.log(`Prisma client already generated for ${provider}.`);
    return false;
  }
  console.log(`Generating Prisma client for ${provider} (${schemaFile}).`);
  execFileSync("npx", ["prisma", "generate", `--schema=${schemaFile}`], {
    stdio: "inherit",
    cwd: repoRoot,
    shell: true,
  });
  return true;
}
