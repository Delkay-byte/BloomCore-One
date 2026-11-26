/**
 * One explicit, disposable location per test database.
 *
 * Before this module existed, `scripts/prepare-e2e.mjs` deleted
 * `<repo>/tests/e2e.db` while the application runtime resolved
 * `file:../tests/e2e.db` to a file *outside* the repository. Preparation and
 * runtime therefore used different files, so repeated clean runs failed with a
 * duplicate-tenant error against a stale database.
 *
 * Both paths are now derived from one absolute location and the same helper is
 * used by the preparation script, the Playwright configuration and the E2E seed
 * script. Every destructive operation goes through `assertDisposableDatabase`,
 * which refuses anything that is not positively identified as a test database.
 */
const path = require("node:path");
const os = require("node:os");

const repoRoot = path.resolve(__dirname, "..");
exports.repoRoot = repoRoot;

/** Directory that holds disposable test databases inside the repository. */
const TEST_DATABASE_DIR = path.join(repoRoot, "tests");
exports.TEST_DATABASE_DIR = TEST_DATABASE_DIR;

/** Basenames that are unambiguously disposable test databases. */
const DISPOSABLE_TEST_BASENAMES = new Set(["e2e.db", "maacash-e2e.db", "test.db"]);

/** Basenames that must never be deleted or rewritten by test tooling. */
const PROTECTED_BASENAMES = new Set([
  "dev.db",
  "demo.db",
  "demo-verify.db",
  "prod.db",
  "production.db",
  "neondb.db",
  "maacash-roadmap-dev.db",
]);

/**
 * Assert that a path is a positively identified disposable test database.
 *
 * The guard is deliberately positive-allow: an unknown name is refused rather
 * than assumed safe. It also refuses paths outside the repository test
 * directory unless they live in the OS temporary directory, which keeps an
 * override from ever pointing at a development or production file.
 */
function assertDisposableDatabase(targetPath, { allowTempDir = true } = {}) {
  if (typeof targetPath !== "string" || targetPath.trim() === "") {
    throw new Error("Refusing to touch a test database without an explicit path.");
  }
  const resolved = path.resolve(targetPath);
  const basename = path.basename(resolved).toLowerCase();

  if (PROTECTED_BASENAMES.has(basename)) {
    throw new Error(`Refusing to touch "${basename}": it is not a disposable test database.`);
  }
  if (!basename.endsWith(".db")) {
    throw new Error(`Refusing to touch "${basename}": a test database must be a .db file.`);
  }
  if (!DISPOSABLE_TEST_BASENAMES.has(basename)) {
    throw new Error(
      `Refusing to touch "${basename}": the name is not recognised as a disposable test database ` +
        `(expected one of ${[...DISPOSABLE_TEST_BASENAMES].join(", ")}).`
    );
  }

  const inRepo = isInside(resolved, TEST_DATABASE_DIR);
  const inTemp = allowTempDir && isInside(resolved, os.tmpdir());
  if (!inRepo && !inTemp) {
    throw new Error(
      `Refusing to touch "${resolved}": a disposable test database must live in ${TEST_DATABASE_DIR} ` +
        "or the OS temporary directory."
    );
  }
  return resolved;
}

function isInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Resolve the E2E database used by both the preparation script and the runtime.
 *
 * `E2E_DB_PATH` may override the location, but only with a name the guard
 * accepts. There is no way to point this at a development or production file.
 */
function resolveE2eDatabasePath(env = process.env) {
  const override = env.E2E_DB_PATH;
  const candidate = override
    ? path.resolve(repoRoot, override)
    : path.join(TEST_DATABASE_DIR, "e2e.db");
  return assertDisposableDatabase(candidate);
}

/**
 * Build a Prisma SQLite URL for an absolute path.
 *
 * An absolute `file:` URL resolves identically for the Prisma CLI (which
 * resolves relative paths against the schema directory) and for the
 * better-sqlite3 driver adapter (which resolves them against the process
 * working directory). That removes the class of bug this module fixes.
 */
function sqliteUrlFor(absolutePath) {
  const normalised = path.resolve(absolutePath).split(path.sep).join("/");
  return `file:${normalised}`;
}

/** Absolute path and URL for the E2E database, resolved once. */
function e2eDatabase(env = process.env) {
  const file = resolveE2eDatabasePath(env);
  return { file, url: sqliteUrlFor(file) };
}

/** Absolute path and URL for the unit/integration SQLite database. */
function unitDatabase() {
  const file = assertDisposableDatabase(path.join(TEST_DATABASE_DIR, "test.db"));
  return { file, url: sqliteUrlFor(file) };
}

exports.DISPOSABLE_TEST_BASENAMES = DISPOSABLE_TEST_BASENAMES;
exports.assertDisposableDatabase = assertDisposableDatabase;
exports.resolveE2eDatabasePath = resolveE2eDatabasePath;
exports.sqliteUrlFor = sqliteUrlFor;
exports.e2eDatabase = e2eDatabase;
exports.unitDatabase = unitDatabase;
