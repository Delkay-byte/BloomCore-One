/**
 * Phase 5 — exception case lifecycle, authorization and owner visibility.
 *
 * Every test calls the exported server actions under a signed session. No
 * client-supplied tenant, branch, collector or owner identity is trusted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";
import {
  createTenantWithBranch,
  createBranch,
  createAdminInTenant,
  createCollector,
  createAccount,
  recordContribution,
  openCase,
  caseView,
  sessionSetter,
} from "./phase5-helpers";
import {
  openExceptionCase,
  updateExceptionCase,
  assignExceptionCase,
  reassignExceptionCase,
  addExceptionCaseNote,
  extendExceptionCaseDueDate,
  escalateExceptionCase,
  escalateOverdueCases,
  proposeCaseResolution,
  approveCaseResolution,
  rejectResolutionProposal,
  resolveExceptionCase,
  rejectExceptionCase,
  reopenExceptionCase,
  linkCaseRecord,
  listExceptionCases,
  getExceptionCase,
  respondToExceptionCase,
} from "@/lib/actions/susu-exception-cases.actions";
import { getReconciliationOverview } from "@/lib/actions/susu-reconciliation.actions";

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

// These are database-heavy lifecycle tests; the default 5s budget is too tight
// when the full suite is running on the same SQLite file.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe("Phase 5 exception cases", () => {
  let tenantId: string;
  let branchId: string;
  let branchB: string;
  let admin: { id: string; tenantId: string | null; email: string };
  let admin2: { id: string; tenantId: string | null; email: string };
  let managerB: { id: string; tenantId: string | null; email: string };
  let finance: { id: string; tenantId: string | null; email: string };
  let collector: Awaited<ReturnType<typeof createCollector>>;
  let otherCollector: Awaited<ReturnType<typeof createCollector>>;
  let accountId: string;
  let cycleId: string;
  let contributionId: string;

  beforeEach(async () => {
    await cleanDatabase();
    const seeded = await createTenantWithBranch();
    tenantId = seeded.tenant.id;
    branchId = seeded.branch.id;
    admin = seeded.admin;
    branchB = (await createBranch(tenantId, "Second Branch")).id;
    admin2 = await createAdminInTenant(tenantId, { fullName: "Case Owner" });
    managerB = await createAdminInTenant(tenantId, {
      branchId: branchB,
      role: "branch_manager",
      fullName: "Branch B Manager",
    });
    finance = await createAdminInTenant(tenantId, {
      branchId,
      role: "finance",
      fullName: "Branch Finance",
    });
    collector = await createCollector(tenantId, branchId);
    otherCollector = await createCollector(tenantId, branchId, "Other Collector");
    const account = await createAccount(tenantId, admin.id, collector.id);
    accountId = account.account.id;
    cycleId = account.cycle.id;
    contributionId = (
      await recordContribution(tenantId, admin.id, collector.id, accountId, cycleId, 50)
    ).id;
    await setSession(admin);
  });

  it("validates case creation and records the opening event and audit", async () => {
    const shortTitle = await openExceptionCase({
      category: "other",
      title: "x",
    });
    expect(shortTitle.success).toBe(false);

    const badCategory = await openExceptionCase({
      category: "not_a_category",
      title: "A real difference",
    });
    expect(badCategory.success).toBe(false);

    const pastDue = await openExceptionCase({
      category: "other",
      title: "A real difference",
      dueAt: new Date(Date.now() - 86_400_000),
    });
    expect(pastDue.success).toBe(false);

    const created = await openCase({
      category: "contribution",
      severity: "high",
      title: "Contribution receipt needs review",
      description: "The allocation does not agree with the receipt.",
      amountAtStake: 600,
      branchId,
      collectorId: collector.id,
      links: [{ entityType: "contribution", entityId: contributionId }],
    });
    expect(created.caseNumber).toMatch(/^REC-\d{4}-\d{4}$/);

    const view = await caseView(created.id);
    expect(view.status).toBe("open");
    expect(view.branchId).toBe(branchId);
    expect(view.collectorId).toBe(collector.id);
    expect(view.amountAtStake).toBe(600);
    expect(view.requiresIndependentApproval).toBe(true);
    expect(view.requiresEvidence).toBe(true);
    expect(view.links).toHaveLength(1);
    expect(view.events[0].type).toBe("opened");

    const audit = await prisma.auditLog.findFirst({
      where: {
        tenantId,
        entityId: created.id,
        action: "susu.exception_case_opened",
      },
    });
    expect(audit).not.toBeNull();
    expect(audit?.branchId).toBe(branchId);
  });

  it("assigns and reassigns with a mandatory reason and full timeline", async () => {
    const created = await openCase({
      category: "other",
      severity: "low",
      title: "Unassigned operational difference",
      branchId,
    });

    const assigned = await assignExceptionCase({
      caseId: created.id,
      ownerId: admin2.id,
      dueAt: new Date(Date.now() + 3 * 86_400_000),
      note: "Assign to the branch owner",
    });
    expect(assigned.success).toBe(true);
    let view = await caseView(created.id);
    expect(view.status).toBe("assigned");
    expect(view.ownerId).toBe(admin2.id);
    expect(view.events.some((e) => e.type === "assigned")).toBe(true);

    const noReason = await reassignExceptionCase({
      caseId: created.id,
      ownerId: finance.id,
      reason: "",
    });
    expect(noReason.success).toBe(false);

    const sameOwner = await reassignExceptionCase({
      caseId: created.id,
      ownerId: admin2.id,
      reason: "Same owner should be rejected",
    });
    expect(sameOwner.success).toBe(false);

    const wrongBranchOwner = await reassignExceptionCase({
      caseId: created.id,
      ownerId: managerB.id,
      reason: "Manager B is outside this case branch",
    });
    expect(wrongBranchOwner.success).toBe(false);

    const reassigned = await reassignExceptionCase({
      caseId: created.id,
      ownerId: finance.id,
      reason: "Finance will complete the cash review",
    });
    expect(reassigned.success).toBe(true);
    view = await caseView(created.id);
    expect(view.ownerId).toBe(finance.id);
    const event = view.events.find((e) => e.type === "reassigned");
    expect(event?.reason).toBe("Finance will complete the cash review");

    const audit = await prisma.auditLog.findFirst({
      where: { tenantId, entityId: created.id, action: "susu.exception_case_reassigned" },
    });
    expect(audit).not.toBeNull();
  });

  it("enforces tenant, branch, collector and role boundaries", async () => {
    const created = await openCase({
      category: "other",
      severity: "low",
      title: "Collector cash difference",
      branchId,
      collectorId: collector.id,
    });

    await setSession(finance);
    expect((await getExceptionCase(created.id))?.success).toBe(true);

    await setSession(managerB);
    expect(await getExceptionCase(created.id)).toBeNull();
    const managerList = await listExceptionCases({});
    expect(managerList.success).toBe(true);
    expect(managerList.data?.total).toBe(0);
    const forbiddenFilter = await listExceptionCases({ branchId });
    expect(forbiddenFilter.success).toBe(false);

    const foreign = await createTenantWithBranch("Foreign Tenant");
    await setSession(foreign.admin);
    expect(await getExceptionCase(created.id)).toBeNull();
    expect((await listExceptionCases({})).data?.total).toBe(0);

    await setSession(collector.user, "collector");
    const own = await getExceptionCase(created.id);
    expect(own?.success).toBe(true);
    expect(own?.data?.collectorId).toBe(collector.id);
    const spoofed = await listExceptionCases({ collectorId: otherCollector.id });
    expect(spoofed.success).toBe(false);
    await expect(
      assignExceptionCase({
        caseId: created.id,
        ownerId: admin2.id,
      })
    ).rejects.toThrow(/administrator/i);

    await setSession(otherCollector.user, "collector");
    expect(await getExceptionCase(created.id)).toBeNull();
    expect((await listExceptionCases({})).data?.total).toBe(0);
  });

  it("lets a collector respond only on their own case and moves it to review", async () => {
    const created = await openCase({
      category: "contribution",
      severity: "low",
      title: "Collector receipt difference",
      branchId,
      collectorId: collector.id,
      amountAtStake: 25,
    });

    await setSession(collector.user, "collector");
    const response = await respondToExceptionCase({
      caseId: created.id,
      note: "Receipt is attached from the customer",
      evidenceRef: "COLLECTOR-RCPT-001",
    });
    expect(response.success).toBe(true);
    const view = await caseView(created.id);
    expect(view.status).toBe("under_review");
    expect(view.evidence).toBe("COLLECTOR-RCPT-001");
    expect(view.events.some((e) => e.actorId === collector.user.id)).toBe(true);

    await setSession(otherCollector.user, "collector");
    const otherResponse = await respondToExceptionCase({
      caseId: created.id,
      note: "This is not my case",
      evidenceRef: "OTHER-001",
    });
    expect(otherResponse.success).toBe(false);
  });

  it("requires evidence before a financial case can be resolved", async () => {
    const created = await openCase({
      category: "contribution",
      severity: "low",
      title: "Contribution evidence missing",
      branchId,
      collectorId: collector.id,
      amountAtStake: 25,
    });
    await assignExceptionCase({ caseId: created.id, ownerId: admin2.id });

    const noEvidence = await resolveExceptionCase({
      caseId: created.id,
      resolutionType: "correction_posted",
      resolutionNote: "Corrected in the contribution ledger",
    });
    expect(noEvidence.success).toBe(false);
    expect(noEvidence.error).toMatch(/evidence/i);

    const note = await addExceptionCaseNote({
      caseId: created.id,
      note: "Bank slip supplied by the branch",
      evidenceRef: "BANK-SLIP-001",
    });
    expect(note.success).toBe(true);
    expect((await caseView(created.id)).evidence).toBe("BANK-SLIP-001");

    const resolved = await resolveExceptionCase({
      caseId: created.id,
      resolutionType: "correction_posted",
      resolutionNote: "Contribution allocation corrected after review",
    });
    expect(resolved.success).toBe(true);
    const view = await caseView(created.id);
    expect(view.status).toBe("resolved");
    expect(view.resolutionType).toBe("correction_posted");
    expect(view.resolvedById).toBe(admin.id);

    const terminalNote = await addExceptionCaseNote({
      caseId: created.id,
      note: "Cannot add after closure",
    });
    expect(terminalNote.success).toBe(false);
  });

  it("requires independent finance approval for a high-value resolution", async () => {
    const created = await openCase({
      category: "remittance",
      severity: "high",
      title: "High-value remittance difference",
      branchId,
      collectorId: collector.id,
      amountAtStake: 600,
      ownerId: admin2.id,
    });

    const direct = await resolveExceptionCase({
      caseId: created.id,
      resolutionType: "cash_recovered",
      resolutionNote: "Cash recovered and banked at the branch",
      evidenceRef: "BANK-001",
    });
    expect(direct.success).toBe(false);
    expect(direct.error).toMatch(/independent approval/i);

    const noEvidenceProposal = await proposeCaseResolution({
      caseId: created.id,
      resolutionType: "cash_recovered",
      resolutionNote: "Cash recovered and banked at the branch",
    });
    expect(noEvidenceProposal.success).toBe(false);

    const proposed = await proposeCaseResolution({
      caseId: created.id,
      resolutionType: "cash_recovered",
      resolutionNote: "Cash recovered and banked at the branch",
      evidenceRef: "BANK-001",
    });
    expect(proposed.success).toBe(true);
    expect((await caseView(created.id)).status).toBe("resolution_proposed");

    const selfApprove = await approveCaseResolution({ caseId: created.id });
    expect(selfApprove.success).toBe(false);
    expect(selfApprove.error).toMatch(/cannot approve/i);

    await setSession(managerB);
    const wrongBranch = await approveCaseResolution({ caseId: created.id });
    expect(wrongBranch.success).toBe(false);

    await setSession(finance);
    const approved = await approveCaseResolution({
      caseId: created.id,
      note: "Finance verified the bank slip",
    });
    expect(approved.success).toBe(true);
    const view = await caseView(created.id);
    expect(view.status).toBe("resolved");
    expect(view.resolutionApprovedById).toBe(finance.id);
    expect(view.resolutionProposedById).toBe(admin.id);
    expect(view.events.some((e) => e.type === "resolution_approved")).toBe(true);
  });

  it("sends a rejected proposal back to review without closing the case", async () => {
    const created = await openCase({
      category: "other",
      severity: "medium",
      title: "Medium value operational difference",
      branchId,
      amountAtStake: 50,
    });
    const proposed = await proposeCaseResolution({
      caseId: created.id,
      resolutionType: "no_action",
      resolutionNote: "No financial adjustment is required here",
      evidenceRef: "REVIEW-001",
    });
    expect(proposed.success).toBe(true);

    const rejected = await rejectResolutionProposal({
      caseId: created.id,
      reason: "The evidence does not support no action",
    });
    expect(rejected.success).toBe(true);
    const view = await caseView(created.id);
    expect(view.status).toBe("under_review");
    expect(view.proposedResolutionType).toBeNull();
    expect(view.events.some((e) => e.type === "resolution_rejected")).toBe(true);
  });

  it("extends due dates, escalates manually and sweeps overdue cases once", async () => {
    const dueSoon = new Date(Date.now() + 2 * 86_400_000);
    const created = await openCase({
      category: "other",
      severity: "medium",
      title: "Due date and escalation case",
      branchId,
      dueAt: dueSoon,
    });
    await assignExceptionCase({ caseId: created.id, ownerId: admin2.id });

    const shortReason = await extendExceptionCaseDueDate({
      caseId: created.id,
      dueAt: new Date(dueSoon.getTime() + 86_400_000),
      reason: "x",
    });
    expect(shortReason.success).toBe(false);

    const earlier = await extendExceptionCaseDueDate({
      caseId: created.id,
      dueAt: new Date(dueSoon.getTime() - 86_400_000),
      reason: "Earlier is invalid",
    });
    expect(earlier.success).toBe(false);

    const extended = await extendExceptionCaseDueDate({
      caseId: created.id,
      dueAt: new Date(dueSoon.getTime() + 86_400_000),
      reason: "The branch needs one more day",
    });
    expect(extended.success).toBe(true);
    const view = await caseView(created.id);
    expect(view.dueDateExtensionCount).toBe(1);
    expect(view.events.some((e) => e.type === "due_date_extended")).toBe(true);

    await prisma.reconciliationExceptionCase.update({
      where: { id: created.id },
      data: { dueAt: new Date(Date.now() - 60_000) },
    });

    const sweep = await escalateOverdueCases({ branchId });
    expect(sweep.success).toBe(true);
    expect(sweep.data?.escalated).toBe(1);
    const escalated = await caseView(created.id);
    expect(escalated.status).toBe("escalated");
    expect(escalated.escalationLevel).toBe(1);
    expect(escalated.overdue).toBe(true);

    const secondSweep = await escalateOverdueCases({ branchId });
    expect(secondSweep.data?.escalated).toBe(0);

    const manual = await openCase({
      category: "other",
      severity: "low",
      title: "Manual escalation case",
      branchId,
    });
    expect(
      (
        await escalateExceptionCase({
          caseId: manual.id,
          reason: "x",
        })
      ).success
    ).toBe(false);
    const manualEscalated = await escalateExceptionCase({
      caseId: manual.id,
      reason: "Operations requested a management review",
    });
    expect(manualEscalated.success).toBe(true);
    expect((await caseView(manual.id)).status).toBe("escalated");
  });

  it("rejects, reopens only with new evidence, and resolves again", async () => {
    const created = await openCase({
      category: "other",
      severity: "low",
      title: "Rejected then reopened case",
      branchId,
    });
    const rejected = await rejectExceptionCase({
      caseId: created.id,
      reason: "The difference was a timing effect",
    });
    expect(rejected.success).toBe(true);
    expect((await caseView(created.id)).status).toBe("rejected");

    const noEvidence = await reopenExceptionCase({
      caseId: created.id,
      reason: "New bank statement received",
      evidenceRef: "",
    });
    expect(noEvidence.success).toBe(false);

    const reopened = await reopenExceptionCase({
      caseId: created.id,
      reason: "New bank statement received",
      evidenceRef: "BANK-REOPEN-001",
    });
    expect(reopened.success).toBe(true);
    let view = await caseView(created.id);
    expect(view.status).toBe("reopened");
    expect(view.reopenCount).toBe(1);
    expect(view.events.some((e) => e.type === "reopened")).toBe(true);

    const resolved = await resolveExceptionCase({
      caseId: created.id,
      resolutionType: "no_action",
      resolutionNote: "New evidence shows the difference cleared",
    });
    expect(resolved.success).toBe(true);
    view = await caseView(created.id);
    expect(view.status).toBe("resolved");
  });

  it("validates linked records against the tenant and branch", async () => {
    const valid = await openCase({
      category: "contribution",
      severity: "low",
      title: "Linked contribution case",
      branchId,
      links: [{ entityType: "contribution", entityId: contributionId }],
    });
    expect((await caseView(valid.id)).links).toHaveLength(1);

    const random = await openExceptionCase({
      category: "other",
      title: "Invalid link target",
      branchId,
      links: [{ entityType: "contribution", entityId: "does-not-exist" }],
    });
    expect(random.success).toBe(false);

    const foreign = await createTenantWithBranch("Link Foreign Tenant");
    const foreignCollector = await createCollector(foreign.tenant.id, foreign.branch.id);
    const foreignAccount = await createAccount(
      foreign.tenant.id,
      foreign.admin.id,
      foreignCollector.id
    );
    const foreignContribution = await recordContribution(
      foreign.tenant.id,
      foreign.admin.id,
      foreignCollector.id,
      foreignAccount.account.id,
      foreignAccount.cycle.id,
      10
    );
    const crossTenant = await openExceptionCase({
      category: "contribution",
      title: "Cross tenant link must fail",
      branchId,
      links: [{ entityType: "contribution", entityId: foreignContribution.id }],
    });
    expect(crossTenant.success).toBe(false);

    const secondContribution = await recordContribution(
      tenantId,
      admin.id,
      collector.id,
      accountId,
      cycleId,
      25
    );
    const linked = await linkCaseRecord({
      caseId: valid.id,
      entityType: "contribution",
      entityId: secondContribution.id,
      note: "Additional receipt",
    });
    expect(linked.success).toBe(true);
    expect((await caseView(valid.id)).links).toHaveLength(2);

    const badType = await linkCaseRecord({
      caseId: valid.id,
      entityType: "not_a_record",
      entityId: secondContribution.id,
    });
    expect(badType.success).toBe(false);
  });

  it("keeps an append-only audit trail for every case action", async () => {
    const created = await openCase({
      category: "other",
      severity: "low",
      title: "Audit completeness case",
      branchId,
    });
    await assignExceptionCase({ caseId: created.id, ownerId: admin2.id });
    await addExceptionCaseNote({ caseId: created.id, note: "Called the branch for context" });
    await escalateExceptionCase({
      caseId: created.id,
      reason: "No response within the service window",
    });
    await resolveExceptionCase({
      caseId: created.id,
      resolutionType: "no_action",
      resolutionNote: "Management reviewed and closed the difference",
    });

    const view = await caseView(created.id);
    expect(view.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["opened", "assigned", "note", "escalated", "resolved"])
    );

    const audits = await prisma.auditLog.findMany({
      where: { tenantId, entityId: created.id, action: { startsWith: "susu.exception_case_" } },
      orderBy: { createdAt: "asc" },
    });
    const actions = audits.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "susu.exception_case_opened",
        "susu.exception_case_assigned",
        "susu.exception_case_note_added",
        "susu.exception_case_escalated",
        "susu.exception_case_resolved",
      ])
    );
    for (const audit of audits) {
      expect(audit.userId).toBeTruthy();
      expect(audit.tenantId).toBe(tenantId);
    }
  });

  it("shows owners open, overdue, unassigned, escalated and resolved work", async () => {
    const unassigned = await openCase({
      category: "other",
      severity: "low",
      title: "Unassigned owner visibility case",
      branchId,
    });
    const overdue = await openCase({
      category: "other",
      severity: "medium",
      title: "Overdue owner visibility case",
      branchId,
    });
    await prisma.reconciliationExceptionCase.update({
      where: { id: overdue.id },
      data: { dueAt: new Date(Date.now() - 60_000) },
    });
    const escalated = await openCase({
      category: "remittance",
      severity: "high",
      title: "Escalated owner visibility case",
      branchId,
      collectorId: collector.id,
      amountAtStake: 700,
    });
    await escalateExceptionCase({
      caseId: escalated.id,
      reason: "High-value remittance needs owner attention",
    });
    const resolved = await openCase({
      category: "other",
      severity: "low",
      title: "Resolved owner visibility case",
      branchId,
    });
    await resolveExceptionCase({
      caseId: resolved.id,
      resolutionType: "no_action",
      resolutionNote: "No further action is required for this case",
    });

    const overview = await getReconciliationOverview({ branchId });
    expect(overview.success).toBe(true);
    expect(overview.data?.cases.unassigned).toBeGreaterThanOrEqual(1);
    expect(overview.data?.cases.overdue).toBeGreaterThanOrEqual(1);
    expect(overview.data?.cases.escalated).toBeGreaterThanOrEqual(1);
    expect(overview.data?.cases.resolved).toBeGreaterThanOrEqual(1);
    expect(overview.data?.branches[0].branchId).toBe(branchId);
    expect(overview.data?.collectors.find((c) => c.collectorId === collector.id)).toBeTruthy();

    const queue = await listExceptionCases({ branchId, unassigned: true });
    expect(queue.success).toBe(true);
    expect(queue.data?.cases.map((c) => c.id)).toContain(unassigned.id);

    const overdueQueue = await listExceptionCases({ branchId, overdue: true });
    expect(overdueQueue.data?.cases.map((c) => c.id)).toContain(overdue.id);

    const escalatedQueue = await listExceptionCases({ branchId, escalated: true });
    expect(escalatedQueue.data?.cases.map((c) => c.id)).toContain(escalated.id);
  });

  it("allocates unique case numbers under concurrent creation", async () => {
    const results = await Promise.allSettled([
      openExceptionCase({ category: "other", title: "Concurrent case one", branchId }),
      openExceptionCase({ category: "other", title: "Concurrent case two", branchId }),
      openExceptionCase({ category: "other", title: "Concurrent case three", branchId }),
    ]);
    const successful = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof openExceptionCase>>> =>
        r.status === "fulfilled" && r.value.success && Boolean(r.value.data)
      )
      .map((r) => r.value.data!.caseNumber);
    expect(successful.length).toBeGreaterThanOrEqual(2);
    expect(new Set(successful).size).toBe(successful.length);
    const stored = await prisma.reconciliationExceptionCase.findMany({
      where: { tenantId },
      select: { caseNumber: true },
    });
    expect(new Set(stored.map((s) => s.caseNumber)).size).toBe(stored.length);
  });

  it("does not let a branch manager update a case outside their membership", async () => {
    const created = await openCase({
      category: "other",
      severity: "low",
      title: "Branch scoped update case",
      branchId,
    });
    await setSession(managerB);
    const update = await updateExceptionCase({
      id: created.id,
      status: "under_review",
      note: "Trying to update another branch",
    });
    expect(update.success).toBe(false);
    expect(await getExceptionCase(created.id)).toBeNull();
  });
});
