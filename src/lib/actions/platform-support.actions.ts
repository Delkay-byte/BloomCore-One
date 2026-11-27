/**
 * Phase 8 — platform support operations.
 *
 * The support queue is the only place a platform administrator reads tenant
 * support content. Every state change is written with the platform audit log,
 * and tenant-visible replies are separated from internal notes at the database
 * predicate level.
 *
 * Support staff never receive a tenant session, never impersonate a tenant user
 * and never read tenant financial records through this module.
 */

"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import { createPlatformAuditLog } from "@/lib/platform-audit";
import { buildCsv } from "@/lib/csv";
import {
  SUPPORT_MESSAGE_MAX,
  SUPPORT_REASON_MIN,
  SUPPORT_VISIBILITY,
  canTransitionSupport,
  findCredentialLikeValue,
  isSupportCategory,
  isSupportPriority,
  isSupportStatus,
  normalizeSupportText,
  platformSupportExportRows,
  type SupportExportRow,
} from "@/lib/support";

const MAX_QUEUE = 200;
const MAX_EXPORT_ROWS = 5000;

export interface SupportQueueFilters {
  status?: string;
  priority?: string;
  category?: string;
  assignment?: "all" | "mine" | "unassigned";
  search?: string;
}

export interface SupportQueueRow {
  id: string;
  reference: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  tenantId: string | null;
  tenantName: string;
  branchName: string;
  submittedByName: string;
  assignedAgentId: string | null;
  assignedAgentName: string;
  ageHours: number;
  lastActivityAt: string;
  createdAt: string;
  reopenedCount: number;
  internalNoteCount: number;
}

export interface SupportOperationsSummary {
  open: number;
  unassigned: number;
  escalated: number;
  urgent: number;
  awaitingFirstResponse: number;
  olderThan48h: number;
  resolvedLast7Days: number;
  tenantsWithOpenRequests: number;
}

export interface SupportAgentMessage {
  id: string;
  authorType: string;
  authorName: string;
  visibility: string;
  body: string;
  createdAt: string;
}

export interface SupportAgentEvent {
  id: string;
  type: string;
  actorType: string;
  actorName: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  createdAt: string;
}

export interface SupportAgentView {
  id: string;
  reference: string;
  subject: string;
  description: string;
  category: string;
  priority: string;
  status: string;
  tenantId: string | null;
  tenantName: string;
  tenantCode: string;
  tenantStatus: string;
  branchId: string | null;
  branchName: string;
  submittedBy: {
    id: string;
    fullName: string;
    email: string;
    phone: string | null;
    role: string;
    status: string;
  } | null;
  assignedAgentId: string | null;
  assignedAgentName: string;
  escalatedAt: string | null;
  escalationLevel: number;
  resolvedAt: string | null;
  resolutionNote: string | null;
  closedAt: string | null;
  reopenedCount: number;
  createdAt: string;
  lastActivityAt: string;
  internalNoteCount: number;
  messages: SupportAgentMessage[];
  events: SupportAgentEvent[];
}

export interface SupportAgentActionResult {
  success: boolean;
  error?: string;
}

async function audit(params: {
  actorId: string;
  actorEmail: string;
  action: string;
  tenantId?: string | null;
  entityId: string;
  details?: Record<string, unknown>;
  reason?: string | null;
}) {
  await createPlatformAuditLog({
    actorId: params.actorId,
    actorEmail: params.actorEmail,
    action: params.action,
    tenantId: params.tenantId ?? null,
    entityType: "support_request",
    entityId: params.entityId,
    details: params.details ?? null,
    reason: params.reason ?? null,
  });
}

async function loadTenantNames(tenantIds: (string | null)[]): Promise<Map<string, { name: string; code: string; status: string }>> {
  const ids = Array.from(new Set(tenantIds.filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return new Map();
  const tenants = await db.businessTenant.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, code: true, status: true },
  });
  return new Map(tenants.map((row) => [row.id, { name: row.name, code: row.code, status: row.status }]));
}

async function loadAgentNames(agentIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(agentIds.filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return new Map();
  const agents = await db.platformSuperAdmin.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullName: true },
  });
  return new Map(agents.map((row) => [row.id, row.fullName]));
}

async function loadUserNames(userIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullName: true },
  });
  return new Map(users.map((row) => [row.id, row.fullName]));
}

