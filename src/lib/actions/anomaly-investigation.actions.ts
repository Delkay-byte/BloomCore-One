"use server";

import { db } from "@/lib/db";
import { requireTenantAdminMomo } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import { ANOMALY_RULE_CATALOG } from "@/lib/anomaly-rules";
import {
  ALERT_BUDGET_PER_RUN,
  DEFAULT_CHECKLIST,
  INVESTIGATION_STATUS_LABELS,
  MAX_SUPPRESSION_DAYS,
  NOTIFY_QUIET_HOURS,
  assignAnomalySchema,
  closeInvestigationSchema,
  investigationCommentSchema,
  investigationDueAt,
  investigationStatusSchema,
  suppressionExpiry,
  suppressionSchema,
  type Disposition,
} from "@/lib/anomaly-investigation";

/**
 * The investigation side of anomaly monitoring.
 *
 * Separation matters: `anomaly.actions.ts` raises and acknowledges findings, this
 * module records who owns one, what was checked, why it was closed and which rule
 * is deliberately quiet. Closing a finding never touches a transaction, a count or
 * a balance.
 */

export interface AnomalyActionResponse {
  success: boolean;
  error?: string;
}

export interface InvestigationEventView {
  id: string;
  kind: string;
  severity: string | null;
  summary: string | null;
  snapshotHash: string | null;
  note: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface InvestigationTaskView {
  id: string;
  label: string;
  done: boolean;
  doneByName: string | null;
  doneAt: string | null;
}

export interface InvestigationCommentView {
  id: string;
  body: string;
  authorName: string;
  createdAt: string;
}

export interface InvestigationView {
  id: string;
  anomalyId: string;
  status: string;
  statusLabel: string;
  assigneeId: string | null;
  assigneeName: string | null;
  dueAt: string | null;
  overdue: boolean;
  disposition: Disposition | null;
  dispositionNote: string | null;
  linkedCorrectionType: string | null;
  linkedCorrectionId: string | null;
  closedAt: string | null;
  reopenCount: number;
  suppressedUntil: string | null;
  tasks: InvestigationTaskView[];
  comments: InvestigationCommentView[];
  events: InvestigationEventView[];
}

export interface InvestigationResponse {
  success: boolean;
  error?: string;
  data?: InvestigationView;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

async function staffNames(
  tenantId: string,
  ids: Array<string | null>
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
  if (unique.length === 0) return new Map();
  const rows = await db.user.findMany({
    where: { tenantId, id: { in: unique } },
    select: { id: true, fullName: true },
  });
  return new Map(rows.map((row) => [row.id, row.fullName]));
}

/**
 * Open (or return) the investigation for one finding, with the default checklist.
 *
 * The checklist exists from the first visit so "checked" is a recorded fact rather
 * than a claim in a note.
 */
async function ensureInvestigation(tenantId: string, userId: string, anomalyId: string) {
  const existing = await db.anomalyInvestigation.findFirst({
    where: { anomalyId, tenantId },
  });
  if (existing) return existing;
  return db.anomalyInvestigation.create({
    data: {
      tenantId,
      anomalyId,
      openedById: userId,
      tasks: {
        create: DEFAULT_CHECKLIST.map((label, index) => ({ tenantId, label, sequence: index })),
      },
    },
  });
}

export async function getAnomalyInvestigation(
  anomalyId: string
): Promise<InvestigationResponse> {
  const ctx = await requireTenantAdminMomo();
  const anomaly = await db.operationalAnomaly.findFirst({
    where: { id: anomalyId, tenantId: ctx.tenantId },
    select: {
      id: true,
      ruleKey: true,
      entityType: true,
      entityId: true,
      reopenCount: true,
    },
  });
  if (!anomaly) return { success: false, error: "Finding not found." };

  const investigation = await ensureInvestigation(ctx.tenantId, ctx.userId, anomalyId);
  const [tasks, comments, events, suppression] = await Promise.all([
    db.anomalyInvestigationTask.findMany({
      where: { investigationId: investigation.id },
      orderBy: { sequence: "asc" },
    }),
    db.anomalyInvestigationComment.findMany({
      where: { investigationId: investigation.id },
      orderBy: { createdAt: "asc" },
    }),
    db.anomalyFindingEvent.findMany({
      where: { anomalyId, tenantId: ctx.tenantId },
      orderBy: { createdAt: "asc" },
      take: 200,
    }),
    db.anomalySuppression.findFirst({
      where: {
        tenantId: ctx.tenantId,
        ruleKey: anomaly.ruleKey,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        OR: [
          { entityType: null },
          { entityType: anomaly.entityType, entityId: anomaly.entityId },
        ],
      },
      orderBy: { expiresAt: "desc" },
    }),
  ]);

  const names = await staffNames(ctx.tenantId, [
    investigation.assigneeId,
    ...tasks.map((row) => row.doneById),
    ...comments.map((row) => row.authorId),
    ...events.map((row) => row.actorId),
  ]);

  return {
    success: true,
    data: {
      id: investigation.id,
      anomalyId,
      status: investigation.status,
      statusLabel:
        INVESTIGATION_STATUS_LABELS[
          investigation.status as keyof typeof INVESTIGATION_STATUS_LABELS
        ] ?? investigation.status,
      assigneeId: investigation.assigneeId,
      assigneeName: investigation.assigneeId
        ? names.get(investigation.assigneeId) ?? null
        : null,
      dueAt: iso(investigation.dueAt),
      overdue: Boolean(
        investigation.dueAt &&
          investigation.status !== "closed" &&
          investigation.dueAt.getTime() < Date.now()
      ),
      disposition: (investigation.disposition as Disposition | null) ?? null,
      dispositionNote: investigation.dispositionNote,
      linkedCorrectionType: investigation.linkedCorrectionType,
      linkedCorrectionId: investigation.linkedCorrectionId,
      closedAt: iso(investigation.closedAt),
      reopenCount: anomaly.reopenCount,
      suppressedUntil: suppression ? suppression.expiresAt.toISOString() : null,
      tasks: tasks.map((row) => ({
        id: row.id,
        label: row.label,
        done: Boolean(row.doneAt),
        doneByName: row.doneById ? names.get(row.doneById) ?? null : null,
        doneAt: iso(row.doneAt),
      })),
      comments: comments.map((row) => ({
        id: row.id,
        body: row.body,
        authorName: names.get(row.authorId) ?? "Staff",
        createdAt: row.createdAt.toISOString(),
      })),
      events: events.map((row) => ({
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        summary: row.summary,
        snapshotHash: row.snapshotHash,
        note: row.note,
        actorName: row.actorId ? names.get(row.actorId) ?? null : null,
        createdAt: row.createdAt.toISOString(),
      })),
    },
  };
}

/** Hand a finding to a named person and start the SLA clock. */
export async function assignAnomaly(input: {
  anomalyId: string;
  assigneeId: string;
  note?: string;
}): Promise<AnomalyActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const parsed = assignAnomalySchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const anomaly = await db.operationalAnomaly.findFirst({
    where: { id: input.anomalyId, tenantId: ctx.tenantId },
    select: { id: true, severity: true, ruleKey: true, status: true },
  });
  if (!anomaly) return { success: false, error: "Finding not found." };
  if (anomaly.status === "resolved") {
    return { success: false, error: "Reopen the finding before investigating it again." };
  }
  const assignee = await db.user.findFirst({
    where: { id: input.assigneeId, tenantId: ctx.tenantId, status: "active" },
    select: { id: true, fullName: true },
  });
  if (!assignee) return { success: false, error: "That staff member was not found." };

