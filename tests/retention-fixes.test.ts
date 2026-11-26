/**
 * Regression tests for the verified retention defects F1, F2, F3, F4, F6, F7.
 *
 * Uses a dedicated disposable SQLite database under the OS temp directory with
 * synthetic rows only. No production access. F5 remains open and is documented
 * in docs/RETENTION_SCRIPT_VERIFICATION.md.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createPrismaClient } from "@/lib/prisma-client";
import { db as actionDb } from "@/lib/db";
import { runSystemRiskRetentionSweep } from "@/lib/actions/risk-governance.actions";
import { verifyRiskRetentionToken } from "@/lib/security/risk-retention-token";
import { expireStaleRiskSignals } from "@/lib/actions/risk-intelligence.actions";
import { POST } from "@/app/api/internal/risk-intelligence/retention/route";
import {
  assertDisposableDatabase,
  repoRoot,
  sqliteUrlFor,
} from "../scripts/test-database-paths.cjs";

const DAY = 86_400_000;
const TOKEN = "local-synthetic-retention-token-not-a-secret";
const PRISMA_CLI = path.join(repoRoot, "node_modules", "prisma", "build", "index.js");
const CRON = path.join(repoRoot, "scripts", "run-risk-retention-cron.mjs");

let dir: string;
let url: string;
let db: ReturnType<typeof createPrismaClient>;
let originalToken: string | undefined;
let originalRateSecret: string | undefined;
let originalDatabaseUrl: string | undefined;

const iso = (ms: number) => new Date(ms).toISOString();

function preview(): {
  expiredCandidates: number;
  scrubCandidates: number;
  auditCandidates: number;
  holdsSkipped: number;
  legalHoldReviewCandidates: number;
  scrubBatchLimited: boolean;
  auditBatchLimited: boolean;
} {
  const out = execFileSync(process.execPath, [CRON, "--dry-run"], {
    cwd: repoRoot,
    env: { ...process.env, RETENTION_PREVIEW_DATABASE_URL: url },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = out.split(/\r?\n/).find((l) => l.includes("[risk-retention-preview] ok "));
  if (!line) throw new Error("preview produced no result line");
  return JSON.parse(line.slice(line.indexOf("{")));
}

async function signal(
  id: string,
  options: {
    status?: string;
    expiresAt: number;
    tenantId?: string | null;
    sourceType?: string;
    subjectKey?: string;
    withdrawnAt?: number | null;
    resolvedAt?: number | null;
    deletedAt?: number | null;
  }
) {
  return db.agentRiskSignal.create({
    data: {
      id,
      tenantId: options.tenantId ?? null,
      subjectKey: options.subjectKey ?? `subject-${id}`,
      keyBasis: "tenant-id",
      saltVersion: 1,
      category: "shortage",
      severity: "high",
      status: options.status ?? "expired",
      sourceType: options.sourceType ?? `source-${id}`,
      sourceId: `source-id-${id}`,
      observedFrom: new Date(Date.now() - 300 * DAY),
      observedTo: new Date(Date.now() - 281 * DAY),
      expiresAt: new Date(options.expiresAt),
      withdrawnAt: options.withdrawnAt ? new Date(options.withdrawnAt) : null,
      resolvedAt: options.resolvedAt ? new Date(options.resolvedAt) : null,
      deletedAt: options.deletedAt ? new Date(options.deletedAt) : null,
    },
  });
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode", "retention-vitest-"));
  const file = assertDisposableDatabase(path.join(dir, "test.db"));
  url = sqliteUrlFor(file);
  execFileSync(
    process.execPath,
    [PRISMA_CLI, "db", "push", "--schema=prisma/schema.prisma"],
    { cwd: repoRoot, env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" }
  );
  db = createPrismaClient(url);
  originalToken = process.env.RISK_RETENTION_TOKEN;
  originalRateSecret = process.env.RATE_LIMIT_HMAC_SECRET;
  originalDatabaseUrl = process.env.DATABASE_URL;
  // Actions resolve their client lazily from DATABASE_URL; point them at the
  // dedicated disposable database before any action query runs.
  process.env.DATABASE_URL = url;
  process.env.RISK_RETENTION_TOKEN = TOKEN;
  process.env.RATE_LIMIT_HMAC_SECRET = "local-synthetic-rate-limit-secret";
}, 120_000);

afterAll(async () => {
  await actionDb.$disconnect();
  await db.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
  if (originalToken === undefined) delete process.env.RISK_RETENTION_TOKEN;
  else process.env.RISK_RETENTION_TOKEN = originalToken;
  if (originalRateSecret === undefined) delete process.env.RATE_LIMIT_HMAC_SECRET;
  else process.env.RATE_LIMIT_HMAC_SECRET = originalRateSecret;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

beforeEach(async () => {
  await db.riskControlEvent.deleteMany();
  await db.riskLegalHold.deleteMany();
  await db.riskIntelligenceDisclosure.deleteMany();
  await db.auditLog.deleteMany();
  await db.agentRiskSignal.deleteMany();
  await db.businessTenant.deleteMany();
});

describe("local retention defect fixes", () => {
  it("F1: scrubs many same-tenant rows without a unique-constraint abort", async () => {
    const tenant = await db.businessTenant.create({
      data: { code: "RT-F1", name: "F1 synthetic tenant" },
    });
    const past = Date.now() - 300 * DAY;
    await signal("f1-a", { expiresAt: past, tenantId: tenant.id, sourceType: "shared" });
    await signal("f1-b", { expiresAt: past, tenantId: tenant.id, sourceType: "shared" });

    const result = await runSystemRiskRetentionSweep({ token: TOKEN });
    expect(result.success).toBe(true);
    expect(result.data?.scrubbed).toBe(2);

    const rows = await db.agentRiskSignal.findMany({ orderBy: { id: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.subjectKey)).toEqual(["scrubbed:f1-a", "scrubbed:f1-b"]);
    expect(rows.map((r) => r.sourceId)).toEqual(["scrubbed:f1-a", "scrubbed:f1-b"]);
    expect(rows.every((r) => r.deletedAt !== null && r.scrubbedAt !== null)).toBe(true);
    expect(rows.every((r) => r.internalNote === null)).toBe(true);
  });

  it("F2: a live legal-hold extension defers scrubbing for signal and subject holds", async () => {
    const now = Date.now();
    const past = now - 300 * DAY;
    await signal("f2-signal", { expiresAt: past });
    await signal("f2-subject", { expiresAt: past, subjectKey: "f2-held-subject" });
    await signal("f2-free", { expiresAt: past });

    const extension = iso(now + 10 * DAY);
    await db.riskLegalHold.create({
      data: {
        id: "f2-hold-signal",
        scopeType: "signal",
        scopeId: "f2-signal",
        dpoReference: "F2-S",
        reason: "synthetic",
        authorisedById: "owner",
        reviewDate: new Date(now - 20 * DAY),
        extensionUntil: new Date(extension),
        extensionReason: "synthetic extension",
      },
    });
    await db.riskLegalHold.create({
      data: {
        id: "f2-hold-subject",
        scopeType: "subject",
        scopeId: "f2-held-subject",
        dpoReference: "F2-T",
        reason: "synthetic",
        authorisedById: "owner",
        reviewDate: new Date(now - 20 * DAY),
        extensionUntil: new Date(extension),
      },
    });

    const before = preview();
    expect(before.holdsSkipped).toBe(2);
    expect(before.scrubCandidates).toBe(1);

    const result = await runSystemRiskRetentionSweep({ token: TOKEN });
    expect(result.data?.scrubbed).toBe(1);

    const held = await db.agentRiskSignal.findMany({
      where: { id: { in: ["f2-signal", "f2-subject"] } },
      orderBy: { id: "asc" },
    });
    expect(held.every((r) => r.deletedAt === null)).toBe(true);
    const free = await db.agentRiskSignal.findUniqueOrThrow({ where: { id: "f2-free" } });
    expect(free.deletedAt).not.toBeNull();
  });

  it("F3: stable ordering makes preview and sweep agree at the 500-row edge", async () => {
    const past = Date.now() - 300 * DAY;
    for (let i = 0; i < 503; i += 1) {
      await signal(`f3-${String(i).padStart(3, "0")}`, { expiresAt: past });
    }
    const before = preview();
    expect(before.scrubCandidates).toBe(500);
    expect(before.scrubBatchLimited).toBe(true);

    const first = await runSystemRiskRetentionSweep({ token: TOKEN });
    expect(first.data?.scrubbed).toBe(before.scrubCandidates);

    const remaining = preview();
    expect(remaining.scrubCandidates).toBe(3);
    const second = await runSystemRiskRetentionSweep({ token: TOKEN });
    expect(second.data?.scrubbed).toBe(3);
  }, 60_000);

  it("F4: legal-hold review event is created once across repeated sweeps", async () => {
    const now = Date.now();
    await db.riskLegalHold.create({
      data: {
        id: "f4-hold",
        scopeType: "request",
        scopeId: "f4-request",
        dpoReference: "F4-R",
        reason: "synthetic",
        authorisedById: "owner",
        reviewDate: new Date(now - 20 * DAY),
        caseClosureDate: new Date(now - 15 * DAY),
      },
    });
    const first = await runSystemRiskRetentionSweep({ token: TOKEN });
    const second = await runSystemRiskRetentionSweep({ token: TOKEN });
    expect(first.data?.audited).toBe(0);
    expect(second.data?.audited).toBe(0);
    const events = await db.riskControlEvent.findMany({
      where: { action: "legal_hold_review_due" },
    });
    expect(events).toHaveLength(1);
  });

  it("F6: expireStaleRiskSignals skips rows already deleted", async () => {
    const past = Date.now() - DAY;
    await signal("f6-live", { status: "open", expiresAt: past });
    await signal("f6-deleted", {
      status: "open",
      expiresAt: past,
      deletedAt: Date.now() - 10 * DAY,
    });
    const result = await expireStaleRiskSignals({ token: TOKEN });
    expect(result.success).toBe(true);
    expect(result.expired).toBe(1);
    const live = await db.agentRiskSignal.findUniqueOrThrow({ where: { id: "f6-live" } });
    const deleted = await db.agentRiskSignal.findUniqueOrThrow({ where: { id: "f6-deleted" } });
    expect(live.status).toBe("expired");
    expect(deleted.status).toBe("open");
  });

  it("F7: token verifier and route authorise without mutating", async () => {
    const past = Date.now() - 300 * DAY;
    await signal("f7-rows", { expiresAt: past });
    const before = await db.agentRiskSignal.count();

    expect(verifyRiskRetentionToken({ token: TOKEN })).toBe(true);
    expect(verifyRiskRetentionToken({ token: `${TOKEN}-wrong` })).toBe(false);
    expect(verifyRiskRetentionToken({ token: "" })).toBe(false);
    expect(await db.agentRiskSignal.count()).toBe(before);

    const response = await POST(
      new NextRequest("http://localhost/api/internal/risk-intelligence/retention", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}-wrong` },
      })
    );
    expect(response.status).toBe(403);
    expect(await db.agentRiskSignal.count()).toBe(before);
    const row = await db.agentRiskSignal.findUniqueOrThrow({ where: { id: "f7-rows" } });
    expect(row.deletedAt).toBeNull();
  });
});
