/**
 * Phase 8 — tenant-facing support requests.
 *
 * A request always belongs to the tenant and branch resolved from the server
 * session, never to a tenant id in the request body. Tenant staff see their own
 * requests; administrators see the business's requests inside their branch
 * scope. Internal notes are filtered out in the database predicate, so a tenant
 * query can never return one even if a page forgets to hide it.
 */

"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { createAuditLogTx } from "@/lib/audit";
import { type TenantContext } from "@/lib/tenant";
import { requireSupportIdentity } from "@/lib/support-access";
import {
  resolveBranchScope,
  assertBranchAccess,
  type BranchScope,
} from "@/lib/branch";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { buildCsv } from "@/lib/csv";
import {
  SUPPORT_DESCRIPTION_MAX,
  SUPPORT_DESCRIPTION_MIN,
  SUPPORT_MESSAGE_MAX,
  SUPPORT_REASON_MIN,
  SUPPORT_SUBJECT_MAX,
  SUPPORT_VISIBILITY,
  canTransitionSupport,
  findCredentialLikeValue,
  generateSupportReference,
  isSupportCategory,
  isSupportPriority,
  isSupportStatus,
  normalizeSupportText,
  tenantSupportExportRows,
  type SupportExportRow,
  type SupportStatus,
} from "@/lib/support";

const MAX_TENANT_EXPORT_ROWS = 5000;

