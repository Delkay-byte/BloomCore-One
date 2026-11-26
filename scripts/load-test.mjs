/**
 * Repeatable HTTP load probe for MaaCash.
 *
 * Built-in Node HTTP only: no dependency is added to the application. It
 * measures closed-loop concurrency against the unauthenticated public surface
 * and the liveness route. It is not a substitute for authenticated workflow
 * testing, and the report must state exactly what was exercised.
 *
 * Usage:
 *   node scripts/load-test.mjs --url http://127.0.0.1:3100 --users 1000 --connections 100 --duration 60
 */
import http from "node:http";
import { performance } from "node:perf_hooks";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined ? fallback : value;
}

const baseUrl = new URL(arg("url", "http://127.0.0.1:3100"));
const users = Number(arg("users", "1000"));
const connections = Number(arg("connections", String(users)));
const durationSeconds = Number(arg("duration", "60"));
const rampSeconds = Number(arg("ramp", "10"));
const timeoutMs = Number(arg("timeout", "15000"));
const maxErrorRate = Number(arg("max-error-rate", "0.01"));

if (!Number.isInteger(users) || users < 1 || users > 5000) {
  throw new Error("--users must be an integer between 1 and 5000");
}
if (!Number.isInteger(connections) || connections < 1 || connections > users) {
  throw new Error("--connections must be an integer between 1 and --users");
}
if (!Number.isFinite(durationSeconds) || durationSeconds < 5 || durationSeconds > 600) {
  throw new Error("--duration must be between 5 and 600 seconds");
}

const paths = ["/api/health", "/", "/pricing", "/privacy", "/login"];
// Behind Render/HTTP-2 one browser connection carries many concurrent users.
// Direct HTTP/1.1 testing needs an explicit, realistic connection ceiling.
const agent = new http.Agent({ keepAlive: true, maxSockets: connections });
const latencies = [];
const statuses = new Map();
const errors = new Map();
let measuredServerErrors = 0;
let measuredTransportErrors = 0;
const startedAt = Date.now();
const measureAt = startedAt + rampSeconds * 1000;
const stopAt = measureAt + durationSeconds * 1000;

function one(path) {
  return new Promise((resolve) => {
    const started = performance.now();
    const request = http.request(
      {
        protocol: baseUrl.protocol,
        hostname: baseUrl.hostname,
        port: baseUrl.port,
        path,
        method: "GET",
        agent,
        headers: { "user-agent": "maacash-load-test/1.0", accept: "text/html,application/json" },
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          const elapsed = performance.now() - started;
          statuses.set(response.statusCode, (statuses.get(response.statusCode) ?? 0) + 1);
          if (Date.now() >= measureAt && Date.now() < stopAt) {
            latencies.push(elapsed);
            if (response.statusCode >= 500) measuredServerErrors += 1;
          }
          resolve(true);
        });
      }
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
    request.on("error", (error) => {
      const key = error.code || error.message;
      errors.set(key, (errors.get(key) ?? 0) + 1);
      if (Date.now() >= measureAt && Date.now() < stopAt) measuredTransportErrors += 1;
      resolve(false);
    });
    request.end();
  });
}

async function worker(id) {
  const rampDelay = users > 1 ? (id / users) * rampSeconds * 1000 : 0;
  await new Promise((resolve) => setTimeout(resolve, rampDelay));
  let index = id % paths.length;
  while (Date.now() < stopAt) {
    const ok = await one(paths[index % paths.length]);
    index += 1;
    // A refused connection would otherwise spin; back off briefly like a user
    // retrying, which keeps the reported error rate meaningful.
    if (!ok) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

await Promise.all(Array.from({ length: users }, (_, index) => worker(index)));
agent.destroy();

const sorted = latencies.sort((a, b) => a - b);
const transportErrors = [...errors.values()].reduce((a, b) => a + b, 0);
const total = latencies.length + measuredTransportErrors;
const errorRate =
  total === 0 ? 1 : (measuredTransportErrors + measuredServerErrors) / Math.max(total, 1);
const summary = {
  url: baseUrl.origin,
  users,
  connections,
  durationSeconds,
  rampSeconds,
  measuredRequests: latencies.length,
  transportErrors: Object.fromEntries(errors),
  measuredTransportErrors,
  measuredServerErrors,
  statuses: Object.fromEntries([...statuses.entries()].sort((a, b) => a[0] - b[0])),
  requestsPerSecond: Number((latencies.length / durationSeconds).toFixed(2)),
  latencyMs: {
    p50: Number(percentile(sorted, 50).toFixed(1)),
    p95: Number(percentile(sorted, 95).toFixed(1)),
    p99: Number(percentile(sorted, 99).toFixed(1)),
    max: Number((sorted.at(-1) ?? 0).toFixed(1)),
  },
  errorRate: Number(errorRate.toFixed(4)),
};
console.log(JSON.stringify(summary, null, 2));
if (errorRate > maxErrorRate) process.exitCode = 1;