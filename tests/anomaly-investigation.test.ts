/**
 * Anomaly investigation (Priority 9).
 *
 * The audit found monitoring that raised findings but kept no history, no owner, no
 * disposition and no way to say "this rule is wrong for this record". These tests
 * prove the opposite, including the hard case: a closed finding that is still true
 * comes back by itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";
import {
  ALERT_BUDGET_PER_RUN,
  MAX_SUPPRESSION_DAYS,
  NOTIFY_QUIET_HOURS,
  canonicalJson,
  investigationDueAt,
  scanDisposition,
  selectAlerts,
  suppressionCovers,
  suppressionExpiry,
  suppressionIsActive,
} from "@/lib/anomaly-investigation";
import { snapshotHash } from "@/lib/anomaly-snapshot";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name) ? { name, value: mockCookieStore.get(name)! } : undefined,
    set: (name: string, value: string) => mockCookieStore.set(name, value),
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));


import { runAnomalyScan } from "@/lib/actions/anomaly.actions";
import {
  addAnomalyInvestigationComment,
  assignAnomaly,
  closeAnomalyInvestigation,
  completeAnomalyInvestigationTask,
  createAnomalySuppression,
  getAnomalyInvestigation,
  listAnomalyScanRuns,
  listAnomalySuppressions,
  reopenAnomalyFinding,
  revokeAnomalySuppression,
} from "@/lib/actions/anomaly-investigation.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setAdminSession(user: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Test",
      role: "admin",
      modules: ["momo"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

function today(offset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset))
    .toISOString()
    .slice(0, 10);
}

let counter = 0;

async function fixture() {
  counter += 1;
  const tenant = await createTestTenant({ momo: true, susu: false });
  const location = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Investigation Branch", code: `INV-${counter}` },
  });
  const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });
  const worker = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `investigation-worker-${counter}@test.invalid`,
      fullName: "Kofi Worker",
      role: "worker",
      status: "active",
      passwordHash: "x",
      momoEnabled: true,
      locationId: location.id,
    },
  });
  return { tenant, location, admin, worker };
}

async function createShortage(
  f: { tenant: { id: string }; location: { id: string }; worker: { id: string } },
  difference = -120
) {
  return prisma.dailyAccount.create({
    data: {
      tenantId: f.tenant.id,
      locationId: f.location.id,
      workerId: f.worker.id,
      businessDate: new Date(`${today(1)}T00:00:00.000Z`),
      status: "submitted",
      submittedAt: new Date(Date.now() - 4 * 86_400_000),
      calculatedDifference: difference,
    },
  });
}

describe("investigation arithmetic", () => {
  it("hashes the same evidence to the same digest regardless of key order", () => {
    const a = snapshotHash("dailyAccount", "acct-1", { amount: 12, who: "Kofi", days: 3 });
    const b = snapshotHash("dailyAccount", "acct-1", { who: "Kofi", days: 3, amount: 12 });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
    expect(snapshotHash("dailyAccount", "acct-1", { amount: 12.01, who: "Kofi", days: 3 })).not.toBe(a);
    expect(snapshotHash("dailyAccount", "acct-2", { amount: 12, who: "Kofi", days: 3 })).not.toBe(a);
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(
      '{"a":[2,{"c":3,"d":4}],"b":1}'
    );
  });

  it("reopens a closed finding that is still true, unless it is suppressed", () => {
    expect(
      scanDisposition({
        status: "resolved",
        disposition: "genuine",
        lastSnapshotHash: "a",
        newSnapshotHash: "b",
        suppressed: false,
      })
    ).toBe("reopen");
    expect(
      scanDisposition({
        status: "resolved",
        disposition: "genuine",
        lastSnapshotHash: "a",
        newSnapshotHash: "b",
        suppressed: true,
      })
    ).toBe("unchanged");
    expect(
      scanDisposition({
        status: "open",
        disposition: null,
        lastSnapshotHash: "a",
        newSnapshotHash: "b",
        suppressed: false,
      })
    ).toBe("updated");
    expect(
      scanDisposition({
        status: "open",
        disposition: null,
        lastSnapshotHash: "a",
        newSnapshotHash: "a",
        suppressed: false,
      })
    ).toBe("unchanged");
  });

  it("bounds a suppression and lets it expire", () => {
    const expiry = suppressionExpiry(365);
    const days = Math.round((expiry.getTime() - Date.now()) / 86_400_000);
    expect(days).toBe(MAX_SUPPRESSION_DAYS);
    expect(
      suppressionIsActive({ revokedAt: null, expiresAt: new Date(Date.now() + 86_400_000) })
    ).toBe(true);
    expect(
      suppressionIsActive({ revokedAt: null, expiresAt: new Date(Date.now() - 86_400_000) })
    ).toBe(false);
    expect(
      suppressionIsActive({
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
    ).toBe(false);
    expect(
      suppressionCovers(
        { ruleKey: "daily_shortage", entityType: "dailyAccount", entityId: "a" },
        { ruleKey: "daily_shortage", entityType: "dailyAccount", entityId: "a" }
      )
    ).toBe(true);
    expect(
      suppressionCovers(
        { ruleKey: "daily_shortage", entityType: "dailyAccount", entityId: "a" },
        { ruleKey: "daily_shortage", entityType: "dailyAccount", entityId: "b" }
      )
    ).toBe(false);
    expect(
      suppressionCovers(
        { ruleKey: "daily_shortage", entityType: null, entityId: null },
        { ruleKey: "daily_shortage", entityType: "dailyAccount", entityId: "b" }
      )
    ).toBe(true);
  });

  it("alerts only on new high findings, within a budget and a quiet window", () => {
    const now = new Date("2026-12-01T12:00:00Z");
    const rows = [
      { fingerprint: "a", severity: "high", lastNotifiedAt: null },
      { fingerprint: "b", severity: "high", lastNotifiedAt: null },
      { fingerprint: "c", severity: "high", lastNotifiedAt: null },
      { fingerprint: "d", severity: "high", lastNotifiedAt: null },
      { fingerprint: "e", severity: "medium", lastNotifiedAt: null },
      {
        fingerprint: "f",
        severity: "high",
        lastNotifiedAt: new Date(now.getTime() - NOTIFY_QUIET_HOURS * 3_600_000 + 60_000),
      },
    ];
    const selected = selectAlerts(rows, now);
    expect(selected.map((row) => row.fingerprint)).toEqual(["a", "b", "c"]);
    expect(selected).toHaveLength(ALERT_BUDGET_PER_RUN);

    const afterWindow = selectAlerts(
      [
        {
          fingerprint: "g",
          severity: "high",
          lastNotifiedAt: new Date(now.getTime() - (NOTIFY_QUIET_HOURS + 1) * 3_600_000),
        },
      ],
      now
    );
    expect(afterWindow).toHaveLength(1);
  });

  it("gives a high finding a shorter review clock than a low one", () => {
    const from = new Date("2026-12-01T00:00:00Z");
    expect(investigationDueAt("high", from).toISOString()).toBe("2026-12-03T00:00:00.000Z");
    expect(investigationDueAt("medium", from).toISOString()).toBe("2026-12-06T00:00:00.000Z");
    expect(investigationDueAt("low", from).toISOString()).toBe("2026-12-11T00:00:00.000Z");
  });
});

describe("finding history and reopening", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("records detection once and appends an event when the evidence changes", async () => {
    const f = await fixture();
    const account = await createShortage(f, -120);
    await setAdminSession(f.admin);

    const first = await runAnomalyScan({ from: today(10), to: today(0) });
    expect(first.success).toBe(true);
    expect((first.data as { created: number }).created).toBeGreaterThanOrEqual(1);
    const finding = await prisma.operationalAnomaly.findFirstOrThrow({
      where: { tenantId: f.tenant.id, ruleKey: "daily_shortage" },
    });
    expect(finding.firstSeenAt).toBeTruthy();
    expect(finding.snapshotHash).toHaveLength(64);

    const eventsAfterFirst = await prisma.anomalyFindingEvent.findMany({
      where: { anomalyId: finding.id },
    });
    expect(eventsAfterFirst).toHaveLength(1);
    expect(eventsAfterFirst[0].kind).toBe("detected");
    expect(eventsAfterFirst[0].snapshotHash).toBe(finding.snapshotHash);

    // A second identical scan neither duplicates the finding nor invents history.
    await runAnomalyScan({ from: today(10), to: today(0) });
    expect(
      await prisma.operationalAnomaly.count({
        where: { tenantId: f.tenant.id, ruleKey: "daily_shortage" },
      })
    ).toBe(1);
    expect(
      await prisma.anomalyFindingEvent.count({ where: { anomalyId: finding.id } })
    ).toBe(1);

    // A larger shortage is new evidence: the earlier event keeps the old values.
    await prisma.dailyAccount.update({
      where: { id: account.id },
      data: { calculatedDifference: -400 },
    });
    await runAnomalyScan({ from: today(10), to: today(0) });
    const events = await prisma.anomalyFindingEvent.findMany({
      where: { anomalyId: finding.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events).toHaveLength(2);
    expect(events[1].kind).toBe("rescan");
    expect(events[1].metricValue?.toString()).toBe("400");
    expect(events[0].snapshotHash).not.toBe(events[1].snapshotHash);
    const refreshed = await prisma.operationalAnomaly.findUniqueOrThrow({
      where: { id: finding.id },
    });
    expect(refreshed.metricValue?.toString()).toBe("400");
    expect(refreshed.snapshotHash).toBe(events[1].snapshotHash);
  });

  it("reopens a resolved finding whose condition is still there", async () => {
    const f = await fixture();
    await createShortage(f);
    await setAdminSession(f.admin);
    await runAnomalyScan({ from: today(10), to: today(0) });
    const finding = await prisma.operationalAnomaly.findFirstOrThrow({
      where: { tenantId: f.tenant.id, ruleKey: "daily_shortage" },
    });

    const closed = await closeAnomalyInvestigation({
      anomalyId: finding.id,
      disposition: "inconclusive",
      note: "Agent says the money was moved to the safe, checking the count sheet.",
    });
    expect(closed.success, closed.error).toBe(true);
    expect(
      (await prisma.operationalAnomaly.findUniqueOrThrow({ where: { id: finding.id } })).status
    ).toBe("resolved");

    const rescanned = await runAnomalyScan({ from: today(10), to: today(0) });
    expect((rescanned.data as { reopened: number }).reopened).toBe(1);
    const reopened = await prisma.operationalAnomaly.findUniqueOrThrow({
      where: { id: finding.id },
    });
    expect(reopened.status).toBe("open");
    expect(reopened.reopenCount).toBe(1);
    expect(reopened.resolvedAt).toBeNull();
    const kinds = (
      await prisma.anomalyFindingEvent.findMany({
        where: { anomalyId: finding.id },
        orderBy: { createdAt: "asc" },
      })
    ).map((row) => row.kind);
    expect(kinds).toContain("reopened");

    const history = await getAnomalyInvestigation(finding.id);
    expect(history.success).toBe(true);
    expect(history.data?.reopenCount).toBe(1);
    expect(history.data?.events.map((row) => row.kind)).toContain("resolved");
  });

  it("keeps a suppressed finding quiet, then reopens once the suppression is lifted", async () => {
    const f = await fixture();
    const account = await createShortage(f);
    await setAdminSession(f.admin);
    await runAnomalyScan({ from: today(10), to: today(0) });
    const finding = await prisma.operationalAnomaly.findFirstOrThrow({
      where: { tenantId: f.tenant.id, ruleKey: "daily_shortage" },
    });

    const closed = await closeAnomalyInvestigation({
      anomalyId: finding.id,
      disposition: "false_positive",
      note: "The seed record is a training account, so this rule is wrong for it.",
      suppressDays: 14,
    });
    expect(closed.success, closed.error).toBe(true);
    const suppression = await prisma.anomalySuppression.findFirstOrThrow({
      where: { tenantId: f.tenant.id, ruleKey: "daily_shortage" },
    });
    expect(suppression.entityId).toBe(account.id);
    const days = Math.round((suppression.expiresAt.getTime() - Date.now()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(13);

    const quiet = await runAnomalyScan({ from: today(10), to: today(0) });
    expect((quiet.data as { suppressed: number }).suppressed).toBe(1);
    expect((quiet.data as { reopened: number }).reopened).toBe(0);
    expect(
      (await prisma.operationalAnomaly.findUniqueOrThrow({ where: { id: finding.id } })).status
    ).toBe("resolved");

    const list = await listAnomalySuppressions();
    expect(list.data?.some((row) => row.ruleKey === "daily_shortage" && row.active)).toBe(true);

    const lifted = await revokeAnomalySuppression({
      id: suppression.id,
      reason: "The training account was promoted to a live account.",
    });
    expect(lifted.success, lifted.error).toBe(true);

    const loud = await runAnomalyScan({ from: today(10), to: today(0) });
    expect((loud.data as { reopened: number }).reopened).toBe(1);
    expect(
      (await prisma.operationalAnomaly.findUniqueOrThrow({ where: { id: finding.id } })).status
    ).toBe("open");
  });

  it("does not raise the same alert twice and stays inside the alert budget", async () => {
    const f = await fixture();
    await createShortage(f);
    await setAdminSession(f.admin);
    await runAnomalyScan({ from: today(10), to: today(0) });

    const notifications = await prisma.tenantNotification.findMany({
      where: { tenantId: f.tenant.id, dedupeKey: { startsWith: "anomaly:" } },
    });
    // A medium finding is real but not worth an interruption.
    expect(notifications).toHaveLength(0);

    const second = await runAnomalyScan({ from: today(10), to: today(0) });
    expect((second.data as { notified: number }).notified).toBe(0);

    const runs = await listAnomalyScanRuns();
    expect(runs.data?.length).toBeGreaterThanOrEqual(2);
    expect(runs.data?.[0].trigger).toBe("manual");
    expect(runs.limits?.alertBudget).toBe(ALERT_BUDGET_PER_RUN);
    expect(
      await prisma.anomalyScanRun.count({
        where: { tenantId: f.tenant.id, status: "completed" },
      })
    ).toBe(2);
  });
});

describe("investigation workflow", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function findingOf(f: Awaited<ReturnType<typeof fixture>>) {
    await createShortage(f);
    await setAdminSession(f.admin);
    await runAnomalyScan({ from: today(10), to: today(0) });
    return prisma.operationalAnomaly.findFirstOrThrow({
      where: { tenantId: f.tenant.id, ruleKey: "daily_shortage" },
    });
  }

  it("opens an investigation with a checklist, assigns an owner and records a due date", async () => {
    const f = await fixture();
    const finding = await findingOf(f);

    const opened = await getAnomalyInvestigation(finding.id);
    expect(opened.success, opened.error).toBe(true);
    expect(opened.data?.status).toBe("open");
    expect(opened.data?.tasks).toHaveLength(4);
    expect(opened.data?.events.map((row) => row.kind)).toContain("detected");

    const assigned = await assignAnomaly({ anomalyId: finding.id, assigneeId: f.worker.id });
    expect(assigned.success, assigned.error).toBe(true);
    const after = await getAnomalyInvestigation(finding.id);
    expect(after.data?.assigneeName).toBe("Kofi Worker");
    expect(after.data?.status).toBe("investigating");
    expect(after.data?.dueAt).toBeTruthy();
    expect(after.data?.overdue).toBe(false);

    const taskId = after.data!.tasks[0].id;
    const done = await completeAnomalyInvestigationTask({
      anomalyId: finding.id,
      taskId,
      done: true,
    });
    expect(done.success, done.error).toBe(true);
    const withTask = await getAnomalyInvestigation(finding.id);
    expect(withTask.data?.tasks[0].done).toBe(true);
    expect(withTask.data?.tasks[0].doneByName).toBe("Test Admin");

    const comment = await addAnomalyInvestigationComment({
      anomalyId: finding.id,
      body: "Count sheet shows the missing cash was banked late.",
    });
    expect(comment.success, comment.error).toBe(true);
    const withComment = await getAnomalyInvestigation(finding.id);
    expect(withComment.data?.comments).toHaveLength(1);
    expect(withComment.data?.comments[0].authorName).toBe("Test Admin");
  });

  it("refuses to close a genuine finding without the correction that fixed it", async () => {
    const f = await fixture();
    const finding = await findingOf(f);

    const noLink = await closeAnomalyInvestigation({
      anomalyId: finding.id,
      disposition: "genuine",
      note: "Confirmed a shortage and recorded a correction for it.",
    });
    expect(noLink.success).toBe(false);
    expect(noLink.error).toMatch(/link the correction/i);

    const wrongLink = await closeAnomalyInvestigation({
      anomalyId: finding.id,
      disposition: "genuine",
      note: "Confirmed a shortage and recorded a correction for it.",
      linkedCorrectionType: "momoTransaction",
      linkedCorrectionId: "does-not-exist",
    });
    expect(wrongLink.success).toBe(false);
    expect(wrongLink.error).toMatch(/not found/i);

    const transaction = await prisma.momoTransaction.create({
      data: {
        tenantId: f.tenant.id,
        locationId: f.location.id,
        workerId: f.worker.id,
        type: "cash_in",
        network: "mtn",
        direction: "inflow",
        amount: 120,
        status: "completed",
        reference: `CORR-${counter}`,
        idempotencyKey: `corr-${counter}-${Date.now()}`,
        businessDate: new Date(`${today(1)}T00:00:00.000Z`),
        occurredAt: new Date(`${today(1)}T10:00:00.000Z`),
        recordedById: f.admin.id,
      },
    });

    const closed = await closeAnomalyInvestigation({
      anomalyId: finding.id,
      disposition: "genuine",
      note: "Recount found the cash was posted to the wrong day; reversal recorded.",
      linkedCorrectionType: "momoTransaction",
      linkedCorrectionId: transaction.id,
    });
    expect(closed.success, closed.error).toBe(true);
    const stored = await prisma.operationalAnomaly.findUniqueOrThrow({ where: { id: finding.id } });
    expect(stored.status).toBe("resolved");
    const history = await getAnomalyInvestigation(finding.id);
    expect(history.data?.status).toBe("closed");
    expect(history.data?.disposition).toBe("genuine");
    expect(history.data?.linkedCorrectionId).toBe(transaction.id);

    // Closing a financial record is not part of closing a finding.
    expect(
      await prisma.momoTransaction.findUniqueOrThrow({ where: { id: transaction.id } })
    ).toBeTruthy();
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: f.tenant.id, action: "anomaly.investigation_closed" },
    });
    expect(JSON.parse(String(audit.details)).financialMutation).toBe(false);
  });

  it("reopens a closed finding by hand and records why", async () => {
    const f = await fixture();
    const finding = await findingOf(f);
    await closeAnomalyInvestigation({
      anomalyId: finding.id,
      disposition: "inconclusive",
      note: "Could not reach the agent before the review window closed.",
    });

    const tooShort = await reopenAnomalyFinding({ anomalyId: finding.id, note: "no" });
    expect(tooShort.success).toBe(false);

    const reopened = await reopenAnomalyFinding({
      anomalyId: finding.id,
      note: "The agent called back and confirmed cash was short.",
    });
    expect(reopened.success, reopened.error).toBe(true);
    const stored = await prisma.operationalAnomaly.findUniqueOrThrow({ where: { id: finding.id } });
    expect(stored.status).toBe("open");
    expect(stored.reopenCount).toBe(1);
    const history = await getAnomalyInvestigation(finding.id);
    expect(history.data?.status).toBe("investigating");
    expect(history.data?.disposition).toBeNull();
  });

  it("requires a reason and a real rule before suppressing anything", async () => {
    const f = await fixture();
    await setAdminSession(f.admin);

    const shortReason = await createAnomalySuppression({
      ruleKey: "daily_shortage",
      reason: "noise",
      days: 30,
    });
    expect(shortReason.success).toBe(false);

    const unknownRule = await createAnomalySuppression({
      ruleKey: "not_a_rule",
      reason: "This rule never applies to our business at all.",
      days: 30,
    });
    expect(unknownRule.success).toBe(false);
    expect(unknownRule.error).toMatch(/does not exist/i);

    const tooLong = await createAnomalySuppression({
      ruleKey: "daily_shortage",
      reason: "Our seeded test records always show this on the first day.",
      days: 999,
    });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error).toMatch(/180/i);

    const created = await createAnomalySuppression({
      ruleKey: "daily_shortage",
      reason: "Our seeded test records always show this on the first day.",
      days: MAX_SUPPRESSION_DAYS,
    });
    expect(created.success, created.error).toBe(true);
    const row = await prisma.anomalySuppression.findFirstOrThrow({
      where: { tenantId: f.tenant.id },
    });
    const days = Math.round((row.expiresAt.getTime() - Date.now()) / 86_400_000);
    expect(days).toBe(MAX_SUPPRESSION_DAYS);
    expect(row.entityType).toBeNull();
  });

  it("keeps investigations inside the tenant", async () => {
    const f = await fixture();
    const finding = await findingOf(f);

    const otherTenant = await createTestTenant({ momo: true, susu: false });
    const otherAdmin = await createTestAdmin({
      tenantId: otherTenant.id,
      momo: true,
      susu: false,
    });
    await setAdminSession(otherAdmin);

    const refused = await getAnomalyInvestigation(finding.id);
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/not found/i);

    const assignRefused = await assignAnomaly({
      anomalyId: finding.id,
      assigneeId: f.worker.id,
    });
    expect(assignRefused.success).toBe(false);

    const closeRefused = await closeAnomalyInvestigation({
      anomalyId: finding.id,
      disposition: "inconclusive",
      note: "Trying to close another business's finding from here.",
    });
    expect(closeRefused.success).toBe(false);
    expect(await prisma.anomalyInvestigation.count({ where: { tenantId: otherTenant.id } })).toBe(
      0
    );
  });
});

describe("scheduled scan", () => {
  const original = process.env.ANOMALY_SCAN_TOKEN;

  beforeEach(async () => {
    await cleanDatabase();
    process.env.ANOMALY_SCAN_TOKEN = "scheduled-scan-token";
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ANOMALY_SCAN_TOKEN;
    else process.env.ANOMALY_SCAN_TOKEN = original;
  });

  it("is disabled until a token is configured", async () => {
    delete process.env.ANOMALY_SCAN_TOKEN;
    const { POST } = await import("@/app/api/internal/anomaly/scan/route");
    const response = await POST(
      new NextRequest("http://localhost/api/internal/anomaly/scan", { method: "POST" })
    );
    expect(response.status).toBe(503);
  });

  it("refuses a request without the shared secret", async () => {
    const { POST } = await import("@/app/api/internal/anomaly/scan/route");
    const response = await POST(
      new NextRequest("http://localhost/api/internal/anomaly/scan", {
        method: "POST",
        headers: { "x-scan-token": "wrong" },
      })
    );
    expect(response.status).toBe(403);
  });

  it("scans without a session and records the run as scheduled", async () => {
    const f = await fixture();
    await createShortage(f);
    // No admin session: the scheduler is not a person.
    mockCookieStore.clear();

    const { POST } = await import("@/app/api/internal/anomaly/scan/route");
    const response = await POST(
      new NextRequest("http://localhost/api/internal/anomaly/scan?limit=50", {
        method: "POST",
        headers: { "x-scan-token": "scheduled-scan-token" },
      })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      scanned: number;
      results: Array<{ tenantId: string; created: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.scanned).toBeGreaterThanOrEqual(1);

    const run = await prisma.anomalyScanRun.findFirstOrThrow({
      where: { tenantId: f.tenant.id },
    });
    expect(run.trigger).toBe("scheduled");
    expect(run.status).toBe("completed");
    expect(run.scanned).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.operationalAnomaly.count({ where: { tenantId: f.tenant.id } })
    ).toBeGreaterThanOrEqual(1);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: f.tenant.id, action: "anomaly.scan_completed" },
    });
    expect(JSON.parse(String(audit.details)).trigger).toBe("scheduled");
  });
});
