/**
 * Local 1,000-VU load-test environment.
 *
 * Hard safety boundary: every script in this directory calls assertLocalTarget()
 * before opening a socket or a database. The application server is started with
 * an explicit, synthetic environment; every outbound provider credential is
 * blanked. No production host, credential or data is read.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BLANKED_E2E_KEYS } from "../e2e-env.cjs";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const TEST_DIR = path.join(REPO_ROOT, "tests");

export const LOAD_DB_FILE = path.join(TEST_DIR, "local-load.db");
// Optional loopback PostgreSQL target for the production-compatible capacity
// run. Never accepts a remote host; absent this, the disposable SQLite target
// remains the default.
export const LOAD_DB_URL =
  process.env.MAACASH_LOAD_DATABASE_URL || sqliteUrl(LOAD_DB_FILE);
export const LOAD_DB_PROVIDER = process.env.MAACASH_LOAD_DATABASE_URL
  ? "postgresql"
  : "sqlite";
export const IDENTITIES_FILE = path.join(
  TEST_DIR,
  LOAD_DB_PROVIDER === "postgresql" ? "pg-load-identities.json" : "local-load-identities.json"
);
export const ARTIFACT_DIR = path.join(
  TEST_DIR,
  LOAD_DB_PROVIDER === "postgresql" ? "pg-load-artifacts" : "local-load-artifacts"
);
export const SERVER_LOG = path.join(ARTIFACT_DIR, "server.log");
export const PID_FILE = path.join(ARTIFACT_DIR, "server.pid");

export const BASE_URL = "http://127.0.0.1:3101";
export const PORT = 3101;
export const VU_COUNT = 1000;

/** Synthetic, local-only values. These are not production credentials. */
export const SYNTHETIC_ENV = Object.freeze({
  NODE_ENV: "production",
  APP_ENV: "LOCAL_LOAD_TEST",
  DATABASE_URL: LOAD_DB_URL,
  PG_POOL_MAX: process.env.MAACASH_LOAD_PG_POOL_MAX || "60",
  JWT_SECRET: "local-load-jwt-secret-not-for-production-0001",
  RATE_LIMIT_HMAC_SECRET: "local-load-rate-limit-secret-000000000001",
  MFA_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  TURNSTILE_ENABLED: "false",
  MFA_ENFORCEMENT: "optional",
  PAYSTACK_ENABLED: "false",
  PLATFORM_OIDC_ENABLED: "false",
  ZELI_EXTERNAL_AI_DISABLED: "true",
  WHATSAPP_DELIVERY_ENABLED: "false",
  SMS_DELIVERY_ENABLED: "false",
  SMS_PROVIDER: "",
  OFFLINE_COLLECTIONS_ENABLED: "true",
  OFFLINE_MOMO_ENABLED: "true",
  // Inbound webhook HMAC secret only. No outbound SMS provider exists; the app's
  // SMS adapter is a fixed mock that never opens a network connection.
  SMS_STATUS_WEBHOOK_SECRET: "local-load-sms-webhook-hmac-0000000000001",
  // Inbound scheduler token only. This enables the bounded, local-only retry
  // sweep; the SMS/WhatsApp adapters remain fixed mocks that never send.
  MESSAGING_DISPATCH_TOKEN: "local-load-dispatch-token-00000000000001",
  ANOMALY_SCAN_TOKEN: "",
  RISK_RETENTION_TOKEN: "",
});

/** Inbound, non-provider values that may be set for local failure scenarios. */
export const LOCAL_INBOUND_TOKENS = Object.freeze([
  "SMS_STATUS_WEBHOOK_SECRET",
  "ZELI_EXTERNAL_AI_DISABLED",
  "MESSAGING_DISPATCH_TOKEN",
]);

/**
 * Build an absolute `file:` URL. Absolute URLs resolve identically for the
 * Prisma CLI and for the better-sqlite3 driver adapter.
 */
