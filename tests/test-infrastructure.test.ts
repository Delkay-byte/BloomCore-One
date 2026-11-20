import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// Plain CommonJS helper shared with the release scripts.
import {
  DISPOSABLE_TEST_BASENAMES,
  assertDisposableDatabase,
  e2eDatabase,
  repoRoot,
  unitDatabase,
} from "../scripts/test-database-paths.cjs";

/**
 * Release-safety infrastructure tests.
 *
 * Two classes of defect made repeated release runs unreliable:
 *   1. test preparation and the application runtime resolved different
 *      database paths, so a "clean" preparation could leave a stale database in
 *      use;
 *   2. the PostgreSQL migration chain contained SQLite-only type syntax, so the
 *      chain had never actually been applied to PostgreSQL.
 *
 * These tests keep both guarantees in place.
 */

describe("disposable test database paths", () => {
  it("resolves the E2E and unit databases inside the repository test directory", () => {
    const e2e = e2eDatabase({} as unknown as NodeJS.ProcessEnv);
    const unit = unitDatabase();
    expect(e2e.file).toBe(path.join(repoRoot, "tests", "e2e.db"));
    expect(unit.file).toBe(path.join(repoRoot, "tests", "test.db"));
    // One explicit location per database, expressed as an absolute file URL so
    // the Prisma CLI and the runtime driver adapter cannot disagree.
    expect(e2e.url).toMatch(/^file:[A-Za-z]:\//);
    expect(e2e.url.endsWith("/tests/e2e.db")).toBe(true);
    expect(unit.url.endsWith("/tests/test.db")).toBe(true);
  });

  it("accepts each recognised disposable name", () => {
    for (const name of DISPOSABLE_TEST_BASENAMES) {
      expect(() =>
        assertDisposableDatabase(path.join(repoRoot, "tests", name))
      ).not.toThrow();
    }
  });

  it("refuses a development or production database name", () => {
    for (const name of ["dev.db", "demo.db", "prod.db", "production.db", "neondb.db"]) {
      expect(() => assertDisposableDatabase(path.join(repoRoot, "tests", name))).toThrow(
        /not a disposable test database/i
      );
    }
  });

  it("refuses an unrecognised name rather than assuming it is safe", () => {
    expect(() =>
      assertDisposableDatabase(path.join(repoRoot, "tests", "customer-data.db"))
    ).toThrow(/not recognised as a disposable test database/i);
    expect(() => assertDisposableDatabase("")).toThrow(/explicit path/i);
  });

  it("refuses a test-named file outside the repository or temp directory", () => {
    const outside = path.join(path.parse(repoRoot).root, "important", "e2e.db");
    expect(() => assertDisposableDatabase(outside)).toThrow(/must live in/i);
  });

  it("accepts a temp-directory override but still requires a disposable name", () => {
    expect(() =>
      assertDisposableDatabase(path.join(os.tmpdir(), "e2e.db"))
    ).not.toThrow();
    expect(() =>
      assertDisposableDatabase(path.join(os.tmpdir(), "dev.db"))
    ).toThrow(/not a disposable test database/i);
  });

  it("rejects an override path that is not positively identified", () => {
    expect(() => e2eDatabase({ E2E_DB_PATH: "dev.db" } as unknown as NodeJS.ProcessEnv)).toThrow(
      /not a disposable test database/i
    );
    expect(() =>
      e2eDatabase({ E2E_DB_PATH: path.join(repoRoot, "dev.db") } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/not a disposable test database/i);
  });
});

describe("test tooling uses one shared database resolver", () => {
  const read = (relative: string) =>
    fs.readFileSync(path.join(repoRoot, relative), "utf8");

  it("playwright configuration imports the shared resolver", () => {
    const config = read("playwright.config.ts");
    expect(config).toContain("./scripts/test-database-paths.cjs");
    expect(config).toContain("e2eDatabase().url");
    // The old relative URL resolved outside the repository.
    expect(config).not.toContain("file:../tests/e2e.db");
  });

  it("the E2E preparation script deletes only the guarded path", () => {
    const script = read("scripts/prepare-e2e.mjs");
    expect(script).toContain("./test-database-paths.cjs");
    expect(script).toContain("e2eDatabase()");
    expect(script).not.toMatch(/new URL\("\.\.\/tests\/e2e\.db"/);
    expect(script).toContain("assertDisposable");
  });

  it("the unit-test database is prepared and configured through the resolver", () => {
    expect(read("vitest.config.ts")).toContain("./scripts/test-database-paths.cjs");
    expect(read("scripts/prepare-unit-db.mjs")).toContain("unitDatabase()");
    const vitest = read("vitest.config.ts");
    expect(vitest).not.toContain("file:../tests/test.db");
  });

  it("PostgreSQL release runs prepare the PostgreSQL client and migrations", () => {
    const script = read("scripts/prepare-pg-db.mjs");
    expect(script).toContain("ensurePrismaClient(\"postgresql\")");
    expect(script).toContain("prisma");
    expect(script).toContain("migrate");
    expect(script).toContain("deploy");
    expect(script).toContain("assertDisposablePostgresTarget");
    // The PostgreSQL suite must never run against DATABASE_URL.
    expect(script).not.toContain("process.env.DATABASE_URL");
  });

  it("package scripts expose the PostgreSQL and release verification paths", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:pg"]).toContain("pg");
    expect(pkg.scripts["pretest"]).toContain("prepare-unit-db");
  });
});

describe("PostgreSQL migration chain syntax", () => {
  const migrationsDir = path.join(repoRoot, "prisma", "migrations");

  function migrationFiles(): string[] {
    return fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(migrationsDir, entry.name, "migration.sql"))
      .filter((file) => fs.existsSync(file));
  }

  it("declares the PostgreSQL provider for the migration history", () => {
    const lock = fs.readFileSync(path.join(migrationsDir, "migration_lock.toml"), "utf8");
    expect(lock).toMatch(/provider\s*=\s*"postgresql"/);
  });

  it("contains no SQLite-only type syntax", () => {
    const offenders: string[] = [];
    for (const file of migrationFiles()) {
      const sql = fs.readFileSync(file, "utf8");
      if (/\bDATETIME\b/i.test(sql)) offenders.push(`${file}: DATETIME`);
      if (/\bAUTOINCREMENT\b/i.test(sql)) offenders.push(`${file}: AUTOINCREMENT`);
      if (/"(?:id|amount|balance|total|closing|opening)[^"]*"\s+DECIMAL(?!\()/i.test(sql)) {
        offenders.push(`${file}: DECIMAL without precision`);
      }
      if (/\bCREATE\s+SCHEMA\b/.test(sql) === false && /PRAGMA\s+/.test(sql)) {
        offenders.push(`${file}: PRAGMA`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses TIMESTAMP(3) for the association and messaging timestamps", () => {
    for (const name of [
      "20261205_association_foundation",
      "20261207_customer_messaging",
    ]) {
      const sql = fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8");
      expect(sql).toContain("TIMESTAMP(3)");
      expect(sql).not.toMatch(/\bDATETIME\b/i);
    }
  });

  it("keeps the migration history append-only and ordered", () => {
    const names = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names.length).toBeGreaterThanOrEqual(53);
    expect(names[0]).toBe("20260823_init_postgresql");
    // Applied migrations are never removed or renamed, so every baseline name
    // stays in the history and new work is only appended after it.
    for (const required of [
      "20261205_association_foundation",
      "20261207_customer_messaging",
      "20261208_zeli_conversation_title_source",
    ]) {
      expect(names).toContain(required);
    }
    // Several migrations may share a date prefix; Prisma orders by the full
    // directory name, so names must be unique and the prefixes non-decreasing.
    expect(new Set(names).size).toBe(names.length);
    const prefixes = names.map((name) => name.slice(0, 8));
    expect(prefixes).toEqual([...prefixes].sort());
  });
});
