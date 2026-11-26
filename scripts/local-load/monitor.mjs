/**
 * Sample application process CPU/memory and disposable SQLite counters during a
 * profile. Reads only the local-load database; never contacts a remote service.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import Database from "better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  LOAD_DB_FILE,
  LOAD_DB_PROVIDER,
  LOAD_DB_URL,
  assertLocalDatabaseUrl,
  assertLocalTarget,
} from "./env.mjs";

assertLocalTarget();
assertLocalDatabaseUrl(`file:${LOAD_DB_FILE.replace(/\\/g, "/")}`);

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const pid = arg("pid", "");
const intervalMs = Number(arg("interval", "2000"));
const out = arg("out", "");
if (!/^\d+$/.test(pid) || !out) throw new Error("monitor requires --pid and --out");

const pg = LOAD_DB_PROVIDER === "postgresql"
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString: LOAD_DB_URL }) })
  : null;
const db = pg ? null : new Database(LOAD_DB_FILE, { readonly: true, fileMustExist: true });
const count = async (table) => {
  try {
    if (pg) {
      const rows = await pg.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "${table}"`);
      return Number(rows[0].n);
    }
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n);
  } catch {
    return -1;
  }
};
const tables = ["SessionRecord", "TabProofNonce", "RateLimitCounter", "OfflineTransaction", "MomoOfflineDraft"];

function processSample() {
  const script =
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
    `if ($null -eq $p) { '{"alive":false}' } else { ` +
    `@{alive=$true; cpuSeconds=[math]::Round($p.CPU,3); rssMb=[math]::Round($p.WorkingSet64/1MB,1)} | ConvertTo-Json -Compress }`;
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 10000 });
  if (result.status !== 0 || !result.stdout?.trim()) return { alive: false };
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return { alive: false };
  }
}

const samples = [];
let previous = null;
const stopAt = Number(arg("until", String(Date.now() + 600000)));
while (Date.now() < stopAt) {
  const at = Date.now();
  const sample = { at: new Date(at).toISOString(), _t: at, ...processSample() };
  for (const table of tables) sample[table] = await count(table);
  sample.dbFileMb = pg ? null : Number((fs.statSync(LOAD_DB_FILE).size / 1048576).toFixed(2));
  if (previous?.alive && sample.alive) {
    sample.cpuPercent = Number(
      (((sample.cpuSeconds - previous.cpuSeconds) / ((at - previous._t) / 1000)) * 100).toFixed(1)
    );
  } else {
    sample.cpuPercent = 0;
  }
  samples.push(sample);
  previous = sample;
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
if (db) db.close();
if (pg) await pg.$disconnect();
fs.writeFileSync(out, JSON.stringify(samples, null, 2));
console.log(JSON.stringify({ samples: samples.length, out }));