/** Aggregate operational health of the support queue. */
export async function getSupportOperationsSummary(): Promise<SupportOperationsSummary> {
  await requirePlatformAdmin();
  const now = Date.now();
  const [statusRows, unassigned, escalated, urgent, awaitingFirstResponse, olderThan48h, resolvedLast7Days, tenants] =
    await Promise.all([
      db.supportRequest.groupBy({ by: ["status"], _count: { _all: true } }),
      db.supportRequest.count({ where: { assignedAgentId: null, status: { notIn: ["resolved", "closed"] } } }),
      db.supportRequest.count({ where: { status: "escalated" } }),
      db.supportRequest.count({
        where: { priority: "urgent", status: { notIn: ["resolved", "closed"] } },
      }),
      db.supportRequest.count({
        where: { status: "open", assignedAgentId: null, escalatedAt: null },
      }),
      db.supportRequest.count({
        where: {
          status: { notIn: ["resolved", "closed"] },
          createdAt: { lt: new Date(now - 48 * 60 * 60 * 1000) },
        },
      }),
      db.supportRequest.count({
        where: { resolvedAt: { gte: new Date(now - 7 * 24 * 60 * 60 * 1000) } },
      }),
      db.supportRequest.findMany({
        where: { tenantId: { not: null }, status: { notIn: ["resolved", "closed"] } },
        select: { tenantId: true },
        distinct: ["tenantId"],
      }),
    ]);

  let open = 0;
  for (const row of statusRows) {
    if (row.status !== "resolved" && row.status !== "closed") open += row._count._all;
  }

  return {
    open,
    unassigned,
    escalated,
    urgent,
    awaitingFirstResponse,
    olderThan48h,
    resolvedLast7Days,
    tenantsWithOpenRequests: tenants.length,
  };
}