  const investigation = await ensureInvestigation(ctx.tenantId, ctx.userId, anomaly.id);
  await db.$transaction(async (tx) => {
    await tx.anomalyInvestigation.update({
      where: { id: investigation.id },
      data: {
        assigneeId: assignee.id,
        status: investigation.status === "open" ? "investigating" : investigation.status,
        dueAt: investigation.dueAt ?? investigationDueAt(anomaly.severity),
      },
    });
    await tx.anomalyFindingEvent.create({
      data: {
        tenantId: ctx.tenantId,
        anomalyId: anomaly.id,
        kind: "assigned",
        note: input.note?.trim() || `Assigned to ${assignee.fullName}.`,
        actorId: ctx.userId,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "anomaly.assigned",
      entityType: "operationalAnomaly",
      entityId: anomaly.id,
      details: { assigneeId: assignee.id, ruleKey: anomaly.ruleKey },
    });
  });
  return { success: true };
}

export async function setAnomalyInvestigationStatus(input: {
  anomalyId: string;
  status: "open" | "investigating" | "awaiting_evidence";
  note?: string;
}): Promise<AnomalyActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const parsed = investigationStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const investigation = await db.anomalyInvestigation.findFirst({
    where: { anomalyId: input.anomalyId, tenantId: ctx.tenantId },
  });
  if (!investigation) return { success: false, error: "Start the investigation first." };
  if (investigation.status === "closed") {
    return {
      success: false,
      error: "A closed investigation is reopened from the finding, not by a status change.",
    };
  }
  await db.$transaction(async (tx) => {
    await tx.anomalyInvestigation.update({
      where: { id: investigation.id },
      data: { status: parsed.data.status },
    });
    await tx.anomalyFindingEvent.create({
      data: {
        tenantId: ctx.tenantId,
        anomalyId: input.anomalyId,
        kind: "commented",
        note:
          input.note?.trim() ||
          `Investigation moved to ${INVESTIGATION_STATUS_LABELS[parsed.data.status]}.`,
        actorId: ctx.userId,
      },
    });
  });
  return { success: true };
}

export async function addAnomalyInvestigationComment(input: {
  anomalyId: string;
  body: string;
}): Promise<AnomalyActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const parsed = investigationCommentSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Write what you found." };
  }
  const anomaly = await db.operationalAnomaly.findFirst({
    where: { id: input.anomalyId, tenantId: ctx.tenantId },
    select: { id: true },
  });
  if (!anomaly) return { success: false, error: "Finding not found." };
  const investigation = await ensureInvestigation(ctx.tenantId, ctx.userId, anomaly.id);
  await db.$transaction(async (tx) => {
    await tx.anomalyInvestigationComment.create({
      data: {
        tenantId: ctx.tenantId,
        investigationId: investigation.id,
        authorId: ctx.userId,
        body: parsed.data.body,
      },
    });
    await tx.anomalyFindingEvent.create({
      data: {
        tenantId: ctx.tenantId,
        anomalyId: anomaly.id,
        kind: "commented",
        note: parsed.data.body.slice(0, 400),
        actorId: ctx.userId,
      },
    });
  });
  return { success: true };
}

