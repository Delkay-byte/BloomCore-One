/**
 * Local release verification.
 *
 * Runs every check the release gate requires, in dependency order, and prints a
 * table of exact results. It never pushes, fetches, merges or deploys, and it
 * refuses to run destructive PostgreSQL work unless a disposable loopback
 * database is explicitly confirmed.
 *
 *   node scripts/verify-release.mjs               # every step
 *   node scripts/verify-release.mjs --skip-e2e    # fast inner loop
 *   node scripts/verify-release.mjs --only lint,typecheck
 *
 * Steps:
 *   1. Prisma schema validation          (SQLite and PostgreSQL)
 *   2. SQLite provisioning rehearsal     (fresh, idempotent, additive upgrade)
 *   3. PostgreSQL migration rehearsal    (fresh, existing-data upgrade, recovery)
 *   4. Unit and integration suite        (SQLite)
 *   5. PostgreSQL integration suite      (disposable database, never skipped)
 *   6. TypeScript                        (tsc --noEmit)
 *   7. ESLint                            (zero errors required)
 *   8. Production build                  (next build)
 *   9. Browser acceptance suite          (production build)
 */
import { execFileSync } from "node:child_process";
import { repoRoot } from "./test-database-paths.cjs";

const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

function npmArgs(args) {
  return [process.platform === "win32" ? "npm.cmd" : "npm", ...args];
}

function run(argv, { allowFailure = false } = {}) {
  const useShell = process.platform === "win32";
  const command = argv[0];
  const args = useShell
    ? argv.slice(1).map((arg) => `"${String(arg).replace(/"/g, '\\"')}"`)
    : argv.slice(1);
  try {
    execFileSync(command, args, { shell: useShell, cwd: repoRoot, stdio: "inherit" });
    return 0;
  } catch (error) {
    if (allowFailure) return error.status ?? 1;
    throw error;
  }
}

const args = process.argv.slice(2);
const skipE2e = args.includes("--skip-e2e");
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? new Set(args[onlyIndex + 1].split(",")) : null;

const steps = [
  {
    id: "schema",
    label: "Prisma schema validation (both providers)",
    run: () => {
      run([NPX, "prisma", "validate", "--schema=prisma/schema.prisma"]);
      run([NPX, "prisma", "validate", "--schema=prisma/schema-pg.prisma"]);
    },
  },
  {
    id: "sqlite",
    label: "SQLite provisioning rehearsal",
    run: () => run(["node", "scripts/verify-sqlite-migrations.mjs"]),
  },
  {
    id: "pg-migrations",
    label: "PostgreSQL migration rehearsal",
    run: () => run(["node", "scripts/verify-pg-migrations.mjs"]),
  },
  {
    id: "unit",
    label: "Unit and integration suite (SQLite)",
    run: () => run(npmArgs(["test"])),
  },
  {
    id: "pg-tests",
    label: "PostgreSQL integration suite (disposable database)",
    run: () => run(npmArgs(["run", "test:pg"])),
  },
  {
    id: "typecheck",
    label: "TypeScript",
    run: () => run(npmArgs(["run", "typecheck"])),
  },
  {
    id: "lint",
    label: "ESLint",
    run: () => run(npmArgs(["run", "lint"])),
  },
  {
    id: "build",
    label: "Production build",
    run: () => run(npmArgs(["run", "build"])),
  },
  {
    id: "e2e",
    label: "Browser acceptance suite (production build)",
    skip: skipE2e,
    run: () => run(["node", "scripts/verify-e2e.mjs"]),
  },
];

const results = [];
for (const step of steps) {
  if (only && !only.has(step.id)) continue;
  if (step.skip) {
    results.push({ ...step, status: "SKIPPED" });
    console.log(`\n=== ${step.label}: SKIPPED ===`);
    continue;
  }
  console.log(`\n=== ${step.label} ===`);
  const started = Date.now();
  try {
    step.run();
    results.push({ ...step, status: "PASS", ms: Date.now() - started });
  } catch {
    results.push({ ...step, status: "FAIL", ms: Date.now() - started });
    // A failed step makes later results meaningless.
    break;
  }
}

console.log("\n=== Release verification summary ===");
for (const result of results) {
  const duration = result.ms ? ` (${Math.round(result.ms / 1000)}s)` : "";
  console.log(`${result.status.padEnd(8)} ${result.label}${duration}`);
}
const failed = results.filter((result) => result.status === "FAIL");
if (failed.length > 0) {
  console.error(`\nRelease verification FAILED at: ${failed.map((f) => f.label).join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("\nRelease verification PASSED.");
}