export interface SupportMessageView {
  id: string;
  authorType: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export interface SupportEventView {
  id: string;
  type: string;
  actorType: string;
  actorName: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  createdAt: string;
}

export interface SupportRequestRow {
  id: string;
  reference: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  branchId: string | null;
  branchName: string;
  submittedByName: string;
  assignedToSupport: boolean;
  createdAt: string;
  lastActivityAt: string;
  reopenedCount: number;
  messageCount: number;
}

export interface SupportRequestDetail extends SupportRequestRow {
  description: string;
  resolutionNote: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  messages: SupportMessageView[];
  events: SupportEventView[];
}

export interface SupportCounts {
  total: number;
  open: number;
  acknowledged: number;
  in_progress: number;
  escalated: number;
  resolved: number;
  closed: number;
}

export interface SupportActionResult {
  success: boolean;
  error?: string;
  requestId?: string;
  reference?: string;
}

export interface SupportExportResult {
  success: boolean;
  error?: string;
  csv?: string;
  filename?: string;
  rowCount?: number;
}

function scopeWhere(ctx: TenantContext, scope: BranchScope): Record<string, unknown> {
  if (ctx.role !== "admin") return { tenantId: ctx.tenantId, submittedById: ctx.userId };
  if (scope.kind === "all") return { tenantId: ctx.tenantId };
  return {
    tenantId: ctx.tenantId,
    OR: [
      { branchId: { in: scope.branchIds } },
      { submittedById: ctx.userId },
    ],
  };
}

function canAccess(
  ctx: TenantContext,
  scope: BranchScope,
  request: { submittedById: string; branchId: string | null }
): boolean {
  if (ctx.role !== "admin") return request.submittedById === ctx.userId;
  if (scope.kind === "all") return true;
  if (request.submittedById === ctx.userId) return true;
  return request.branchId !== null && scope.branchIds.includes(request.branchId);
}

async function resolveNames(
  userIds: string[],
  agentIds: string[]
): Promise<{ users: Map<string, string>; agents: Map<string, string> }> {
  const [users, agents] = await Promise.all([
    userIds.length
      ? db.user.findMany({
          where: { id: { in: Array.from(new Set(userIds)) } },
          select: { id: true, fullName: true },
        })
      : Promise.resolve([]),
    agentIds.length
      ? db.platformSuperAdmin.findMany({
          where: { id: { in: Array.from(new Set(agentIds)) } },
          select: { id: true, fullName: true },
        })
      : Promise.resolve([]),
  ]);
  return {
    users: new Map(users.map((row) => [row.id, row.fullName])),
    agents: new Map(agents.map((row) => [row.id, row.fullName])),
  };
}

/** Any staff member with a live Susu or administrator session may use support. */
async function requireSupportUser(): Promise<TenantContext> {
  return requireSupportIdentity();
}

/**
 * Create a support request. The tenant comes from the session; a branch id is
 * accepted only when it is a tenant-owned branch the caller may read.
 */
export async function createSupportRequest(input: {
  category: string;
  priority: string;
  subject: string;
  description: string;
  branchId?: string | null;
}): Promise<SupportActionResult> {
  const ctx = await requireSupportUser();

  const category = String(input?.category ?? "");
  const priority = String(input?.priority ?? "normal");
  const subject = normalizeSupportText(input?.subject, SUPPORT_SUBJECT_MAX);
  const description = normalizeSupportText(input?.description, SUPPORT_DESCRIPTION_MAX);
  if (!isSupportCategory(category)) {
    return { success: false, error: "Choose what the request is about." };
  }
  if (!isSupportPriority(priority)) {
    return { success: false, error: "Choose a valid priority." };
  }
  if (subject.length < 3) return { success: false, error: "Give the request a short subject." };
  if (description.length < SUPPORT_DESCRIPTION_MIN) {
    return { success: false, error: "Describe the issue in at least " + SUPPORT_DESCRIPTION_MIN + " characters." };
  }

  const credential = findCredentialLikeValue(subject + "\n" + description);
  if (credential) return { success: false, error: credential };

  let branchId: string | null = null;
  const requestedBranch = String(input?.branchId ?? "").trim();
  if (requestedBranch) {
    if (!(await assertBranchAccess(ctx, requestedBranch, "read"))) {
      return { success: false, error: "That branch is not available to you." };
    }
    branchId = requestedBranch;
  } else if (ctx.role === "collector") {
    const collector = await db.collector.findFirst({
      where: { tenantId: ctx.tenantId, userId: ctx.userId },
      select: { branchId: true },
    });
    branchId = collector?.branchId ?? null;
  }

  const rate = await consumeRateLimit(
    "support:create",
    ctx.tenantId + ":" + ctx.userId,
    RATE_LIMITS.supportRequest
  );
  if (!rate.allowed) {
    return { success: false, error: "You have opened several requests recently. Please wait before opening another." };
  }

  let created: { id: string; reference: string } | null = null;
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    const reference = generateSupportReference();
    try {
      created = await db.$transaction(async (tx) => {
        const request = await tx.supportRequest.create({
          data: {
            tenantId: ctx.tenantId,
            branchId,
            reference,
            submittedById: ctx.userId,
            category,
            priority,
            status: "open",
            subject,
            description,
            lastActivityAt: new Date(),
          },
          select: { id: true, reference: true },
        });
        await tx.supportEvent.create({
          data: {
            requestId: request.id,
            type: "created",
            actorType: "tenant",
            actorUserId: ctx.userId,
            toStatus: "open",
          },
        });
        await createAuditLogTx(tx, {
          userId: ctx.userId,
          tenantId: ctx.tenantId,
          branchId,
          action: "support.request_created",
          entityType: "support_request",
          entityId: request.id,
          details: { reference: request.reference, category, priority },
        });
        return request;
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
    }
  }
  if (!created) {
    return { success: false, error: "Could not open the request. Please try again." };
  }

  revalidatePath("/susu/support");
  return { success: true, requestId: created.id, reference: created.reference };
}

/** List the requests this caller may see, newest activity first. */
export async function listSupportRequests(): Promise<SupportRequestRow[]> {
  const ctx = await requireSupportUser();
  const scope = await resolveBranchScope(ctx);
  const rows = await db.supportRequest.findMany({
    where: scopeWhere(ctx, scope) as never,
    orderBy: [{ lastActivityAt: "desc" }],
    take: 200,
    select: {
      id: true,
      reference: true,
      subject: true,
      category: true,
      priority: true,
      status: true,
      branchId: true,
      submittedById: true,
      assignedAgentId: true,
      createdAt: true,
      lastActivityAt: true,
      reopenedCount: true,
      _count: { select: { messages: { where: { visibility: SUPPORT_VISIBILITY.TENANT } } } },
    },
  });

  const userIds = rows.map((row) => row.submittedById);
  const names = await resolveNames(userIds, []);
  const branchIds = Array.from(new Set(rows.map((row) => row.branchId).filter((id): id is string => Boolean(id))));
  const branches = branchIds.length
    ? await db.location.findMany({
        where: { tenantId: ctx.tenantId, id: { in: branchIds } },
        select: { id: true, name: true },
      })
    : [];
  const branchNames = new Map(branches.map((row) => [row.id, row.name]));

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    branchId: row.branchId,
    branchName: row.branchId ? branchNames.get(row.branchId) ?? "Unknown branch" : "Company-wide",
    submittedByName: names.users.get(row.submittedById) ?? "A colleague",
    assignedToSupport: Boolean(row.assignedAgentId),
    createdAt: row.createdAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    reopenedCount: row.reopenedCount,
    messageCount: row._count.messages,
  }));
}

