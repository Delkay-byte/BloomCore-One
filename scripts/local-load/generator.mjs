/**
 * Profile coordinator for the local 1,000-VU test. Forks protocol-level VU
 * workers, aggregates every sample (including failures), and records generator
 * saturation and application resource samples. No sample is discarded.
 */
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ARTIFACT_DIR,
  IDENTITIES_FILE,
  PID_FILE,
  VU_COUNT,
  assertLocalTarget,
  ensureArtifactDir,
  summariseLatencies,
} from "./env.mjs";

assertLocalTarget();
ensureArtifactDir();

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const profileName = arg("profile", "smoke");
const workerCount = Math.max(1, Math.min(16, Number(arg("workers", "4"))));
const outArg = arg("out", "");

const PROFILES = {
  smoke: [{ label: "smoke-5-vu", vus: 5, durationMs: 30_000, rampMs: 2_000 }],
  baseline: [{ label: "baseline-2-vu", vus: 2, durationMs: 60_000, rampMs: 0 }],
  progressive: [10, 50, 100, 250, 500, 750, 1000].map((vus) => ({
    label: `progressive-${vus}-vu`,
    vus,
    durationMs: 45_000,
    rampMs: 5_000,
  })),
  peak: [{ label: "peak-1000-vu", vus: 1000, durationMs: 120_000, rampMs: 10_000 }],
  spike: [
    { label: "spike-pre-100-vu", vus: 100, durationMs: 30_000, rampMs: 0 },
    { label: "spike-to-1000-vu", vus: 1000, durationMs: 60_000, rampMs: 8_000 },
    { label: "recovery-100-vu", vus: 100, durationMs: 60_000, rampMs: 0 },
  ],
  soak: [{ label: "soak-100-vu", vus: 100, durationMs: 180_000, rampMs: 0 }],
  "soak-pg": [{ label: "soak-pg-50-vu", vus: 50, durationMs: 600_000, rampMs: 0 }],
  probe: [{ label: "probe-250-vu", vus: 250, durationMs: 30_000, rampMs: 0 }],
};

if (!PROFILES[profileName] && profileName !== "all") {
  throw new Error(`Unknown profile ${profileName}. Use ${Object.keys(PROFILES).join(", ")} or all.`);
}
const identities = JSON.parse(fs.readFileSync(IDENTITIES_FILE, "utf8"));
if (identities.length !== VU_COUNT) {
  throw new Error(`Expected ${VU_COUNT} identities, found ${identities.length}. Run enroll.mjs first.`);
}