export async function completeAnomalyInvestigationTask(input: {
  anomalyId: string;
  taskId: string;
  done: boolean;
}): Promise<AnomalyActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const investigation = await db.anomalyInvestigation.findFirst({
    where: { anomalyId: input.anomalyId, tenantId: ctx.tenantId },
    select: { id: true },
  });
  if (!investigation) return { success: false, error: "Start the investigation first." };
  const task = await db.anomalyInvestigationTask.findFirst({
    where: { id: input.taskId, investigationId: investigation.id, tenantId: ctx.tenantId },
    select: { id: true, label: true },
  });
  if (!task) return { success: false, error: "That checklist step was not found." };

  await db.$transaction(async (tx) => {
    await tx.anomalyInvestigationTask.update({
      where: { id: task.id },
      data: {
        doneAt: input.done ? new Date() : null,
        doneById: input.done ? ctx.userId : null,
      },
    });
    await tx.anomalyFindingEvent.create({
      data: {
        tenantId: ctx.tenantId,
        anomalyId: input.anomalyId,
        kind: "task_completed",
        note: `${input.done ? "Done" : "Reopened"}: ${task.label}`,
        actorId: ctx.userId,
      },
    });
  });
  return { success: true };
}

const CORRECTION_MODELS = ["momoTransaction", "branchTransfer", "dailyAccount"] as const;
type CorrectionType = (typeof CORRECTION_MODELS)[number];

async function correctionExists(
  tenantId: string,
  type: string,
  id: string
): Promise<boolean> {
  if (!CORRECTION_MODELS.includes(type as CorrectionType)) return false;
  if (type === "momoTransaction") {
    return Boolean(
      await db.momoTransaction.findFirst({ where: { id, tenantId }, select: { id: true } })
    );
  }
  if (type === "branchTransfer") {
    return Boolean(
      await db.branchTransfer.findFirst({ where: { id, tenantId }, select: { id: true } })
    );
  }
  return Boolean(
    await db.dailyAccount.findFirst({ where: { id, tenantId }, select: { id: true } })
  );
}

/**
 * Close an investigation with a disposition.
 *
 * A "genuine" disposition must name the correction that fixed the underlying
 * record, because otherwise the finding is closed with nothing changed. A false
 * positive may be suppressed for a bounded period, recorded with its reason and
 * expiry rather than quietly hiding the rule.
 */
