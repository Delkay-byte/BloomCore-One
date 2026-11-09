/**
 * Fail-closed safety guard for destructive PostgreSQL integration tests.
 *
 * The PostgreSQL suite truncates every business table before each test. It must
 * therefore be impossible to point it at production, shared staging or an
 * unconfirmed database. The guard requires:
 *   - PG_DATABASE_URL, never DATABASE_URL;
 *   - an explicit PG_TEST_CONFIRM value;
 *   - a recognizably disposable database name;
 *   - a loopback host;
 *   - a non-production runtime.
 *
 * It returns only the host and database name for evidence. Callers must never
 * print the full connection string.
 */

export const PG_TEST_CONFIRMATION = "DISPOSABLE_TEST_DATABASE";

export interface PostgresTestTarget {
  url: string;
  host: string;
  database: string;
}

type EnvLike = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const DISPOSABLE_DATABASE = /^maacash[_-]test(?:[_-].*)?$/i;
const FORBIDDEN_HOST = /(^|\.)neon\.tech$|(^|\.)neon\.build$|render\.com$/i;

export function assertDisposablePostgresTarget(
  rawUrl: string | undefined,
  env: EnvLike = process.env
): PostgresTestTarget {
  if (!rawUrl) {
    throw new Error(
      "PG_DATABASE_URL is required. PostgreSQL destructive tests never read DATABASE_URL."
    );
  }
  if (env.PG_TEST_CONFIRM !== PG_TEST_CONFIRMATION) {
    throw new Error(
      `PG_TEST_CONFIRM must equal ${PG_TEST_CONFIRMATION} before destructive PostgreSQL tests run.`
    );
  }
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing destructive PostgreSQL tests in a production runtime.");
  }
  if (env.RENDER === "true" || env.RENDER_SERVICE_ID) {
    throw new Error("Refusing destructive PostgreSQL tests on a Render service.");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("PG_DATABASE_URL is not a valid PostgreSQL URL.");
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("PG_DATABASE_URL must use the postgresql:// protocol.");
  }

  const host = parsed.hostname.toLowerCase();
  if (FORBIDDEN_HOST.test(host)) {
    throw new Error(
      "Refusing a Neon/Render host for destructive PostgreSQL tests. Use a disposable local database."
    );
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      "Destructive PostgreSQL tests require a local disposable loopback host."
    );
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!DISPOSABLE_DATABASE.test(database)) {
    throw new Error(
      "The database name is not recognized as disposable. Use maacash_test or maacash-test-*."
    );
  }

  return { url: rawUrl, host, database };
}
