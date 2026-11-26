/**
 * Typed entry point for the shared PostgreSQL test-target guard.
 *
 * The implementation lives in `scripts/pg-safety.mjs` so that the Vitest suite
 * and the release verification scripts enforce exactly the same rules.
 */
import {
  PG_TEST_CONFIRMATION,
  assertDisposablePostgresTarget as assertTarget,
} from "../scripts/pg-safety.mjs";

export { PG_TEST_CONFIRMATION };

export interface PostgresTestTarget {
  url: string;
  host: string;
  database: string;
}

export type EnvLike = Record<string, string | undefined>;

export function assertDisposablePostgresTarget(
  rawUrl: string | undefined,
  env: EnvLike = process.env
): PostgresTestTarget {
  return assertTarget(rawUrl, env) as PostgresTestTarget;
}
