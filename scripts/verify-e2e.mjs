/**
 * Browser acceptance suite against a production build.
 *
 * Composition, in this exact order:
 *   1. prepare the disposable E2E database (guarded reset + deterministic seed);
 *   2. build the application if `.next` is missing or stale;
 *   3. start the built server on a dedicated port against that database;
 *   4. run the desktop and mobile Playwright projects;
 *   5. always stop the server so the next clean preparation can replace the file.
 *
 * The suite needs a freshly seeded database: several scenarios submit financial
 * records, so a second run against the same database is not a valid test of a
 * clean installation.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { e2eDatabase, repoRoot } from "./test-database-paths.cjs";
import { e2eServerEnv } from "./e2e-env.cjs";

const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const PORT = process.env.E2E_PORT ?? "3101";

function run(argv, options = {}) {
  const useShell = process.platform === "win32";
  const command = argv[0];
  const args = useShell
    ? argv.slice(1).map((arg) => `"${String(arg).replace(/"/g, '\\"')}"`)
    : argv.slice(1);
  return execFileSync(command, args, { shell: useShell, cwd: repoRoot, stdio: "inherit", ...options });
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function waitForServer(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status > 0) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

const { file, url } = e2eDatabase();

if (!(await portFree(Number(PORT)))) {
  console.error(
    `Port ${PORT} is already in use. Stop the process serving the E2E build so the ` +
      "database can be reset between runs."
  );
  process.exit(1);
}

run(["node", "scripts/prepare-e2e.mjs"]);

if (!fs.existsSync(path.join(repoRoot, ".next", "BUILD_ID"))) {
  run([NPX, "next", "build", "--webpack"]);
}

console.log(`Serving production build on ${PORT} using ${file}`);
const server = spawn(NPX, ["next", "start", "-p", PORT], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: true,
  // Provider credentials are blanked so no browser test can reach a live
  // payment, messaging or AI provider.
  env: e2eServerEnv(url),
});

const baseUrl = `http://localhost:${PORT}`;
let exitCode = 1;
try {
  if (!(await waitForServer(`${baseUrl}/login`))) {
    throw new Error("The production build did not become ready for browser tests.");
  }
  // Extra arguments are forwarded to Playwright, so a single spec can be
  // rehearsed with the exact same database and provider environment:
  //   node scripts/verify-e2e.mjs e2e/platform.spec.ts --project=chromium
  const extraArgs = process.argv.slice(2);
  run([NPX, "playwright", "test", ...extraArgs], {
    env: { ...process.env, E2E_BASE_URL: baseUrl },
  });
  exitCode = 0;
} catch (error) {
  exitCode = typeof error.status === "number" && error.status > 0 ? error.status : 1;
  console.error("\nBrowser acceptance suite FAILED");
} finally {
  // With `shell: true` on Windows, `server.kill()` terminates only the cmd.exe
  // wrapper; the `next start` grandchild survives, keeps port 3101 bound and
  // holds the disposable database file open. The next run's free-port probe
  // can then pass (Windows allows a specific-address bind over a wildcard
  // listener) while the tests silently run against the stale server and its
  // mutated database. Kill the whole process tree instead.
  if (process.platform === "win32" && server.pid) {
    try {
      execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // The tree may already be gone; nothing to clean up.
    }
  } else {
    server.kill();
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

process.exit(exitCode);
