/** Start the isolated Next.js app on 127.0.0.1:3101 with synthetic-only env. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ARTIFACT_DIR,
  BASE_URL,
  PID_FILE,
  REPO_ROOT,
  SERVER_LOG,
  assertLocalTarget,
  assertNoProviderCredentials,
  ensureArtifactDir,
  loadServerEnv,
} from "./env.mjs";
import { request } from "./http-client.mjs";

assertLocalTarget();
ensureArtifactDir();
const env = loadServerEnv();
assertNoProviderCredentials(env);

if (fs.existsSync(PID_FILE)) {
  const oldPid = fs.readFileSync(PID_FILE, "utf8").trim();
  throw new Error(`Server pid file already exists (${oldPid}). Stop it before starting another.`);
}

const nextBin = path.join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next");
const log = fs.openSync(SERVER_LOG, "a");
const childEnv = { ...process.env, ...env };
if (process.env.MAACASH_LOAD_MEM_SAMPLE === "1") {
  const options = `${childEnv.NODE_OPTIONS ?? ""} --expose-gc`.trim();
  childEnv.NODE_OPTIONS = options;
}
const child = spawn(process.execPath, [nextBin, "start", "-p", "3101"], {
  cwd: REPO_ROOT,
  env: childEnv,
  detached: true,
  stdio: ["ignore", log, log],
});
child.unref();
fs.closeSync(log);
fs.writeFileSync(PID_FILE, String(child.pid));

const deadline = Date.now() + 90_000;
let last = null;
while (Date.now() < deadline) {
  last = await request({ method: "GET", path: "/api/health", timeoutMs: 2000 });
  if (last.ok) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!last?.ok) {
  throw new Error(`App did not become healthy. See ${SERVER_LOG}. Last status=${last?.status} error=${last?.error ?? "none"}`);
}
console.log(JSON.stringify({ baseUrl: BASE_URL, pid: child.pid, log: SERVER_LOG, artifactDir: ARTIFACT_DIR }, null, 2));
