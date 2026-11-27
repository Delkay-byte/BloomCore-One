/**
 * Phase 5 — reconciliation sessions, difference detection and daily closing.
 *
 * Runs against the disposable SQLite unit database. Every assertion goes
 * through an exported server action or the resulting database rows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { prisma, cleanDatabase } from "./setup";
import {
  createTenantWithBranch,
  createBranch,
  createAdminInTenant,
  createCollector,
  createAccount,
  recordContribution,
  openSession,
  sessionLines,
  runSession,
  sessionSetter,
  todayUtc,
} from "./phase5-helpers";
import {
  listReconciliationSessions,
  getReconciliationSession,
  reconcileSession,
  reviewReconciliationSession,
  closeReconciliationSession,
  raiseCasesForSession,
  openDailyCollectorClosing,
  declareDailyClosing,
  recordDailyClosingHandover,
  receiveDailyClosing,
  closeDailyClosing,
  listDailyClosings,
  getReconciliationOverview,
  reviewReconciliationLine,
} from "@/lib/actions/susu-reconciliation.actions";
import { getExceptionCase } from "@/lib/actions/susu-exception-cases.actions";
import {
  declareRemittance,
  acknowledgeRemittanceReceipt,
} from "@/lib/actions/susu-remittance.actions";

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

const setSession = sessionSetter(mockCookieStore);

describe("Phase 5 reconciliation sessions and detection", () => {
  let tenantId: string;
  let branchId: string;
  let admin: { id: string; tenantId: string | null; email: string };
  let admin2: { id: string; tenantId: string | null; email: string };
  let collector: Awaited<ReturnType<typeof createCollector>>;
  let accountId: string;
  let cycleId: string;

  beforeEach(async () => {
    await cleanDatabase();
    const seeded = await createTenantWithBranch();
    tenantId = seeded.tenant.id;
    branchId = seeded.branch.id;
    admin = seeded.admin;
    admin2 = await createAdminInTenant(tenantId, { fullName: "Approver Admin" });
    collector = await createCollector(tenantId, branchId);
    const account = await createAccount(tenantId, admin.id, collector.id);
    accountId = account.account.id;
    cycleId = account.cycle.id;
    await setSession(admin);
  });

  it("opens one session for a duplicate request and keeps detection idempotent", async () => {
    await recordContribution(tenantId, admin.id, collector.id, accountId, cycleId, 150);

    const first = await openSession({
      type: "daily_close",
      branchId,
      collectorId: collector.id,
    });
    expect(first.success).toBe(true);
    expect(first.data?.status).toBe("open");
    expect(first.data?.type).toBe("daily_close");
    expect(first.data?.branchId).toBe(branchId);
    const sessionId = first.data!.id;

    const second = await openSession({
      type: "daily_close",
      branchId,
      collectorId: collector.id,
    });
    expect(second.success).toBe(true);
    expect(second.data?.id).toBe(sessionId);

    const run1 = await runSession(sessionId);
    expect(run1.created).toBe(1);

    const run2 = await runSession(sessionId);
    expect(run2.lines).toBe(1);
    expect(run2.created).toBe(0);

    const { session, lines } = await sessionLines(sessionId);
    expect(lines).toHaveLength(1);
    expect(lines[0].revision).toBe(1);
    expect(lines[0].status).toBe("missing_evidence");
    expect(session.runCount).toBe(2);
    expect(session.status).toBe("matched");
  });

  it("rejects an invalid period and a collector opening a formal remittance review", async () => {
    const day = todayUtc();
    const future = new Date(day.getTime() + 86_400_000 * 400);
    const tooLong = await openSession({
      type: "daily_close",
      branchId,
      collectorId: collector.id,
      periodStart: day,
      periodEnd: future,
    });
    expect(tooLong.success).toBe(false);

    await setSession(collector.user, "collector");
    const collectorRemittance = await openSession({ type: "remittance" });
    expect(collectorRemittance.success).toBe(false);
    expect(collectorRemittance.error).toMatch(/daily closing/i);

    const collectorDaily = await openSession({ type: "daily_close" });
    expect(collectorDaily.success).toBe(true);
    expect(collectorDaily.data?.branchId).toBe(branchId);
    expect(collectorDaily.data?.collectorId).toBe(collector.id);
  });

  it("enforces branch scope on session creation and read", async () => {
    const otherBranch = await createBranch(tenantId, "Other Branch");
    const manager = await createAdminInTenant(tenantId, {
      branchId,
      role: "branch_manager",
      fullName: "Branch Manager",
    });

    const outside = await openSession({
      type: "daily_close",
      branchId: otherBranch.id,
      collectorId: collector.id,
    });
    expect(outside.success).toBe(false);

    const own = await openSession({
      type: "branch_close",
      branchId,
    });
    expect(own.success).toBe(true);

    const otherSession = await openSession({
      type: "branch_close",
      branchId: otherBranch.id,
    });
    expect(otherSession.success).toBe(true);

    await setSession(manager);
    const listed = await listReconciliationSessions({});
    expect(listed.success).toBe(true);
    expect(listed.data?.sessions.map((s) => s.id)).toEqual([own.data!.id]);
    const hidden = await getReconciliationSession(otherSession.data!.id);
    expect(hidden).toBeNull();

    const outsider = await createAdminInTenant(
      (await createTenantWithBranch("Foreign Branch")).tenant.id
    );
    const foreignTenant = await prisma.user.findUniqueOrThrow({ where: { id: outsider.id } });
    await setSession({ id: outsider.id, tenantId: foreignTenant.tenantId!, email: outsider.email });
    const foreignGet = await getReconciliationSession(own.data!.id);
    expect(foreignGet).toBeNull();
    const foreignList = await listReconciliationSessions({});
    expect(foreignList.success).toBe(true);
    expect(foreignList.data?.total).toBe(0);
  });

  it("never lets a collector widen a list filter to another collector", async () => {
    const otherCollector = await createCollector(tenantId, branchId, "Other Collector");
    const otherSession = await openSession({
      type: "daily_close",
      branchId,
      collectorId: otherCollector.id,
    });
    expect(otherSession.success).toBe(true);
    const otherClosing = await openDailyCollectorClosing({ collectorId: otherCollector.id });
    expect(otherClosing.success).toBe(true);

    await setSession(collector.user, "collector");
    const widenedSessions = await listReconciliationSessions({
      collectorId: otherCollector.id,
    });
    expect(widenedSessions.success).toBe(false);
    const ownSessions = await listReconciliationSessions({});
    expect(ownSessions.success).toBe(true);
    expect(ownSessions.data?.total).toBe(0);

    const widenedClosings = await listDailyClosings({ collectorId: otherCollector.id });
    expect(widenedClosings.success).toBe(false);
    const ownClosings = await listDailyClosings({});
    expect(ownClosings.success).toBe(true);
    expect(ownClosings.data?.total).toBe(0);
  });

  it("records a balanced daily close and matches the session line", async () => {
    await recordContribution(tenantId, admin.id, collector.id, accountId, cycleId, 150);
    const opened = await openDailyCollectorClosing({ collectorId: collector.id });
    expect(opened.success).toBe(true);
    expect(opened.data?.expectedCash).toBe(150);

    await setSession(collector.user, "collector");
    const declared = await declareDailyClosing({
      closingId: opened.data!.id,
      declaredCash: 150,
    });
    expect(declared.success).toBe(true);

    await setSession(admin);
    const handover = await recordDailyClosingHandover({
      closingId: opened.data!.id,
      handoverAmount: 150,
    });
    expect(handover.success).toBe(true);

    await setSession(admin2);
    const received = await receiveDailyClosing({
      closingId: opened.data!.id,
      receivedAmount: 150,
    });
    expect(received.success).toBe(true);

    await setSession(admin);
    const closed = await closeDailyClosing({ closingId: opened.data!.id });
    expect(closed.success).toBe(true);
    expect(closed.data?.status).toBe("balanced");
    expect(closed.data?.varianceExpectedVsReceived).toBe(0);
    expect(closed.data?.outstandingAmount).toBe(0);
    expect(closed.data?.exceptionCaseId).toBeNull();

    const session = await openSession({
      type: "daily_close",
      branchId,
      collectorId: collector.id,
    });
    const run = await runSession(session.data!.id);
    expect(run.summary.outstandingTotal).toBe(0);
    expect(run.summary.matchedCount).toBe(1);

    const { lines } = await sessionLines(session.data!.id);
    const closing = lines.find((l) => l.entityType === "daily_closing");
    expect(closing?.status).toBe("matched");
    expect(closing?.expectedAmount).toBe(150);
    expect(closing?.receivedAmount).toBe(150);
    expect(closing?.variance).toBe(0);
  });

  it("classifies a cash shortfall and raises exactly one linked case on close", async () => {
    await recordContribution(tenantId, admin.id, collector.id, accountId, cycleId, 150);
    const opened = await openDailyCollectorClosing({ collectorId: collector.id });

    await setSession(collector.user, "collector");
    expect(
      (
        await declareDailyClosing({
          closingId: opened.data!.id,
          declaredCash: 140,
        })
      ).success
    ).toBe(false);
    const declared = await declareDailyClosing({
      closingId: opened.data!.id,
      declaredCash: 140,
      evidenceRef: "DECL-RCPT-001",
    });
    expect(declared.success).toBe(true);

    await setSession(admin);
    expect(
      (
        await recordDailyClosingHandover({
          closingId: opened.data!.id,
          handoverAmount: 140,
        })
      ).success
    ).toBe(true);

    await setSession(admin2);
    expect(
      (
        await receiveDailyClosing({
          closingId: opened.data!.id,
          receivedAmount: 140,
        })
      ).success
    ).toBe(false);
    const received = await receiveDailyClosing({
      closingId: opened.data!.id,
      receivedAmount: 140,
      evidenceRef: "OFFICE-RCPT-001",
    });
    expect(received.success).toBe(true);

    await setSession(admin);
    const closed = await closeDailyClosing({ closingId: opened.data!.id });
    expect(closed.success).toBe(true);
    expect(closed.data?.status).toBe("exception");
    expect(closed.data?.varianceExpectedVsReceived).toBe(10);
    expect(closed.data?.outstandingAmount).toBe(10);
    expect(closed.data?.exceptionCaseId).toBeTruthy();

    const linkedCase = await getExceptionCase(closed.data!.exceptionCaseId!);
    expect(linkedCase?.success).toBe(true);
    expect(linkedCase?.data?.category).toBe("daily_close");
    expect(linkedCase?.data?.amountAtStake).toBe(10);
    expect(linkedCase?.data?.links.some((l) => l.entityType === "daily_closing")).toBe(true);

    const session = await openSession({
      type: "daily_close",
      branchId,
      collectorId: collector.id,
    });
    const run = await runSession(session.data!.id);
    expect(run.summary.shortfallTotal).toBe(10);
    expect(run.summary.outstandingTotal).toBe(10);
    const { lines } = await sessionLines(session.data!.id);
    const closing = lines.find((l) => l.entityType === "daily_closing");
    expect(closing?.status).toBe("shortfall");
    expect(closing?.variance).toBe(10);
  });

  it("classifies an overage without treating it as a shortfall", async () => {
    await recordContribution(tenantId, admin.id, collector.id, accountId, cycleId, 150);
    const opened = await openDailyCollectorClosing({ collectorId: collector.id });

    await setSession(collector.user, "collector");
    expect(
      (
        await declareDailyClosing({
          closingId: opened.data!.id,
          declaredCash: 160,
        })
      ).success
    ).toBe(false);
    await declareDailyClosing({
      closingId: opened.data!.id,
      declaredCash: 160,
      evidenceRef: "DECL-OVER-001",
    });

    await setSession(admin);
    await recordDailyClosingHandover({
      closingId: opened.data!.id,
      handoverAmount: 160,
    });

    await setSession(admin2);
    await receiveDailyClosing({
      closingId: opened.data!.id,
      receivedAmount: 160,
      evidenceRef: "OFFICE-OVER-001",
    });

    await setSession(admin);
    const closed = await closeDailyClosing({ closingId: opened.data!.id });
    expect(closed.data?.status).toBe("exception");
    expect(closed.data?.varianceExpectedVsReceived).toBe(-10);

    const session = await openSession({
      type: "daily_close",
      branchId,
      collectorId: collector.id,
    });
    const run = await runSession(session.data!.id);
    expect(run.summary.overageTotal).toBe(10);
    expect(run.summary.shortfallTotal).toBe(0);
    const { lines } = await sessionLines(session.data!.id);
    const closing = lines.find((l) => l.entityType === "daily_closing");
    expect(closing?.status).toBe("overage");
    expect(closing?.variance).toBe(-10);
  });

  it("detects contributions with no closing as missing evidence", async () => {
    await recordContribution(tenantId, admin.id, collector.id, accountId, cycleId, 150);
    const session = await openSession({
      type: "daily_close",
      branchId,
      collectorId: collector.id,
    });
    const run = await runSession(session.data!.id);
    expect(run.summary.missingEvidenceCount).toBe(1);
    expect(run.summary.outstandingTotal).toBe(150);

    const { lines } = await sessionLines(session.data!.id);
    expect(lines).toHaveLength(1);
    expect(lines[0].entityType).toBe("daily_closing");
    expect(lines[0].status).toBe("missing_evidence");
    expect(lines[0].expectedAmount).toBe(150);
  });

  it("flags duplicate contribution business fingerprints", async () => {
    await recordContribution(tenantId, admin.id, collector.id, accountId, cycleId, 150);
    await recordContribution(tenantId, admin.id, collector.id, accountId, cycleId, 150);

    const session = await openSession({
      type: "daily_close",
      branchId,
      collectorId: collector.id,
    });
    const run = await runSession(session.data!.id);
    expect(run.summary.duplicateCount).toBeGreaterThanOrEqual(1);

    const { lines } = await sessionLines(session.data!.id);
    const duplicate = lines.find((l) => l.entityType === "contribution");
    expect(duplicate?.status).toBe("duplicate");
    expect(duplicate?.reason).toMatch(/same account/i);
  });

  it("records pending and failed offline synchronization separately", async () => {
    await prisma.offlineSyncAttempt.create({
      data: {
        tenantId,
        kind: "contribution",
        outcome: "rejected",
        reasonCode: "assignment_not_found",
        reason: "The customer assignment no longer exists",
        retryable: false,
        userId: collector.user.id,
        collectorId: collector.id,
        amount: 75,
        idempotencyKey: `attempt-${randomBytes(4).toString("hex")}`,
        createdAt: new Date(),
      },
    });
    await prisma.offlineTransaction.create({
      data: {
        tenantId,
        branchId,
        deviceId: "device-test-1",
        userId: collector.user.id,
        type: "contribution",
        idempotencyKey: `offline-${randomBytes(4).toString("hex")}`,
        payload: "{}",
        status: "pending_sync",
        localTimestamp: new Date(),
      },
    });

    const session = await openSession({
      type: "daily_close",
      branchId,
      collectorId: collector.id,
    });
    const run = await runSession(session.data!.id);
    expect(run.summary.pendingSyncCount).toBe(1);
    expect(run.summary.syncFailureCount).toBe(1);
    expect(run.summary.pendingSyncAmount).toBe(75);

    const { lines } = await sessionLines(session.data!.id);
    expect(lines.find((l) => l.entityType === "offline_transaction")?.status).toBe("pending_sync");
    expect(lines.find((l) => l.entityType === "offline_sync_attempt")?.status).toBe("sync_failure");
  });

  it("reuses Phase 3 remittance and discrepancy records without duplicating them", async () => {
    await recordContribution(tenantId, admin.id, collector.id, accountId, cycleId, 100);
    const declared = await declareRemittance({ collectorId: collector.id, declaredAmount: 100 });
    expect(declared.success).toBe(true);
    const remittanceId = (declared.data as { id: string }).id;
    const received = await acknowledgeRemittanceReceipt({
      remittanceId,
      receivedAmount: 80,
      evidenceRef: "REM-RCPT-001",
    });
    expect(received.success).toBe(true);

    const session = await openSession({
      type: "remittance",
      branchId,
      collectorId: collector.id,
    });
    const run = await runSession(session.data!.id);
    expect(run.summary.shortfallTotal).toBeGreaterThanOrEqual(20);

    const { lines } = await sessionLines(session.data!.id);
    const remittance = lines.find((l) => l.entityType === "collector_remittance");
    expect(remittance?.status).toBe("shortfall");
    expect(remittance?.expectedAmount).toBe(100);
    expect(remittance?.receivedAmount).toBe(80);
    expect(remittance?.variance).toBe(20);

    const discrepancy = lines.find((l) => l.entityType === "remittance_discrepancy");
    expect(discrepancy?.status).toBe("shortfall");
    expect(discrepancy?.variance).toBe(20);
    expect(await prisma.remittanceDiscrepancy.count({ where: { tenantId } })).toBe(1);
  });

  it("preserves a reviewed observation by appending a revision on the next run", async () => {
    await recordContribution(tenantId, admin.id, collector.id, accountId, cycleId, 150);
    const session = await openSession({
      type: "daily_close",
      branchId,
      collectorId: collector.id,
    });
    await runSession(session.data!.id);
    const { lines } = await sessionLines(session.data!.id);
    const lineId = lines[0].id;

    const reviewed = await reviewReconciliationLine({
      lineId,
      note: "Receipt reviewed by operations",
      evidenceRef: "REVIEW-RCPT-001",
    });
    expect(reviewed.success).toBe(true);

    await runSession(session.data!.id);
    const all = await prisma.reconciliationLine.findMany({
      where: { sessionId: session.data!.id },
      orderBy: { revision: "asc" },
    });
    expect(all).toHaveLength(2);
    expect(all[0].status).toBe("reviewed");
    expect(all[1].revision).toBe(2);
    expect(all[1].status).toBe("missing_evidence");
  });

  it("keeps sessions and cases under branch scope through close and lift", async () => {
    await recordContribution(tenantId, admin.id, collector.id, accountId, cycleId, 150);
    const session = await openSession({
      type: "daily_close",
      branchId,
      collectorId: collector.id,
    });
    await runSession(session.data!.id);
    const reviewed = await reviewReconciliationSession({
      sessionId: session.data!.id,
      note: "Reviewed for close",
    });
    expect(reviewed.success).toBe(true);
    const closed = await closeReconciliationSession({
      sessionId: session.data!.id,
      reason: "Closing the day after review",
    });
    expect(closed.success).toBe(true);
    expect((await getReconciliationSession(session.data!.id))?.data?.status).toBe("closed");
    const late = await reconcileSession(session.data!.id);
    expect(late.success).toBe(false);
    expect(late.error).toMatch(/closed/i);
  });

  it("serialises concurrent session creation and detection", async () => {
    await recordContribution(tenantId, admin.id, collector.id, accountId, cycleId, 150);
    const [a, b] = await Promise.all([
      openSession({ type: "daily_close", branchId, collectorId: collector.id }),
      openSession({ type: "daily_close", branchId, collectorId: collector.id }),
    ]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(a.data!.id).toBe(b.data!.id);

    const results = await Promise.allSettled([
      runSession(a.data!.id),
      runSession(a.data!.id),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const all = await prisma.reconciliationLine.findMany({
      where: { sessionId: a.data!.id },
    });
    expect(all).toHaveLength(1);
    const stored = await prisma.susuReconciliation.findUniqueOrThrow({
      where: { id: a.data!.id },
    });
    expect(stored.runCount).toBeGreaterThanOrEqual(1);
  });

  it("raises one case group and does not duplicate it on retry", async () => {
    await recordContribution(tenantId, admin.id, collector.id, accountId, cycleId, 150);
    const session = await openSession({
      type: "daily_close",
      branchId,
      collectorId: collector.id,
    });
    await runSession(session.data!.id);

    const first = await raiseCasesForSession(session.data!.id);
    expect(first.success).toBe(true);
    expect(first.data?.created).toBe(1);
    const second = await raiseCasesForSession(session.data!.id);
    expect(second.success).toBe(true);
    expect(second.data?.created).toBe(0);
    expect(await prisma.reconciliationExceptionCase.count({ where: { tenantId } })).toBe(1);

    const linked = await prisma.reconciliationLine.findFirstOrThrow({
      where: { sessionId: session.data!.id },
    });
    expect(linked.exceptionCaseId).toBe(first.data!.cases[0].id);
  });

  it("serialises concurrent case raising for one session", async () => {
    await recordContribution(tenantId, admin.id, collector.id, accountId, cycleId, 150);
    const session = await openSession({
      type: "daily_close",
      branchId,
      collectorId: collector.id,
    });
    await runSession(session.data!.id);
    const [a, b] = await Promise.all([
      raiseCasesForSession(session.data!.id),
      raiseCasesForSession(session.data!.id),
    ]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect((a.data?.created ?? 0) + (b.data?.created ?? 0)).toBe(1);
    expect(await prisma.reconciliationExceptionCase.count({ where: { tenantId } })).toBe(1);
  });

  it("lists daily closings and builds an owner overview from stored records", async () => {
    await recordContribution(tenantId, admin.id, collector.id, accountId, cycleId, 150);
    const opened = await openDailyCollectorClosing({ collectorId: collector.id });
    await setSession(collector.user, "collector");
    await declareDailyClosing({ closingId: opened.data!.id, declaredCash: 150 });
    await setSession(admin);
    await recordDailyClosingHandover({ closingId: opened.data!.id, handoverAmount: 150 });
    await setSession(admin2);
    await receiveDailyClosing({ closingId: opened.data!.id, receivedAmount: 150 });
    await setSession(admin);
    await closeDailyClosing({ closingId: opened.data!.id });

    const closings = await listDailyClosings({ collectorId: collector.id });
    expect(closings.success).toBe(true);
    expect(closings.data?.total).toBe(1);
    expect(closings.data?.closings[0].status).toBe("balanced");

    const overview = await getReconciliationOverview({ collectorId: collector.id });
    expect(overview.success).toBe(true);
    expect(overview.data?.cash.expected).toBe(150);
    expect(overview.data?.cash.received).toBe(150);
    expect(overview.data?.cash.outstanding).toBe(0);
    expect(overview.data?.collectors[0].collectorId).toBe(collector.id);
    expect(overview.data?.collectors[0].lastClosingDay).toBeTruthy();
  });
});