/** The queue. Filters are validated; unknown values are ignored, not trusted. */
export async function listSupportQueue(filters?: SupportQueueFilters): Promise<SupportQueueRow[]> {
  const session = await requirePlatformAdmin();
  const status = isSupportStatus(filters?.status) ? filters!.status! : undefined;
  const priority = isSupportPriority(filters?.priority) ? filters!.priority! : undefined;
  const category = isSupportCategory(filters?.category) ? filters!.category! : undefined;
  const assignment = filters?.assignment ?? "all";
  const search = String(filters?.search ?? "").trim().slice(0, 100);

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (priority) where.priority = priority;
  if (category) where.category = category;
  if (assignment === "mine") where.assignedAgentId = session.adminId;
  if (assignment === "unassigned") where.assignedAgentId = null;
  if (search) {
    where.OR = [
      { reference: { contains: search } },
      { subject: { contains: search } },
    ];
  }

  const rows = await db.supportRequest.findMany({
    where: where as never,
    orderBy: [{ createdAt: "asc" }],
    take: MAX_QUEUE,
    select: {
      id: true,
      reference: true,
      subject: true,
      category: true,
      priority: true,
      status: true,
      tenantId: true,
      branchId: true,
      submittedById: true,
      assignedAgentId: true,
      createdAt: true,
      lastActivityAt: true,
      reopenedCount: true,
      _count: {
        select: { messages: { where: { visibility: SUPPORT_VISIBILITY.INTERNAL } } },
      },
    },
  });

  const [tenants, agents, users, branches] = await Promise.all([
    loadTenantNames(rows.map((row) => row.tenantId)),
    loadAgentNames(rows.map((row) => row.assignedAgentId)),
    loadUserNames(rows.map((row) => row.submittedById)),
    rows.some((row) => row.branchId)
      ? db.location.findMany({
          where: { id: { in: rows.map((row) => row.branchId).filter((id): id is string => Boolean(id)) } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const branchNames = new Map(branches.map((row) => [row.id, row.name]));
  const now = Date.now();
  // Database collation would put "urgent" after "normal" alphabetically, which
  // is the opposite of an operational queue. Rank explicitly, then oldest first.
  const priorityRank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  const ordered = rows.slice().sort((a, b) => {
    const rank = (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
    if (rank !== 0) return rank;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  return ordered.map((row) => ({
    id: row.id,
    reference: row.reference,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    tenantId: row.tenantId,
    tenantName: row.tenantId ? tenants.get(row.tenantId)?.name ?? "Unknown business" : "No business",
    branchName: row.branchId ? branchNames.get(row.branchId) ?? "Unknown branch" : "Company-wide",
    submittedByName: users.get(row.submittedById) ?? "Former staff member",
    assignedAgentId: row.assignedAgentId,
    assignedAgentName: row.assignedAgentId ? agents.get(row.assignedAgentId) ?? "Another agent" : "Unassigned",
    ageHours: Math.max(0, Math.floor((now - row.createdAt.getTime()) / 3_600_000)),
    lastActivityAt: row.lastActivityAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    reopenedCount: row.reopenedCount,
    internalNoteCount: row._count.messages,
  }));
}

/** Full agent view, including internal notes. Never exposed to a tenant page. */
export async function getSupportRequestAgentView(requestId: string): Promise<SupportAgentView | null> {
  await requirePlatformAdmin();
  const id = String(requestId ?? "");
  if (!id) return null;
  const request = await db.supportRequest.findUnique({ where: { id } });
  if (!request) return null;

  const [messages, events, tenant, branch, submittedBy, agentName] = await Promise.all([
    db.supportMessage.findMany({
      where: { requestId: request.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        authorType: true,
        authorUserId: true,
        authorAgentId: true,
        visibility: true,
        body: true,
        createdAt: true,
      },
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
    request.tenantId
      ? db.businessTenant.findUnique({
          where: { id: request.tenantId },
          select: { name: true, code: true, status: true },
        })
      : Promise.resolve(null),
    request.branchId
      ? db.location.findUnique({ where: { id: request.branchId }, select: { name: true } })
      : Promise.resolve(null),
    db.user.findUnique({
      where: { id: request.submittedById },
      select: { id: true, fullName: true, email: true, phone: true, role: true, status: true },
    }),
    request.assignedAgentId
      ? db.platformSuperAdmin.findUnique({ where: { id: request.assignedAgentId }, select: { fullName: true } })
      : Promise.resolve(null),
  ]);

  // Names are resolved after the first batch because the author ids come from
  // the messages themselves; referencing them inside the same Promise.all left
  // the message list in its own temporal dead zone.
  const [userNames, agentNames] = await Promise.all([
    loadUserNames(messages.map((row) => row.authorUserId)),
    loadAgentNames(messages.map((row) => row.authorAgentId).concat(request.assignedAgentId)),
  ]);

  return {
    id: request.id,
    reference: request.reference,
    subject: request.subject,
    description: request.description,
    category: request.category,
    priority: request.priority,
    status: request.status,
    tenantId: request.tenantId,
    tenantName: tenant?.name ?? "No business",
    tenantCode: tenant?.code ?? "",
    tenantStatus: tenant?.status ?? "",
    branchId: request.branchId,
    branchName: branch?.name ?? (request.branchId ? "Unknown branch" : "Company-wide"),
    submittedBy,
    assignedAgentId: request.assignedAgentId,
    assignedAgentName: agentName?.fullName ?? (request.assignedAgentId ? "Another agent" : "Unassigned"),
    escalatedAt: request.escalatedAt?.toISOString() ?? null,
    escalationLevel: request.escalationLevel,
    resolvedAt: request.resolvedAt?.toISOString() ?? null,
    resolutionNote: request.resolutionNote,
    closedAt: request.closedAt?.toISOString() ?? null,
    reopenedCount: request.reopenedCount,
    createdAt: request.createdAt.toISOString(),
    lastActivityAt: request.lastActivityAt.toISOString(),
    internalNoteCount: messages.filter((row) => row.visibility === SUPPORT_VISIBILITY.INTERNAL).length,
    messages: messages.map((row) => ({
      id: row.id,
      authorType: row.authorType,
      authorName:
        row.authorType === "platform"
          ? (row.authorAgentId && agentNames.get(row.authorAgentId)) || "Support agent"
          : row.authorType === "tenant"
            ? userNames.get(row.authorUserId ?? "") ?? "Tenant staff"
            : "System",
      visibility: row.visibility,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
    })),
    events: events.map((row) => ({
      id: row.id,
      type: row.type,
      actorType: row.actorType,
      actorName:
        row.actorType === "platform"
          ? (row.actorAgentId && agentNames.get(row.actorAgentId)) || "Support agent"
          : row.actorType === "tenant"
            ? userNames.get(row.actorUserId ?? "") ?? "Tenant staff"
            : "System",
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

async function transition(
  requestId: string,
  toStatus: string,
  options: { requireStatuses?: string[]; extra?: Record<string, unknown>; type: string; reason?: string | null }
): Promise<{ success: boolean; error?: string; request?: { id: string; tenantId: string | null; reference: string; status: string } }> {
  const session = await requirePlatformAdmin();
  const id = String(requestId ?? "");
  if (!id) return { success: false, error: "Choose a request." };
  const request = await db.supportRequest.findUnique({
    where: { id },
    select: { id: true, tenantId: true, reference: true, status: true },
  });
  if (!request) return { success: false, error: "Request not found." };
  if (options.requireStatuses && !options.requireStatuses.includes(request.status)) {
    return { success: false, error: "This action is not available for a request in that state." };
  }
  if (!canTransitionSupport(request.status, toStatus)) {
    return { success: false, error: "That status change is not permitted." };
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.supportRequest.update({
      where: { id: request.id },
      data: { status: toStatus, lastActivityAt: now, ...(options.extra ?? {}) },
    });
    await tx.supportEvent.create({
      data: {
        requestId: request.id,
        type: options.type,
        actorType: "platform",
        actorAgentId: session.adminId,
        fromStatus: request.status,
        toStatus,
        reason: options.reason ?? null,
      },
    });
  });

  await audit({
    actorId: session.adminId,
    actorEmail: session.email,
    action: "support." + options.type,
    tenantId: request.tenantId,
    entityId: request.id,
    details: { reference: request.reference, fromStatus: request.status, toStatus },
    reason: options.reason ?? null,
  });

  revalidatePath("/platform/support");
  revalidatePath("/platform/support/" + request.id);
  return { success: true, request };
}

/** Acknowledge: assign to the acting agent if unassigned and acknowledge. */
export async function acknowledgeSupportRequest(requestId: string): Promise<SupportAgentActionResult> {
  const session = await requirePlatformAdmin();
  const request = await db.supportRequest.findUnique({
    where: { id: String(requestId ?? "") },
    select: { id: true, tenantId: true, reference: true, status: true, assignedAgentId: true },
  });
  if (!request) return { success: false, error: "Request not found." };
  if (request.status !== "open") {
    return { success: false, error: "Only an open request can be acknowledged." };
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.supportRequest.update({
      where: { id: request.id },
      data: {
        status: "acknowledged",
        assignedAgentId: request.assignedAgentId ?? session.adminId,
        assignedAt: request.assignedAgentId ? undefined : now,
        lastActivityAt: now,
      },
    });
    await tx.supportEvent.create({
      data: {
        requestId: request.id,
        type: "acknowledged",
        actorType: "platform",
        actorAgentId: session.adminId,
        fromStatus: "open",
        toStatus: "acknowledged",
      },
    });
  });

  await audit({
    actorId: session.adminId,
    actorEmail: session.email,
    action: "support.acknowledged",
    tenantId: request.tenantId,
    entityId: request.id,
    details: { reference: request.reference, assignedToSelf: !request.assignedAgentId },
  });
  revalidatePath("/platform/support");
  revalidatePath("/platform/support/" + request.id);
  return { success: true };
}

/** Assign to an active platform agent (default: the acting agent). */
export async function assignSupportRequest(input: {
  requestId: string;
  agentId?: string;
}): Promise<SupportAgentActionResult> {
  const session = await requirePlatformAdmin();
  const id = String(input?.requestId ?? "");
  const agentId = String(input?.agentId ?? session.adminId);
  const [request, agent] = await Promise.all([
    db.supportRequest.findUnique({
      where: { id },
      select: { id: true, tenantId: true, reference: true, status: true, assignedAgentId: true },
    }),
    db.platformSuperAdmin.findFirst({ where: { id: agentId, status: "active" }, select: { id: true, fullName: true } }),
  ]);
  if (!request) return { success: false, error: "Request not found." };
  if (!agent) return { success: false, error: "Choose an active platform agent." };
  if (request.status === "closed") return { success: false, error: "Reopen the request before assigning it." };
  if (request.assignedAgentId === agent.id) return { success: false, error: "This request is already assigned to that agent." };

  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.supportRequest.update({
      where: { id: request.id },
      data: {
        assignedAgentId: agent.id,
        assignedAt: now,
        status: request.status === "open" ? "acknowledged" : request.status,
        lastActivityAt: now,
      },
    });
    await tx.supportEvent.create({
      data: {
        requestId: request.id,
        type: "assigned",
        actorType: "platform",
        actorAgentId: session.adminId,
        fromStatus: request.status,
        toStatus: request.status === "open" ? "acknowledged" : request.status,
        reason: "Assigned to " + agent.fullName,
      },
    });
  });

  await audit({
    actorId: session.adminId,
    actorEmail: session.email,
    action: "support.assigned",
    tenantId: request.tenantId,
    entityId: request.id,
    details: { reference: request.reference, agentId: agent.id, agentName: agent.fullName },
  });
  revalidatePath("/platform/support");
  revalidatePath("/platform/support/" + request.id);
  return { success: true };
}

export async function escalateSupportRequest(input: {
  requestId: string;
  reason: string;
}): Promise<SupportAgentActionResult> {
  const session = await requirePlatformAdmin();
  const reason = normalizeSupportText(input?.reason, 1000);
  if (reason.length < SUPPORT_REASON_MIN) {
    return { success: false, error: "Record why the request is being escalated." };
  }
  const id = String(input?.requestId ?? "");
  const request = await db.supportRequest.findUnique({
    where: { id },
    select: {
      id: true,
      tenantId: true,
      reference: true,
      status: true,
      escalationLevel: true,
    },
  });
  if (!request) return { success: false, error: "Request not found." };
  if (["resolved", "closed"].includes(request.status)) {
    return { success: false, error: "Reopen the request before escalating it." };
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.supportRequest.update({
      where: { id: request.id },
      data: {
        status: "escalated",
        escalatedAt: now,
        escalationLevel: { increment: 1 },
        lastActivityAt: now,
      },
    });
    await tx.supportEvent.create({
      data: {
        requestId: request.id,
        type: "escalated",
        actorType: "platform",
        actorAgentId: session.adminId,
        fromStatus: request.status,
        toStatus: "escalated",
        reason,
      },
    });
  });

  await audit({
    actorId: session.adminId,
    actorEmail: session.email,
    action: "support.escalated",
    tenantId: request.tenantId,
    entityId: request.id,
    details: { reference: request.reference, escalationLevel: request.escalationLevel + 1 },
    reason,
  });
  revalidatePath("/platform/support");
  revalidatePath("/platform/support/" + request.id);
  return { success: true };
}

export async function addSupportInternalNote(input: {
  requestId: string;
  body: string;
}): Promise<SupportAgentActionResult> {
  const session = await requirePlatformAdmin();
  const id = String(input?.requestId ?? "");
  const body = normalizeSupportText(input?.body, SUPPORT_MESSAGE_MAX);
  if (!id) return { success: false, error: "Choose a request." };
  if (body.length < 2) return { success: false, error: "Write a note before saving." };
  const credential = findCredentialLikeValue(body);
  if (credential) return { success: false, error: credential };

  const request = await db.supportRequest.findUnique({
    where: { id },
    select: { id: true, tenantId: true, reference: true, status: true },
  });
  if (!request) return { success: false, error: "Request not found." };

  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.supportMessage.create({
      data: {
        requestId: request.id,
        authorType: "platform",
        authorAgentId: session.adminId,
        visibility: SUPPORT_VISIBILITY.INTERNAL,
        body,
      },
    });
    await tx.supportEvent.create({
      data: {
        requestId: request.id,
        type: "internal_note",
        actorType: "platform",
        actorAgentId: session.adminId,
        fromStatus: request.status,
        toStatus: request.status,
      },
    });
    await tx.supportRequest.update({ where: { id: request.id }, data: { lastActivityAt: now } });
  });

  await audit({
    actorId: session.adminId,
    actorEmail: session.email,
    action: "support.internal_note_added",
    tenantId: request.tenantId,
    entityId: request.id,
    details: { reference: request.reference },
  });
  revalidatePath("/platform/support/" + request.id);
  return { success: true };
}

/** A tenant-visible reply. Moves an open/acknowledged request into progress. */
export async function replyToTenantSupportRequest(input: {
  requestId: string;
  body: string;
}): Promise<SupportAgentActionResult> {
  const session = await requirePlatformAdmin();
  const id = String(input?.requestId ?? "");
  const body = normalizeSupportText(input?.body, SUPPORT_MESSAGE_MAX);
  if (!id) return { success: false, error: "Choose a request." };
  if (body.length < 2) return { success: false, error: "Write a reply before sending." };
  const credential = findCredentialLikeValue(body);
  if (credential) return { success: false, error: credential };

  const request = await db.supportRequest.findUnique({
    where: { id },
    select: { id: true, tenantId: true, reference: true, status: true, assignedAgentId: true },
  });
  if (!request) return { success: false, error: "Request not found." };
  if (request.status === "closed") {
    return { success: false, error: "Reopen the request before replying." };
  }

  const nextStatus =
    request.status === "open" || request.status === "acknowledged" ? "in_progress" : request.status;
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.supportMessage.create({
      data: {
        requestId: request.id,
        authorType: "platform",
        authorAgentId: session.adminId,
        visibility: SUPPORT_VISIBILITY.TENANT,
        body,
      },
    });
    await tx.supportRequest.update({
      where: { id: request.id },
      data: {
        status: nextStatus,
        assignedAgentId: request.assignedAgentId ?? session.adminId,
        assignedAt: request.assignedAgentId ? undefined : now,
        lastActivityAt: now,
      },
    });
    await tx.supportEvent.create({
      data: {
        requestId: request.id,
        type: "replied",
        actorType: "platform",
        actorAgentId: session.adminId,
        fromStatus: request.status,
        toStatus: nextStatus,
      },
    });
  });

  await audit({
    actorId: session.adminId,
    actorEmail: session.email,
    action: "support.replied",
    tenantId: request.tenantId,
    entityId: request.id,
    details: { reference: request.reference, fromStatus: request.status, toStatus: nextStatus },
  });
  revalidatePath("/platform/support");
  revalidatePath("/platform/support/" + request.id);
  return { success: true };
}

export async function resolveSupportRequest(input: {
  requestId: string;
  resolutionNote: string;
}): Promise<SupportAgentActionResult> {
  const note = normalizeSupportText(input?.resolutionNote, 2000);
  if (note.length < 10) {
    return { success: false, error: "Write the resolution so the tenant can see what was done." };
  }
  const session = await requirePlatformAdmin();
  const result = await transition(String(input?.requestId ?? ""), "resolved", {
    requireStatuses: ["open", "acknowledged", "in_progress", "escalated"],
    extra: { resolvedAt: new Date(), resolvedAgentId: session.adminId, resolutionNote: note },
    type: "resolved",
    reason: note,
  });
  if (!result.success) return { success: false, error: result.error };
  return { success: true };
}

/** Close a resolved request. Closing an escalated one requires a reason. */
export async function closeSupportRequest(input: {
  requestId: string;
  reason?: string;
}): Promise<SupportAgentActionResult> {
  const reason = normalizeSupportText(input?.reason, 1000);
  const session = await requirePlatformAdmin();
  const id = String(input?.requestId ?? "");
  const request = await db.supportRequest.findUnique({
    where: { id },
    select: { id: true, tenantId: true, reference: true, status: true },
  });
  if (!request) return { success: false, error: "Request not found." };
  if (!["resolved", "escalated"].includes(request.status)) {
    return { success: false, error: "Resolve the request first, or escalate it and record why it is being closed." };
  }
  if (request.status === "escalated" && reason.length < SUPPORT_REASON_MIN) {
    return { success: false, error: "Record why an escalated request is being closed." };
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.supportRequest.update({
      where: { id: request.id },
      data: { status: "closed", closedAt: now, lastActivityAt: now },
    });
    await tx.supportEvent.create({
      data: {
        requestId: request.id,
        type: "closed",
        actorType: "platform",
        actorAgentId: session.adminId,
        fromStatus: request.status,
        toStatus: "closed",
        reason: reason || null,
      },
    });
  });

  await audit({
    actorId: session.adminId,
    actorEmail: session.email,
    action: "support.closed",
    tenantId: request.tenantId,
    entityId: request.id,
    details: { reference: request.reference, fromStatus: request.status },
    reason: reason || null,
  });
  revalidatePath("/platform/support");
  revalidatePath("/platform/support/" + request.id);
  return { success: true };
}

/** Support-side reopen (for example a tenant replied after closure). */
export async function reopenSupportRequestAsSupport(input: {
  requestId: string;
  reason: string;
}): Promise<SupportAgentActionResult> {
  const reason = normalizeSupportText(input?.reason, 1000);
  if (reason.length < SUPPORT_REASON_MIN) {
    return { success: false, error: "Record why the request is being reopened." };
  }
  const session = await requirePlatformAdmin();
  const id = String(input?.requestId ?? "");
  const request = await db.supportRequest.findUnique({
    where: { id },
    select: { id: true, tenantId: true, reference: true, status: true },
  });
  if (!request) return { success: false, error: "Request not found." };
  if (!["resolved", "closed"].includes(request.status)) {
    return { success: false, error: "Only a resolved or closed request can be reopened." };
  }

  const now = new Date();
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
        lastActivityAt: now,
      },
    });
    await tx.supportEvent.create({
      data: {
        requestId: request.id,
        type: "reopened",
        actorType: "platform",
        actorAgentId: session.adminId,
        fromStatus: request.status,
        toStatus: "open",
        reason,
      },
    });
  });

  await audit({
    actorId: session.adminId,
    actorEmail: session.email,
    action: "support.reopened",
    tenantId: request.tenantId,
    entityId: request.id,
    details: { reference: request.reference, previousStatus: request.status },
    reason,
  });
  revalidatePath("/platform/support");
  revalidatePath("/platform/support/" + request.id);
  return { success: true };
}

