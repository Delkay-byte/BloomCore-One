/** Stop only the isolated app recorded in server.pid. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { PID_FILE, assertLocalTarget } from "./env.mjs";

assertLocalTarget();
if (!fs.existsSync(PID_FILE)) {
  console.log("No isolated server pid file; nothing to stop.");
  process.exit(0);
}
const pid = fs.readFileSync(PID_FILE, "utf8").trim();
if (!/^\d+$/.test(pid)) throw new Error(`Invalid pid in ${PID_FILE}.`);
try {
  execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
  console.log(`Stopped isolated server pid ${pid}.`);
} catch {
  console.log(`Server pid ${pid} was no longer running; cleared pid file.`);
}
fs.rmSync(PID_FILE, { force: true });
