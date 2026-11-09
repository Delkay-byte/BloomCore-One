import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertDisposablePostgresTarget } from "./pg-safety";

const root = path.resolve(__dirname, "..");

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

const CONFIRM = "DISPOSABLE_TEST_DATABASE";

describe("PostgreSQL test target safety", () => {
  it("accepts an explicitly confirmed local disposable database", () => {
    const target = assertDisposablePostgresTarget(
      "postgresql://user:pass@localhost:5432/maacash_test",
      { PG_TEST_CONFIRM: CONFIRM, NODE_ENV: "test" }
    );
    expect(target.host).toBe("localhost");
    expect(target.database).toBe("maacash_test");
  });

  it("rejects a Neon host even when confirmation is present", () => {
    expect(() =>
      assertDisposablePostgresTarget(
        "postgresql://user:pass@ep-production.us-east-2.aws.neon.tech/maacash_test",
        { PG_TEST_CONFIRM: CONFIRM, NODE_ENV: "test" }
      )
    ).toThrow(/Neon/i);
  });

  it("rejects production-looking database names", () => {
    expect(() =>
      assertDisposablePostgresTarget(
        "postgresql://user:pass@localhost:5432/neondb",
        { PG_TEST_CONFIRM: CONFIRM, NODE_ENV: "test" }
      )
    ).toThrow(/database name/i);
  });

  it("rejects missing explicit confirmation", () => {
    expect(() =>
      assertDisposablePostgresTarget(
        "postgresql://user:pass@localhost:5432/maacash_test",
        { NODE_ENV: "test" }
      )
    ).toThrow(/PG_TEST_CONFIRM/i);
  });

  it("rejects a production runtime even when the URL looks local", () => {
    expect(() =>
      assertDisposablePostgresTarget(
        "postgresql://user:pass@localhost:5432/maacash_test",
        { PG_TEST_CONFIRM: CONFIRM, NODE_ENV: "production" }
      )
    ).toThrow(/production/i);
  });

  it("rejects an unrecognized remote host", () => {
    expect(() =>
      assertDisposablePostgresTarget(
        "postgresql://user:pass@shared-db.example.com:5432/maacash_test",
        { PG_TEST_CONFIRM: CONFIRM, NODE_ENV: "test" }
      )
    ).toThrow(/local disposable/i);
  });
});

describe("deployment safety", () => {
  it("never falls back from migrate deploy to prisma db push", () => {
    const script = read("scripts/prepare-deploy.mjs");
    expect(script).toContain("prisma migrate deploy");
    expect(script).toContain("schema-pg.prisma");
    // Reject an executable db-push fallback, while allowing the comment that
    // documents its deliberate absence.
    expect(script).not.toMatch(/npx\s+prisma\s+db\s+push/i);
    expect(script).not.toMatch(/["']db["']\s*,\s*["']push["']/i);
    expect(script).not.toMatch(/migrate deploy failed, trying/i);
  });

  it("CI runs PostgreSQL migration rehearsal, integration tests and mobile browser tests", () => {
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toMatch(/postgres/i);
    expect(workflow).toMatch(/prisma migrate deploy/);
    expect(workflow).toMatch(/vitest run --config vitest\.pg\.config\.ts/);
    expect(workflow).toMatch(/mobile-chromium|playwright/i);
    expect(workflow).toMatch(/PG_DATABASE_URL/);
  });
});
