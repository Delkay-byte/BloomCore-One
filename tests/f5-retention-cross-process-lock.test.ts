/**
 * F5 regression: the retention execution lock must work across processes and
 * instances, not merely inside one Node process.
 *
 * All data is synthetic and lives in a disposable SQLite database under the OS
 * temporary directory. No production database is contacted.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/lib/prisma-client";
import { db as actionDb } from "@/lib/db";
import { runSystemRiskRetentionSweep } from "@/lib/actions/risk-governance.actions";
import {
  acquireJobLease,
  assertJobLease,
  LeaseLostError,
  releaseJobLease,
  RETENTION_LEASE_KEY,
} from "@/lib/security/job-lease";
import {
  assertDisposableDatabase,
  repoRoot,
  sqliteUrlFor,
} from "../scripts/test-database-paths.cjs";

const DAY = 86_400_000;
const TOKEN = "local-synthetic-retention-token-not-a-secret";
const PRISMA_CLI = path.join(repoRoot, "node_modules", "prisma", "build", "index.js");
const TSX_CLI = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const CONTENDER = path.join(
  repoRoot,
  "scripts",
  "local-retention",
  "lease-contender.ts"
);

let dir: string;
let url: string;
let db: ReturnType<typeof createPrismaClient>;
const saved: Record<string, string | undefined> = {};

function seedSignal(id: string, expiresAt: number) {
  return db.agentRiskSignal.create({
    data: {
      id,
      tenantId: null,
      subjectKey: `subject-${id}`,
      keyBasis: "tenant-id",
      saltVersion: 1,
      category: "shortage",
      severity: "high",
      status: "expired",
      sourceType: `source-${id}`,
      sourceId: `source-id-${id}`,
      observedFrom: new Date(Date.now() - 300 * DAY),
      observedTo: new Date(Date.now() - 281 * DAY),
      expiresAt: new Date(expiresAt),
      deletedAt: null,
    },
  });
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode", "f5-vitest-"));
  const file = assertDisposableDatabase(path.join(dir, "test.db"));
  url = sqliteUrlFor(file);
  execFileSync(
    process.execPath,
    [PRISMA_CLI, "db", "push", "--schema=prisma/schema.prisma"],
    { cwd: repoRoot, env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" }
  );
  db = createPrismaClient(url);
  for (const name of ["DATABASE_URL", "RISK_RETENTION_TOKEN", "RATE_LIMIT_HMAC_SECRET"]) {
    saved[name] = process.env[name];
  }
  process.env.DATABASE_URL = url;
  process.env.RISK_RETENTION_TOKEN = TOKEN;
  process.env.RATE_LIMIT_HMAC_SECRET = "local-synthetic-rate-limit-secret";
}, 120_000);

afterAll(async () => {
  await actionDb.$disconnect();
  await db.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(async () => {
  await db.auditLog.deleteMany();
  await db.agentRiskSignal.deleteMany();
  await db.systemJobLease.deleteMany();
});

describe("F5 database-backed execution lease", () => {
  it("atomically refuses a second claim while the first is live", async () => {
    const first = await acquireJobLease(RETENTION_LEASE_KEY);
    expect(first).not.toBeNull();
    const second = await acquireJobLease(RETENTION_LEASE_KEY);
    expect(second).toBeNull();
    await releaseJobLease(first!, "success");
  });

  it("takes over an expired lease and increments the fencing token", async () => {
    const first = await acquireJobLease(RETENTION_LEASE_KEY, 1);
    expect(first).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await acquireJobLease(RETENTION_LEASE_KEY);
    expect(second).not.toBeNull();
    expect(second!.fencingToken).toBe(first!.fencingToken + 1);
    await releaseJobLease(second!, "success");
  });

  it("fences a stale owner before its next mutation", async () => {
    const stale = await acquireJobLease(RETENTION_LEASE_KEY, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const current = await acquireJobLease(RETENTION_LEASE_KEY);
    expect(current).not.toBeNull();
    await expect(assertJobLease(stale!)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(assertJobLease(current!)).resolves.toBeUndefined();
    await releaseJobLease(current!, "success");
  });

  it("does not let one owner release another owner's lease", async () => {
    const first = await acquireJobLease(RETENTION_LEASE_KEY, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await acquireJobLease(RETENTION_LEASE_KEY);
    await releaseJobLease(first!, "success");
    const stillLive = await db.systemJobLease.findUnique({ where: { key: RETENTION_LEASE_KEY } });
    expect(stillLive?.status).toBe("running");
    expect(stillLive?.ownerId).toBe(second!.ownerId);
    await releaseJobLease(second!, "success");
  });

  it("records failure outcomes without leaving a live lease", async () => {
    const lease = await acquireJobLease(RETENTION_LEASE_KEY);
    await releaseJobLease(lease!, "failed");
    const row = await db.systemJobLease.findUnique({ where: { key: RETENTION_LEASE_KEY } });
    expect(row?.status).toBe("released");
    expect(row?.lastOutcome).toBe("failed");
  });

  it("runs only one of two concurrent sweeps and scrubs only once", async () => {
    for (let i = 0; i < 5; i++) await seedSignal(`f5-race-${i}`, Date.now() - 200 * DAY);
    const results = await Promise.all([
      runSystemRiskRetentionSweep({ token: TOKEN }),
      runSystemRiskRetentionSweep({ token: TOKEN }),
    ]);
    const successes = results.filter((r) => r.success);
    const conflicts = results.filter((r) => r.conflict);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(successes[0].data?.scrubbed).toBe(5);
    const remaining = await db.agentRiskSignal.count({
      where: { id: { in: Array.from({ length: 5 }, (_, i) => `f5-race-${i}`) }, deletedAt: null },
    });
    expect(remaining).toBe(0);
  });

  it("records the non-secret lease owner in the sweep audit event", async () => {
    await seedSignal("f5-audit-1", Date.now() - 200 * DAY);
    const result = await runSystemRiskRetentionSweep({ token: TOKEN });
    expect(result.success).toBe(true);
    const audit = await db.auditLog.findFirst({
      where: { action: "risk_intelligence.retention_sweep" },
    });
    expect(audit?.details).toContain("leaseOwner");
    expect(audit?.details).toContain("fencingToken");
  });

  it("allows only one of two genuinely independent Node processes", async () => {
    const run = () =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [TSX_CLI, CONTENDER], {
          cwd: repoRoot,
          env: { ...process.env, DATABASE_URL: url },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += String(chunk)));
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));
        child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });

    const [a, b] = await Promise.all([run(), run()]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    const claimed = [a, b].filter((r) => r.stdout.includes('"acquired":true'));
    const refused = [a, b].filter((r) => r.stdout.includes('"acquired":false'));
    expect(claimed).toHaveLength(1);
    expect(refused).toHaveLength(1);
  }, 60_000);
});