export async function closeAnomalyInvestigation(input: {
  anomalyId: string;
  disposition: Disposition;
  note: string;
  linkedCorrectionType?: string;
  linkedCorrectionId?: string;
  suppressDays?: number;
}): Promise<AnomalyActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const parsed = closeInvestigationSchema.safeParse({
    anomalyId: input.anomalyId,
    disposition: input.disposition,
    note: input.note,
    suppressDays: input.suppressDays,
  });
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const anomaly = await db.operationalAnomaly.findFirst({
    where: { id: input.anomalyId, tenantId: ctx.tenantId },
  });
  if (!anomaly) return { success: false, error: "Finding not found." };
  if (anomaly.status === "resolved") {
    return { success: false, error: "This finding is already closed." };
  }

  if (parsed.data.disposition === "genuine") {
    const type = input.linkedCorrectionType?.trim();
    const id = input.linkedCorrectionId?.trim();
    if (!type || !id) {
      return {
        success: false,
        error: "Link the correction or reversal that fixed the underlying record.",
      };
    }
    if (!(await correctionExists(ctx.tenantId, type, id))) {
      return { success: false, error: "That correction was not found in this business." };
    }
  }

  const investigation = await ensureInvestigation(ctx.tenantId, ctx.userId, anomaly.id);
  const now = new Date();

  await db.$transaction(async (tx) => {
    await tx.anomalyInvestigation.update({
      where: { id: investigation.id },
      data: {
        status: "closed",
        disposition: parsed.data.disposition,
        dispositionNote: parsed.data.note,
        linkedCorrectionType: input.linkedCorrectionType?.trim() || null,
        linkedCorrectionId: input.linkedCorrectionId?.trim() || null,
        closedById: ctx.userId,
        closedAt: now,
      },
    });
    await tx.operationalAnomaly.update({
      where: { id: anomaly.id },
      data: {
        status: "resolved",
        resolvedById: ctx.userId,
        resolvedAt: now,
        resolutionNote: parsed.data.note,
      },
    });
    await tx.anomalyFindingEvent.create({
      data: {
        tenantId: ctx.tenantId,
        anomalyId: anomaly.id,
        kind: parsed.data.disposition === "false_positive" ? "false_positive" : "resolved",
        severity: anomaly.severity,
        note: parsed.data.note,
        actorId: ctx.userId,
      },
    });
    if (
      parsed.data.disposition === "false_positive" &&
      parsed.data.suppressDays &&
      parsed.data.suppressDays > 0
    ) {
      const suppression = await tx.anomalySuppression.create({
        data: {
          tenantId: ctx.tenantId,
          ruleKey: anomaly.ruleKey,
          entityType: anomaly.entityType,
          entityId: anomaly.entityId,
          reason: parsed.data.note.slice(0, 500),
          createdById: ctx.userId,
          expiresAt: suppressionExpiry(parsed.data.suppressDays, now),
        },
      });
      await tx.anomalyFindingEvent.create({
        data: {
          tenantId: ctx.tenantId,
          anomalyId: anomaly.id,
          kind: "suppressed",
          note: `This rule stays quiet for this record until ${suppression.expiresAt
            .toISOString()
            .slice(0, 10)}.`,
          actorId: ctx.userId,
        },
      });
    }
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "anomaly.investigation_closed",
      entityType: "operationalAnomaly",
      entityId: anomaly.id,
      details: {
        ruleKey: anomaly.ruleKey,
        disposition: parsed.data.disposition,
        linkedCorrectionType: input.linkedCorrectionType ?? null,
        linkedCorrectionId: input.linkedCorrectionId ?? null,
        suppressedDays: parsed.data.suppressDays ?? 0,
        financialMutation: false,
      },
    });
  });
  return { success: true };
}

export async function reopenAnomalyFinding(input: {
  anomalyId: string;
  note: string;
}): Promise<AnomalyActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const note = input.note?.trim() ?? "";
  if (note.length < 5) {
    return { success: false, error: "Say why this finding is being reopened." };
  }
  const anomaly = await db.operationalAnomaly.findFirst({
    where: { id: input.anomalyId, tenantId: ctx.tenantId },
    select: { id: true, status: true, ruleKey: true },
  });
  if (!anomaly) return { success: false, error: "Finding not found." };
  if (anomaly.status !== "resolved") {
    return { success: false, error: "Only a closed finding can be reopened." };
  }
  const investigation = await db.anomalyInvestigation.findFirst({
    where: { anomalyId: anomaly.id, tenantId: ctx.tenantId },
    select: { id: true },
  });
  await db.$transaction(async (tx) => {
    await tx.operationalAnomaly.update({
      where: { id: anomaly.id },
      data: {
        status: "open",
        resolvedById: null,
        resolvedAt: null,
        reopenCount: { increment: 1 },
      },
    });
    if (investigation) {
      await tx.anomalyInvestigation.update({
        where: { id: investigation.id },
        data: { status: "investigating", closedAt: null, closedById: null, disposition: null },
      });
    }
    await tx.anomalyFindingEvent.create({
      data: {
        tenantId: ctx.tenantId,
        anomalyId: anomaly.id,
        kind: "reopened",
        note,
        actorId: ctx.userId,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "anomaly.reopened",
      entityType: "operationalAnomaly",
      entityId: anomaly.id,
      details: { ruleKey: anomaly.ruleKey, note },
    });
  });
  return { success: true };
}