export function sqliteUrl(absolutePath) {
  return `file:${path.resolve(absolutePath).split(path.sep).join("/")}`;
}

/** Positive-allow guard for the disposable load database. */
export function assertDisposableLoadDb(file = LOAD_DB_FILE) {
  if (typeof file !== "string" || file.trim() === "") {
    throw new Error("Refusing an empty load-test database path.");
  }
  const resolved = path.resolve(file);
  const basename = path.basename(resolved).toLowerCase();
  if (basename !== "local-load.db") {
    throw new Error(
      `Refusing "${basename}": the load database must be named local-load.db. ` +
        "E2E and development databases are never touched."
    );
  }
  if (!isInside(resolved, TEST_DIR)) {
    throw new Error(`Refusing "${resolved}": load database must live in tests/.`);
  }
  return resolved;
}

function isInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Abort unless the target is this machine's loopback interface on port 3101. */
export function assertLocalTarget(url = BASE_URL) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing non-URL BASE_URL: ${String(url)}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`Refusing scheme ${parsed.protocol}: load tests use plain HTTP on loopback only.`);
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error(
      `Refusing BASE_URL host "${parsed.hostname}": local load tests never contact a remote host.`
    );
  }
  if (parsed.port !== String(PORT)) {
    throw new Error(
      `Refusing BASE_URL port "${parsed.port || "80"}": the isolated app must use port ${PORT}.`
    );
  }
  return parsed;
}

/** Abort unless DATABASE_URL is an absolute local `file:` URL for the load DB. */
export function assertLocalDatabaseUrl(url = LOAD_DB_URL) {
  if (typeof url !== "string") {
    throw new Error("Refusing DATABASE_URL: a local disposable target is required.");
  }
  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) {
      throw new Error("Refusing a non-loopback PostgreSQL load target.");
    }
    const db = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    if (!/^maacash[_-]test(?:[_-].*)?$/i.test(db)) {
      throw new Error("Refusing a PostgreSQL database that is not disposable (maacash_test*).");
    }
    return parsed;
  }
  if (!url.startsWith("file:")) {
    throw new Error("Refusing DATABASE_URL: local load tests require an absolute file: SQLite URL.");
  }
  const filePath = url.slice("file:".length).split("?")[0].replace(/^\/\//, "");
  const normalised = path.resolve(filePath);
  if (normalised !== path.resolve(LOAD_DB_FILE) && path.basename(normalised).toLowerCase() !== "local-load.db") {
    throw new Error(
      `Refusing DATABASE_URL "${url}": expected the disposable local-load.db file.`
    );
  }
  return assertDisposableLoadDb(normalised);
}

/**
 * Server environment. Starts from a clean object on purpose: a developer's
 * `.env` must never leak credentials into this process.
 */
export function loadServerEnv() {
  assertLocalTarget();
  assertLocalDatabaseUrl(LOAD_DB_URL);
  const env = { ...SYNTHETIC_ENV };
  for (const key of BLANKED_E2E_KEYS) env[key] = "";
  // Re-apply local-only inbound values blanked above. No outbound credential
  // is ever restored.
  for (const key of LOCAL_INBOUND_TOKENS) env[key] = SYNTHETIC_ENV[key];
  return env;
}

/** Assert that no outbound provider credential survived environment assembly. */
export function assertNoProviderCredentials(env) {
  const forbidden = BLANKED_E2E_KEYS.filter((key) => !LOCAL_INBOUND_TOKENS.includes(key));
  const present = forbidden.filter((key) => Boolean(String(env[key] ?? "").trim()));
  if (present.length > 0) {
    throw new Error(
      `Refusing to start: outbound provider credentials are set (${present.join(", ")}). ` +
        "Never print or load their values."
    );
  }
}

export function ensureArtifactDir() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  return ARTIFACT_DIR;
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[index].toFixed(2));
}

export function summariseLatencies(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: Number((sorted.at(-1) ?? 0).toFixed(2)),
  };
}
