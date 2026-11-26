/**
 * Shared Agent Risk Intelligence retention runner.
 *
 * Two mutually exclusive modes:
 *
 *  PREVIEW (read-only, no HTTP call, no token used):
 *    node scripts/run-risk-retention-cron.mjs --dry-run
 *    Reads RETENTION_PREVIEW_DATABASE_URL (a file: SQLite URL, or a deliberately
 *    selected postgres URL guarded by RETENTION_PREVIEW_ALLOW_PRODUCTION=1).
 *    Delegates to scripts/local-retention/preview.ts, which uses the SAME date
 *    arithmetic as src/lib/risk-intelligence/retention.ts and only reads rows.
 *    SQLite is opened with readonly: true. Postgres is opened with a read-only
 *    session. Output is aggregate counts only. No row value is logged.
 *
 *  EXECUTION (mutating authenticated HTTPS POST, unchanged production path):
 *    node scripts/run-risk-retention-cron.mjs
 *    Reads MAACASH_APP_URL (or SITE_URL) and RISK_RETENTION_TOKEN.
 *    The token is never printed or written to a log. The endpoint returns only
 *    counts, so the response body is safe to log.
 *
 * Environment names only; no secret or URL value appears in this file or logs.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`[risk-retention-cron] ${message}`);
  process.exit(1);
}

function usage() {
  console.info(
    [
      "Usage:",
      "  node scripts/run-risk-retention-cron.mjs              mutating production POST",
      "  node scripts/run-risk-retention-cron.mjs --dry-run    read-only aggregate preview",
      "  node scripts/run-risk-retention-cron.mjs --help       this message",
    ].join("\n")
  );
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  usage();
  process.exit(0);
}
const unknown = args.filter((arg) => arg !== "--dry-run");
if (unknown.length > 0) fail(`unknown argument: ${unknown[0]}`);

// ---------------------------------------------------------------------------
// PREVIEW. Never reaches the HTTP route. Never uses RISK_RETENTION_TOKEN.
// ---------------------------------------------------------------------------
if (args.includes("--dry-run")) {
  const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const preview = path.join(REPO_ROOT, "scripts", "local-retention", "preview.ts");
  const result = spawnSync(process.execPath, [tsxCli, preview], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) fail(`preview could not start (${result.error.name}).`);
  process.exit(result.status ?? 1);
}

// ---------------------------------------------------------------------------
// EXECUTION. Existing authenticated HTTPS POST path, kept unchanged.
// ---------------------------------------------------------------------------

const APP_URL =
  process.env.MAACASH_APP_URL || process.env.SITE_URL || "";
const TOKEN = process.env.RISK_RETENTION_TOKEN || "";
const TIMEOUT_MS = 30_000;
const ENDPOINT = "/api/internal/risk-intelligence/retention";

if (!APP_URL) fail("MAACASH_APP_URL (or SITE_URL) is not configured.");
if (!TOKEN) fail("RISK_RETENTION_TOKEN is not configured.");

let target;
try {
  target = new URL(ENDPOINT, APP_URL);
} catch {
  fail("MAACASH_APP_URL is not a valid URL.");
}
if (target.protocol !== "https:") {
  fail("MAACASH_APP_URL must use HTTPS for a scheduled production call.");
}

const startedAt = Date.now();
try {
  const response = await fetch(target, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });

  const body = await response.text();
  if (!response.ok) {
    fail(`endpoint returned HTTP ${response.status} after ${Date.now() - startedAt}ms.`);
  }

  let summary = null;
  try {
    summary = body ? JSON.parse(body) : null;
  } catch {
    fail("endpoint returned a non-JSON response.");
  }

  console.info(
    "[risk-retention-cron] ok",
    JSON.stringify({
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      expired: summary?.expired ?? 0,
      scrubbed: summary?.scrubbed ?? 0,
      audited: summary?.audited ?? 0,
    })
  );
} catch (error) {
  const name = error instanceof Error ? error.name : "UnknownError";
  fail(`request failed (${name}) after ${Date.now() - startedAt}ms.`);
}