export interface SuppressionView {
  id: string;
  ruleKey: string;
  entityType: string | null;
  entityId: string | null;
  reason: string;
  createdAt: string;
  expiresAt: string;
  createdByName: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  active: boolean;
}

/** Rules or records that are deliberately quiet, and for how much longer. */
export async function listAnomalySuppressions(): Promise<{
  success: boolean;
  error?: string;
  data?: SuppressionView[];
}> {
  const ctx = await requireTenantAdminMomo();
  const rows = await db.anomalySuppression.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const names = await staffNames(ctx.tenantId, rows.map((row) => row.createdById));
  const now = Date.now();
  return {
    success: true,
    data: rows.map((row) => ({
      id: row.id,
      ruleKey: row.ruleKey,
      entityType: row.entityType,
      entityId: row.entityId,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      createdByName: names.get(row.createdById) ?? null,
      revokedAt: iso(row.revokedAt),
      revokeReason: row.revokeReason,
      active: !row.revokedAt && row.expiresAt.getTime() > now,
    })),
  };
}

export async function createAnomalySuppression(input: {
  ruleKey: string;
  entityType?: string;
  entityId?: string;
  reason: string;
  days: number;
}): Promise<AnomalyActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const parsed = suppressionSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const known = ANOMALY_RULE_CATALOG.some((rule) => rule.key === parsed.data.ruleKey);
  if (!known) return { success: false, error: "That rule does not exist." };
  const entityType = parsed.data.entityType?.trim() || null;
  const entityId = parsed.data.entityId?.trim() || null;
  if ((entityType && !entityId) || (!entityType && entityId)) {
    return { success: false, error: "Choose both the record type and the record, or neither." };
  }
  const days = Math.min(parsed.data.days, MAX_SUPPRESSION_DAYS);
  await db.$transaction(async (tx) => {
    await tx.anomalySuppression.create({
      data: {
        tenantId: ctx.tenantId,
        ruleKey: parsed.data.ruleKey,
        entityType,
        entityId,
        reason: parsed.data.reason,
        createdById: ctx.userId,
        expiresAt: suppressionExpiry(days),
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "anomaly.suppression_created",
      entityType: "anomalySuppression",
      entityId: parsed.data.ruleKey,
      details: { ruleKey: parsed.data.ruleKey, entityType, entityId, days, reason: parsed.data.reason },
    });
  });
  return { success: true };
}

export async function revokeAnomalySuppression(input: {
  id: string;
  reason: string;
}): Promise<AnomalyActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 5) {
    return { success: false, error: "Say why the suppression is being lifted." };
  }
  const row = await db.anomalySuppression.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
  });
  if (!row) return { success: false, error: "That suppression was not found." };
  if (row.revokedAt) return { success: false, error: "That suppression is already lifted." };
  await db.$transaction(async (tx) => {
    await tx.anomalySuppression.update({
      where: { id: row.id },
      data: { revokedAt: new Date(), revokedById: ctx.userId, revokeReason: reason },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "anomaly.suppression_revoked",
      entityType: "anomalySuppression",
      entityId: row.id,
      details: { ruleKey: row.ruleKey, reason },
    });
  });
  return { success: true };
}

export interface ScanRunView {
  id: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  scanned: number;
  created: number;
  reopened: number;
  suppressed: number;
  notified: number;
  periodFrom: string | null;
  periodTo: string | null;
  error: string | null;
}

/** Recent scans, so a scheduled run that failed is visible rather than silent. */
export async function listAnomalyScanRuns(): Promise<{
  success: boolean;
  error?: string;
  data?: ScanRunView[];
  limits?: { alertBudget: number; quietHours: number; maxSuppressionDays: number };
}> {
  const ctx = await requireTenantAdminMomo();
  const rows = await db.anomalyScanRun.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { startedAt: "desc" },
    take: 20,
  });
  return {
    success: true,
    data: rows.map((row) => ({
      id: row.id,
      trigger: row.trigger,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      finishedAt: iso(row.finishedAt),
      scanned: row.scanned,
      created: row.created,
      reopened: row.reopened,
      suppressed: row.suppressed,
      notified: row.notified,
      periodFrom: row.periodFrom,
      periodTo: row.periodTo,
      error: row.error,
    })),
    limits: {
      alertBudget: ALERT_BUDGET_PER_RUN,
      quietHours: NOTIFY_QUIET_HOURS,
      maxSuppressionDays: MAX_SUPPRESSION_DAYS,
    },
  };
}
