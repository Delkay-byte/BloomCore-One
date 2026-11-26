/**
 * VU worker. Spawned by generator.mjs; each worker owns a contiguous slice of
 * synthetic identities and drives real HTTP requests with signed tab proofs.
 */
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { IDENTITIES_FILE, assertLocalTarget } from "./env.mjs";
import { mintAssertion, request, sharedAgent } from "./http-client.mjs";

assertLocalTarget();

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const start = Number(arg("start", 0));
const count = Number(arg("count", 250));
const stages = JSON.parse(arg("stages", "[]"));
const workerId = Number(arg("worker-id", 0));
const seed = Number(arg("seed", 20261125));

if (!Array.isArray(stages) || stages.length === 0) throw new Error("worker requires --stages JSON");

const allIdentities = JSON.parse(fs.readFileSync(IDENTITIES_FILE, "utf8"));
const identities = allIdentities.slice(start, start + count);
// Browser-like per-process connection ceiling. 8 workers x 64 sockets keeps
// the loopback listener below a 512-socket burst while all VUs stay active.
const agent = sharedAgent(64);

function rngFor(number) {
  let a = (seed + number * 7919) >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STEPS = {
  admin: [
    ["auth.me", 12, (r) => `/api/auth/me?module=admin`],
    ["auth.session", 8, (r) => `/api/auth/session`],
    ["assertion.refresh", 8, (r) => `/api/auth/tab/assertion`, "POST"],
    ["page.dashboard", 18, (r) => `/admin/dashboard`],
    ["api.audit", 16, (r) => `/api/audit?page=${1 + Math.floor(r() * 20)}&limit=${r() > 0.8 ? 100 : 30}`],
    ["page.history", 10, (r) => `/admin/history`],
    ["page.ledger", 8, (r) => `/admin/ledger`],
    ["api.ledger.export", 8, (r) => `/api/admin/ledger/export?type=${r() > 0.5 ? "cash_in" : "cash_out"}&network=mtn`],
    ["page.risk", 8, (r) => `/admin/risk-intelligence`],
    ["page.reports", 4, (r) => `/admin/reports`],
  ],
  worker: [
    ["auth.me", 12, (r) => `/api/auth/me?module=momo`],
    ["auth.session", 8, (r) => `/api/auth/session`],
    ["assertion.refresh", 8, (r) => `/api/auth/tab/assertion`, "POST"],
    ["page.dashboard", 22, (r) => `/worker/dashboard`],
    ["page.shifts", 12, (r) => `/worker/shifts`],
    ["page.transfers", 10, (r) => `/worker/transfers`],
    ["page.settings", 8, (r) => `/worker/settings`],
    ["write.momoDraft", 8, (r, id, n) => momoDraftBody(r, id, n), "POST", "/api/offline/momo-draft"],
  ],
  collector: [
    ["auth.me", 14, (r) => `/api/auth/me?module=susu`],
    ["auth.session", 8, (r) => `/api/auth/session`],
    ["assertion.refresh", 8, (r) => `/api/auth/tab/assertion`, "POST"],
    ["page.dashboard", 25, (r) => `/collector/dashboard`],
    ["write.contribution", 14, (r, id, n) => contributionBody(r, id, n), "POST", "/api/offline/sync-contribution"],
    ["write.withdrawalRequest", 8, (r, id, n) => withdrawalRequestBody(r, id, n), "POST", "/api/offline/sync-request"],
    ["page.settings", 8, (r) => `/collector/settings`],
  ],
  // Customer and platform SSR dashboards are excluded from the VU mix after a
  // verified build defect: they return HTTP 500 with Next.js InvariantError
  // "client reference manifest ... does not exist" even at one user. The defect
  // is recorded in the failure report. Session APIs and public entry pages are
  // still exercised for these roles.
  customer: [
    ["auth.me", 34, (r) => `/api/auth/me?module=customer`],
    ["auth.session", 26, (r) => `/api/auth/session`],
    ["assertion.refresh", 22, (r) => `/api/auth/tab/assertion`, "POST"],
    ["page.entry", 12, (r) => `/customer/login`],
    ["api.health", 6, (r) => `/api/health`],
  ],
  platform: [
    ["auth.assertion", 38, (r) => `/api/auth/tab/assertion`, "POST"],
    ["page.entry", 30, (r) => `/platform/login`],
    ["api.health", 32, (r) => `/api/health`],
  ],
};

function pickStep(role, r) {
  const list = STEPS[role] ?? STEPS.customer;
  const total = list.reduce((sum, step) => sum + step[1], 0);
  let value = r() * total;
  for (const step of list) {
    value -= step[1];
    if (value <= 0) return step;
  }
  return list.at(-1);
}

function hex(r, length = 12) {
  let out = "";
  while (out.length < length) out += Math.floor(r() * 16).toString(16);
  return out.slice(0, length);
}

function momoDraftBody(r, identity, n) {
  const businessDate = new Date(Date.now() - (1 + Math.floor(r() * 7)) * 86_400_000).toISOString().slice(0, 10);
  return {
    path: "/api/offline/momo-draft",
    body: {
      idempotencyKey: `LLMD-${identity.vu}-${n}-${hex(r)}`,
      deviceId: identity.deviceId,
      payload: JSON.stringify({
        businessDate,
        locationId: identity.locationId,
        openingCash: 50,
        openingFloat: 100,
        closingCash: 55 + Math.floor(r() * 5),
        closingFloat: 110,
        activities: [
          { kind: "cash_in", network: "mtn", amount: 5, reference: `LLMDREF-${n}`, note: null, evidenceRef: null },
        ],
        note: null,
        captureSource: "manual",
      }),
    },
  };
}

function contributionBody(r, identity, n) {
  return {
    path: "/api/offline/sync-contribution",
    body: {
      idempotencyKey: `LLCON-${identity.vu}-${n}-${hex(r)}`,
      deviceId: identity.deviceId,
      payload: JSON.stringify({
        accountId: identity.accountId,
        amount: identity.contributionAmount ?? 10,
        channel: "collector",
        notes: "local load synthetic contribution",
        collectorId: identity.collectorId,
      }),
    },
  };
}

function withdrawalRequestBody(r, identity, n) {
  return {
    path: "/api/offline/sync-request",
    body: {
      idempotencyKey: `LLREQ-${identity.vu}-${n}-${hex(r)}`,
      deviceId: identity.deviceId,
      payload: JSON.stringify({
        kind: "withdrawal",
        accountId: identity.accountId,
        amount: 5 + Math.floor(r() * 5),
        notes: "local load synthetic withdrawal request",
      }),
    },
  };
}

function emptyStage() {
  return {
    latencies: [],
    statuses: {},
    errors: {},
    stepLatencies: {},
    stepStatuses: {},
    authFailures: 0,
    timeouts: 0,
    requests: 0,
    failedRequests: 0,
    writes: 0,
    writeFailures: 0,
  };
}
const metrics = {};
const startedWall = Date.now();
const startedUsage = process.resourceUsage();

function record(stageData, stepName, result, isWrite) {
  const key = String(result.status);
  stageData.latencies.push(result.elapsedMs);
  stageData.statuses[key] = (stageData.statuses[key] ?? 0) + 1;
  (stageData.stepLatencies[stepName] ??= []).push(result.elapsedMs);
  (stageData.stepStatuses[stepName] ??= {})[key] = ((stageData.stepStatuses[stepName] ?? {})[key] ?? 0) + 1;
  stageData.requests += 1;
  if (!result.ok) stageData.failedRequests += 1;
  if (result.status === 401 || result.status === 403) stageData.authFailures += 1;
  if (result.error === "timeout" || result.elapsedMs >= 9000) stageData.timeouts += 1;
  if (result.error) stageData.errors[result.error] = (stageData.errors[result.error] ?? 0) + 1;
  if (isWrite) {
    stageData.writes += 1;
    if (!result.ok) stageData.writeFailures += 1;
  }
}

async function runVu(identity, globalIndex, stage) {
  const metric = (metrics[stage.label] ??= emptyStage());
  const r = rngFor(globalIndex + stage.index * 100000);
  const activation = Math.min(stage.rampMs, Math.round((globalIndex / Math.max(1, stage.vus)) * stage.rampMs));
  let due = stage.start + activation;
  if (due > Date.now()) await sleep(due - Date.now());
  let n = 0;
  while (Date.now() < stage.end) {
    const [stepName, , pathOrBody, method = "GET", explicitPath] = pickStep(identity.role, r);
    let path = typeof pathOrBody === "function" ? pathOrBody(r, identity, n) : pathOrBody;
    let body;
    if (stepName.startsWith("write.")) {
      body = path.body;
      path = explicitPath;
    }
    const isWrite = Boolean(body) || method !== "GET";
    const result = await request({
      method,
      path,
      identity,
      body,
      agent,
      timeoutMs: 9000,
    });
    record(metric, stepName, result, isWrite);
    n += 1;
    if (Date.now() >= stage.end) break;
    const think = isWrite ? 2500 + r() * 2500 : 800 + r() * 2200;
    await sleep(Math.min(think, stage.end - Date.now()));
  }
}

for (const [index, stage] of stages.entries()) {
  const enriched = { ...stage, index };
  const active = [];
  for (let i = 0; i < identities.length; i += 1) {
    const globalIndex = start + i;
    if (globalIndex < stage.vus) active.push({ identity: identities[i], globalIndex });
  }
  await Promise.all(active.map(({ identity, globalIndex }) => runVu(identity, globalIndex, enriched)));
}

agent.destroy();
const endedUsage = process.resourceUsage();
const result = {
  workerId,
  identities: identities.length,
  wallSeconds: Number(((Date.now() - startedWall) / 1000).toFixed(2)),
  cpuSeconds: Number((((endedUsage.userCPUTime + endedUsage.systemCPUTime) - (startedUsage.userCPUTime + startedUsage.systemCPUTime)) / 1_000_000).toFixed(2)),
  rssMb: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
  metrics,
};
if (process.send) process.send({ type: "result", ...result });
else console.log(JSON.stringify(result));