/**
 * Export queue metadata for operational review. No message bodies and no
 * internal notes are included, and the export itself is platform-audited.
 */
export async function exportSupportQueue(filters?: SupportQueueFilters): Promise<{
  success: boolean;
  csv?: string;
  filename?: string;
  rowCount?: number;
  error?: string;
}> {
  const session = await requirePlatformAdmin();
  const status = isSupportStatus(filters?.status) ? filters!.status! : undefined;
  const priority = isSupportPriority(filters?.priority) ? filters!.priority! : undefined;
  const category = isSupportCategory(filters?.category) ? filters!.category! : undefined;
  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (priority) where.priority = priority;
  if (category) where.category = category;
  if (filters?.assignment === "mine") where.assignedAgentId = session.adminId;
  if (filters?.assignment === "unassigned") where.assignedAgentId = null;

  const rows = await db.supportRequest.findMany({
    where: where as never,
    orderBy: [{ createdAt: "desc" }],
    take: MAX_EXPORT_ROWS,
    select: {
      reference: true,
      subject: true,
      category: true,
      priority: true,
      status: true,
      tenantId: true,
      branchId: true,
      submittedById: true,
      assignedAgentId: true,
      createdAt: true,
      lastActivityAt: true,
      reopenedCount: true,
      _count: { select: { messages: { where: { visibility: SUPPORT_VISIBILITY.INTERNAL } } } },
    },
  });
  const [agents, users, branches] = await Promise.all([
    loadAgentNames(rows.map((row) => row.assignedAgentId)),
    loadUserNames(rows.map((row) => row.submittedById)),
    rows.some((row) => row.branchId)
      ? db.location.findMany({
          where: { id: { in: rows.map((row) => row.branchId).filter((id): id is string => Boolean(id)) } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const branchNames = new Map(branches.map((row) => [row.id, row.name]));

  const exportRows: SupportExportRow[] = rows.map((row) => ({
    reference: row.reference,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    branchName: row.branchId ? branchNames.get(row.branchId) ?? "Unknown branch" : "Company-wide",
    submittedByName: users.get(row.submittedById) ?? "Former staff member",
    assignedAgentName: row.assignedAgentId ? agents.get(row.assignedAgentId) ?? "Another agent" : "Unassigned",
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    reopenedCount: row.reopenedCount,
    internalNoteCount: row._count.messages,
  }));
  const csv = buildCsv(platformSupportExportRows(exportRows));
  const fileDate = new Date().toISOString().slice(0, 10);

  await createPlatformAuditLog({
    actorId: session.adminId,
    actorEmail: session.email,
    action: "support.exported",
    entityType: "support_request",
    details: { rowCount: exportRows.length, format: "csv", status: status ?? "all" },
  });

  return { success: true, csv, filename: "support-queue-" + fileDate + ".csv", rowCount: exportRows.length };
}

/** Active platform agents available for assignment. */
export async function listSupportAgents(): Promise<{ id: string; fullName: string }[]> {
  await requirePlatformAdmin();
  return db.platformSuperAdmin.findMany({
    where: { status: "active" },
    orderBy: { fullName: "asc" },
    select: { id: true, fullName: true },
  });
}