function mergeStage(target, source) {
  target.latencies.push(...source.latencies);
  for (const [key, value] of Object.entries(source.statuses)) target.statuses[key] = (target.statuses[key] ?? 0) + value;
  for (const [key, value] of Object.entries(source.errors)) target.errors[key] = (target.errors[key] ?? 0) + value;
  for (const [step, values] of Object.entries(source.stepLatencies)) {
    (target.stepLatencies[step] ??= []).push(...values);
  }
  for (const [step, statuses] of Object.entries(source.stepStatuses)) {
    const bucket = (target.stepStatuses[step] ??= {});
    for (const [key, value] of Object.entries(statuses)) bucket[key] = (bucket[key] ?? 0) + value;
  }
  target.authFailures += source.authFailures;
  target.timeouts += source.timeouts;
  target.requests += source.requests;
  target.failedRequests += source.failedRequests;
  target.writes += source.writes;
  target.writeFailures += source.writeFailures;
}
function emptyStage(label, vus, durationMs, rampMs) {
  return {
    label,
    vus,
    durationSeconds: durationMs / 1000,
    rampSeconds: rampMs / 1000,
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
function summarizeStage(stage) {
  const latency = summariseLatencies(stage.latencies);
  const stepLatency = {};
  for (const [step, values] of Object.entries(stage.stepLatencies)) {
    stepLatency[step] = summariseLatencies(values);
  }
  return {
    label: stage.label,
    vus: stage.vus,
    durationSeconds: stage.durationSeconds,
    rampSeconds: stage.rampSeconds,
    requests: stage.requests,
    rps: Number((stage.requests / stage.durationSeconds).toFixed(2)),
    latencyMs: latency,
    statuses: stage.statuses,
    errors: stage.errors,
    authFailures: stage.authFailures,
    timeouts: stage.timeouts,
    failedRequests: stage.failedRequests,
    failedRequestRate: stage.requests ? Number((stage.failedRequests / stage.requests).toFixed(4)) : 0,
    writes: stage.writes,
    writeFailures: stage.writeFailures,
    stepLatencyMs: stepLatency,
    stepStatuses: stage.stepStatuses,
  };
}

async function runProfile(name) {
  const stages = PROFILES[name];
  const now = Date.now();
  let cursor = now + 1_000;
  const scheduled = stages.map((stage) => {
    const item = { ...stage, start: cursor, end: cursor + stage.durationMs };
    cursor = item.end + 1_000;
    return item;
  });

  const monitorOut = path.join(ARTIFACT_DIR, `monitor-${name}.json`);
  let monitor = null;
  if (fs.existsSync(PID_FILE)) {
    const pid = fs.readFileSync(PID_FILE, "utf8").trim();
    monitor = fork(path.resolve("scripts/local-load/monitor.mjs"), [
      "--pid", pid,
      "--interval", "2000",
      "--until", String(cursor + 10_000),
      "--out", monitorOut,
    ], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  }

  const started = Date.now();
  const workers = [];
  const merged = new Map(scheduled.map((stage) => [stage.label, emptyStage(stage.label, stage.vus, stage.durationMs, stage.rampMs)]));
  const perWorker = [];

  for (let w = 0; w < workerCount; w += 1) {
    const start = Math.floor((VU_COUNT * w) / workerCount);
    const count = Math.floor((VU_COUNT * (w + 1)) / workerCount) - start;
    const child = fork(path.resolve("scripts/local-load/worker.mjs"), [
      "--start", String(start),
      "--count", String(count),
      "--worker-id", String(w),
      "--stages", JSON.stringify(scheduled),
    ], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    workers.push(new Promise((resolve, reject) => {
      child.on("message", (message) => {
        if (message?.type !== "result") return;
        perWorker.push({
          workerId: message.workerId,
          identities: message.identities,
          wallSeconds: message.wallSeconds,
          cpuSeconds: message.cpuSeconds,
          rssMb: message.rssMb,
          saturation: Number((message.cpuSeconds / Math.max(1, message.wallSeconds)).toFixed(3)),
        });
        for (const [label, data] of Object.entries(message.metrics)) {
          mergeStage(merged.get(label), data);
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) reject(new Error(`worker ${w} exited with ${code}`));
        else resolve();
      });
    }));
  }
  await Promise.all(workers);
  if (monitor && monitor.exitCode === null && monitor.signalCode === null) {
    await new Promise((resolve) => monitor.once("exit", resolve));
  }
  const totalWall = (Date.now() - started) / 1000;
  const maxSaturation = Math.max(0, ...perWorker.map((w) => w.saturation));
  let appSamples = [];
  if (fs.existsSync(monitorOut)) appSamples = JSON.parse(fs.readFileSync(monitorOut, "utf8"));

  const result = {
    profile: name,
    generatedAt: new Date().toISOString(),
    baseUrl: "http://127.0.0.1:3101",
    workers: workerCount,
    totalWallSeconds: Number(totalWall.toFixed(2)),
    generator: {
      workers: perWorker,
      totalCpuSeconds: Number(perWorker.reduce((sum, w) => sum + w.cpuSeconds, 0).toFixed(2)),
      maxWorkerSaturation: maxSaturation,
      saturated: maxSaturation > 0.85,
      note: "Saturation is CPU seconds / wall seconds for the busiest generator worker.",
    },
    application: summariseAppSamples(appSamples),
    stages: scheduled.map((stage) => summarizeStage(merged.get(stage.label))),
  };
  const out = outArg || path.join(ARTIFACT_DIR, `profile-${name}.json`);
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    profile: name,
    out,
    saturated: result.generator.saturated,
    stages: result.stages.map((s) => ({
      label: s.label,
      requests: s.requests,
      rps: s.rps,
      p95: s.latencyMs.p95,
      p99: s.latencyMs.p99,
      failed: s.failedRequests,
      errors: s.errors,
    })),
  }, null, 2));
  return result;
}

function summariseAppSamples(samples) {
  const alive = samples.filter((s) => s.alive);
  if (!alive.length) return { available: false, samples: samples.length };
  const cpu = alive.map((s) => s.cpuPercent ?? 0);
  const rss = alive.map((s) => s.rssMb ?? 0);
  return {
    available: true,
    samples: alive.length,
    cpuPercentAvg: Number((cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1)),
    cpuPercentMax: Number(Math.max(...cpu).toFixed(1)),
    rssMbAvg: Number((rss.reduce((a, b) => a + b, 0) / rss.length).toFixed(1)),
    rssMbMax: Number(Math.max(...rss).toFixed(1)),
    dbFileMbEnd: alive.at(-1).dbFileMb,
    lastCounters: {
      SessionRecord: alive.at(-1).SessionRecord,
      TabProofNonce: alive.at(-1).TabProofNonce,
      RateLimitCounter: alive.at(-1).RateLimitCounter,
      OfflineTransaction: alive.at(-1).OfflineTransaction,
      MomoOfflineDraft: alive.at(-1).MomoOfflineDraft,
    },
  };
}

if (profileName === "all") {
  for (const name of ["smoke", "baseline", "progressive", "peak", "spike", "soak"]) {
    await runProfile(name);
  }
} else {
  await runProfile(profileName);
}