/** One request with only tenant-visible messages and safe event history. */
export async function getSupportRequestDetail(requestId: string): Promise<SupportRequestDetail | null> {
  const ctx = await requireSupportUser();
  const scope = await resolveBranchScope(ctx);
  const id = String(requestId ?? "");
  if (!id) return null;

  const request = await db.supportRequest.findFirst({ where: { id, tenantId: ctx.tenantId } });
  if (!request) return null;
  if (!canAccess(ctx, scope, request)) return null;

  const [messages, events, branch] = await Promise.all([
    db.supportMessage.findMany({
      where: { requestId: request.id, visibility: SUPPORT_VISIBILITY.TENANT },
      orderBy: { createdAt: "asc" },
      select: { id: true, authorType: true, authorUserId: true, authorAgentId: true, body: true, createdAt: true },
    }),
    db.supportEvent.findMany({
      where: { requestId: request.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        type: true,
        actorType: true,
        actorUserId: true,
        actorAgentId: true,
        fromStatus: true,
        toStatus: true,
        reason: true,
        createdAt: true,
      },
    }),
    request.branchId
      ? db.location.findFirst({ where: { id: request.branchId, tenantId: ctx.tenantId }, select: { name: true } })
      : Promise.resolve(null),
  ]);
  const names = await resolveNames(
    [request.submittedById],
    messages.map((row) => row.authorAgentId).filter((id): id is string => Boolean(id))
  );

  return {
    id: request.id,
    reference: request.reference,
    subject: request.subject,
    category: request.category,
    priority: request.priority,
    status: request.status,
    branchId: request.branchId,
    branchName: branch?.name ?? (request.branchId ? "Unknown branch" : "Company-wide"),
    submittedByName: names.users.get(request.submittedById) ?? "A colleague",
    assignedToSupport: Boolean(request.assignedAgentId),
    createdAt: request.createdAt.toISOString(),
    lastActivityAt: request.lastActivityAt.toISOString(),
    reopenedCount: request.reopenedCount,
    messageCount: messages.length,
    description: request.description,
    resolutionNote: request.resolutionNote,
    resolvedAt: request.resolvedAt?.toISOString() ?? null,
    closedAt: request.closedAt?.toISOString() ?? null,
    messages: messages.map((row) => ({
      id: row.id,
      authorType: row.authorType,
      authorName:
        row.authorType === "platform"
          ? "MaaCash Support"
          : row.authorUserId && names.users.get(row.authorUserId)
            ? names.users.get(row.authorUserId)!
            : "You",
      body: row.body,
      createdAt: row.createdAt.toISOString(),
    })),
    events: events.map((row) => ({
      id: row.id,
      type: row.type,
      actorType: row.actorType,
      actorName:
        row.actorType === "platform"
          ? "MaaCash Support"
          : row.actorUserId && names.users.get(row.actorUserId)
            ? names.users.get(row.actorUserId)!
            : "System",
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      // Only the tenant's own reopening reason is shown. Internal escalation
      // and closure reasons stay internal.
      reason: row.type === "reopened" ? row.reason : null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** Add a tenant-visible reply. A closed request must be reopened first. */
export async function replyToSupportRequest(input: {
  requestId: string;
  body: string;
}): Promise<SupportActionResult> {
  const ctx = await requireSupportUser();
  const id = String(input?.requestId ?? "");
  const body = normalizeSupportText(input?.body, SUPPORT_MESSAGE_MAX);
  if (!id) return { success: false, error: "Choose a request." };
  if (body.length < 2) return { success: false, error: "Write a message before sending." };
  const credential = findCredentialLikeValue(body);
  if (credential) return { success: false, error: credential };

  const rate = await consumeRateLimit(
    "support:reply",
    ctx.tenantId + ":" + ctx.userId,
    RATE_LIMITS.supportReply
  );
  if (!rate.allowed) {
    return { success: false, error: "You are sending messages quickly. Please wait a moment." };
  }

  const scope = await resolveBranchScope(ctx);
  const request = await db.supportRequest.findFirst({ where: { id, tenantId: ctx.tenantId } });
  if (!request || !canAccess(ctx, scope, request)) {
    return { success: false, error: "Request not found." };
  }
  if (request.status === "closed") {
    return { success: false, error: "This request is closed. Reopen it before replying." };
  }

  await db.$transaction(async (tx) => {
    await tx.supportMessage.create({
      data: {
        requestId: request.id,
        authorType: "tenant",
        authorUserId: ctx.userId,
        visibility: SUPPORT_VISIBILITY.TENANT,
        body,
      },
    });
    await tx.supportEvent.create({
      data: {
        requestId: request.id,
        type: "replied",
        actorType: "tenant",
        actorUserId: ctx.userId,
        fromStatus: request.status,
        toStatus: request.status,
      },
    });
    await tx.supportRequest.update({
      where: { id: request.id },
      data: { lastActivityAt: new Date() },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      branchId: request.branchId,
      action: "support.reply_sent",
      entityType: "support_request",
      entityId: request.id,
      details: { reference: request.reference },
    });
  });

  revalidatePath("/susu/support");
  revalidatePath("/susu/support/" + request.id);
  return { success: true, requestId: request.id };
}

/**
 * Reopen a resolved or closed request. Administrators only, inside their scope:
 * a reply from a colleague must not silently reopen a case support considers
 * finished.
 */
export async function reopenSupportRequest(input: {
  requestId: string;
  reason: string;
}): Promise<SupportActionResult> {
  const ctx = await requireSupportUser();
  if (ctx.role !== "admin") {
    return { success: false, error: "Only an administrator can reopen a request." };
  }
  const id = String(input?.requestId ?? "");
  const reason = normalizeSupportText(input?.reason, 500);
  if (!id) return { success: false, error: "Choose a request." };
  if (reason.length < SUPPORT_REASON_MIN) {
    return { success: false, error: "Record why the request is being reopened." };
  }

  const scope = await resolveBranchScope(ctx);
  const request = await db.supportRequest.findFirst({ where: { id, tenantId: ctx.tenantId } });
  if (!request || !canAccess(ctx, scope, request)) {
    return { success: false, error: "Request not found." };
  }
  if (!canTransitionSupport(request.status, "open")) {
    return { success: false, error: "Only a resolved or closed request can be reopened." };
  }

  const fromStatus = request.status as SupportStatus;
  await db.$transaction(async (tx) => {
    await tx.supportRequest.update({
      where: { id: request.id },
      data: {
        status: "open",
        reopenedCount: { increment: 1 },
        resolvedAt: null,
        resolvedAgentId: null,
        resolutionNote: null,
        closedAt: null,
        lastActivityAt: new Date(),
      },
    });
    await tx.supportEvent.create({
      data: {
        requestId: request.id,
        type: "reopened",
        actorType: "tenant",
        actorUserId: ctx.userId,
        fromStatus,
        toStatus: "open",
        reason,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      branchId: request.branchId,
      action: "support.request_reopened",
      entityType: "support_request",
      entityId: request.id,
      details: { reference: request.reference, reason },
    });
  });

  revalidatePath("/susu/support");
  revalidatePath("/susu/support/" + request.id);
  return { success: true, requestId: request.id };
}

/** Counts for the tenant support page. Same scope as the list. */
export async function getSupportCounts(): Promise<SupportCounts> {
  const ctx = await requireSupportUser();
  const scope = await resolveBranchScope(ctx);
  const rows = await db.supportRequest.groupBy({
    by: ["status"],
    where: scopeWhere(ctx, scope) as never,
    _count: { _all: true },
  });
  const counts: SupportCounts = {
    total: 0,
    open: 0,
    acknowledged: 0,
    in_progress: 0,
    escalated: 0,
    resolved: 0,
    closed: 0,
  };
  for (const row of rows) {
    const count = row._count._all;
    counts.total += count;
    if (isSupportStatus(row.status)) counts[row.status] = count;
  }
  return counts;
}

/**
 * Export the tenant's support request metadata. Message bodies, internal notes
 * and agent identities are deliberately excluded. Audited and rate-limited.
 */
export async function exportTenantSupportRequests(): Promise<SupportExportResult> {
  const ctx = await requireSupportUser();
  if (ctx.role !== "admin") {
    return { success: false, error: "Only an administrator can export support requests." };
  }

  const burst = await consumeRateLimit(
    "admin:support_export:burst",
    ctx.tenantId + ":" + ctx.userId,
    RATE_LIMITS.adminExportBurst
  );
  const sustained = await consumeRateLimit(
    "admin:support_export",
    ctx.tenantId + ":" + ctx.userId,
    RATE_LIMITS.adminExportSustained
  );
  if (!burst.allowed || !sustained.allowed) {
    return { success: false, error: "Too many exports. Please wait before exporting again." };
  }

  const scope = await resolveBranchScope(ctx);
  const rows = await db.supportRequest.findMany({
    where: scopeWhere(ctx, scope) as never,
    orderBy: [{ createdAt: "desc" }],
    take: MAX_TENANT_EXPORT_ROWS,
    select: {
      reference: true,
      subject: true,
      category: true,
      priority: true,
      status: true,
      branchId: true,
      submittedById: true,
      assignedAgentId: true,
      createdAt: true,
      lastActivityAt: true,
      reopenedCount: true,
    },
  });

  const names = await resolveNames(rows.map((row) => row.submittedById), []);
  const branchIds = Array.from(new Set(rows.map((row) => row.branchId).filter((id): id is string => Boolean(id))));
  const branches = branchIds.length
    ? await db.location.findMany({
        where: { tenantId: ctx.tenantId, id: { in: branchIds } },
        select: { id: true, name: true },
      })
    : [];
  const branchNames = new Map(branches.map((row) => [row.id, row.name]));

  const exportRows: SupportExportRow[] = rows.map((row) => ({
    reference: row.reference,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    branchName: row.branchId ? branchNames.get(row.branchId) ?? "Unknown branch" : "Company-wide",
    submittedByName: names.users.get(row.submittedById) ?? "Former colleague",
    assignedAgentName: "",
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    reopenedCount: row.reopenedCount,
    internalNoteCount: 0,
  }));

  const csv = buildCsv(tenantSupportExportRows(exportRows));
  const generatedAt = new Date().toISOString().slice(0, 10);

  await db.$transaction(async (tx) => {
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "support.exported",
      entityType: "support_request",
      details: { rowCount: exportRows.length, format: "csv" },
    });
  });

  return {
    success: true,
    csv,
    filename: "support-requests-" + generatedAt + ".csv",
    rowCount: exportRows.length,
  };
}
