"use server";

import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { requireTenantAdminSusu, requireTenantCustomer } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import { createNotification } from "@/lib/notifications/notifications";
import { revalidatePath } from "next/cache";
import {
  canTransitionDispute,
  generateDisputeReference,
  isDisputeSubjectType,
  openDisputeSchema,
  outcomeStatus,
  requestDisputeInfoSchema,
  resolveDisputeSchema,
  respondToDisputeSchema,
  subjectLabel,
  type DisputeCategory,
  type DisputeStatus,
  type DisputeSubjectType,
} from "@/lib/customer-disputes";

export interface DisputeActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface DisputeSubjectView {
  type: DisputeSubjectType;
  id: string;
  reference: string;
  amount: number;
  occurredAt: string;
  status: string;
  accountNumber: string;
  cycleNumber: number;
  channel: string;
  description: string;
  existingDispute: { id: string; reference: string; status: string } | null;
}

export interface DisputeEventView {
  id: string;
  actorType: string;
  actorName: string | null;
  action: string;
  note: string | null;
  createdAt: string;
}

export interface CustomerDisputeView {
  id: string;
  reference: string;
  subjectType: DisputeSubjectType;
  subjectId: string;
  subjectReference: string;
  subjectAmount: number;
  category: DisputeCategory;
  details: string;
  status: DisputeStatus;
  accountNumber: string | null;
  cycleNumber: number | null;
  createdAt: string;
  updatedAt: string;
  resolutionNote: string | null;
  resolvedAt: string | null;
  outcomeReference: string | null;
  customerName: string | null;
  customerNumber: string | null;
  events: DisputeEventView[];
}

function money(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

function revalidateDisputes() {
  revalidatePath("/customer/disputes");
  revalidatePath("/susu/admin/disputes");
}

function eventActorName(
  actorType: string,
  actorId: string | null,
  customerName: string | null,
  adminNames: Map<string, string>
): string | null {
  if (!actorId) return null;
  if (actorType === "customer") return customerName;
  return adminNames.get(actorId) ?? null;
}

async function adminNamesFor(tenantId: string, ids: string[]) {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return new Map<string, string>();
  const users = await db.user.findMany({
    where: { tenantId, id: { in: unique } },
    select: { id: true, fullName: true },
  });
  return new Map(users.map((user) => [user.id, user.fullName]));
}

// ---------------------------------------------------------------------------
// Customer side
// ---------------------------------------------------------------------------

export async function getCustomerDisputeSubject(
  subjectType: string,
  subjectId: string
): Promise<DisputeSubjectView | null> {
  const ctx = await requireTenantCustomer();
  if (!isDisputeSubjectType(subjectType) || !subjectId) return null;

  if (subjectType === "contribution") {
    const row = await db.contribution.findFirst({
      where: {
        id: subjectId,
        tenantId: ctx.tenantId,
        account: { customerId: ctx.userId, tenantId: ctx.tenantId },
      },
      include: {
        account: { select: { id: true, accountId: true } },
        cycle: { select: { cycleNumber: true } },
      },
    });
    if (!row) return null;
    const existing = await db.customerDispute.findUnique({
      where: {
        tenantId_subjectType_subjectId: {
          tenantId: ctx.tenantId,
          subjectType: "contribution",
          subjectId: row.id,
        },
      },
      select: { id: true, reference: true, status: true },
    });
    return {
      type: "contribution",
      id: row.id,
      reference: row.referenceId,
      amount: money(row.amount),
      occurredAt: row.collectionDate.toISOString(),
      status: row.reversedAt ? "reversed" : row.reversalOfId ? "reversal" : "completed",
      accountNumber: row.account.accountId,
      cycleNumber: row.cycle.cycleNumber,
      channel: row.channel,
      description: "Contribution",
      existingDispute: existing,
    };
  }

  const row = await db.withdrawal.findFirst({
    where: {
      id: subjectId,
      tenantId: ctx.tenantId,
      account: { customerId: ctx.userId, tenantId: ctx.tenantId },
    },
    include: {
      account: { select: { id: true, accountId: true } },
      cycle: { select: { cycleNumber: true } },
    },
  });
  if (!row) return null;
  const existing = await db.customerDispute.findUnique({
    where: {
      tenantId_subjectType_subjectId: {
        tenantId: ctx.tenantId,
        subjectType: "withdrawal",
        subjectId: row.id,
      },
    },
    select: { id: true, reference: true, status: true },
  });
  return {
    type: "withdrawal",
    id: row.id,
    reference: row.referenceId,
    amount: money(row.netAmount),
    occurredAt: row.createdAt.toISOString(),
    status: row.status,
    accountNumber: row.account.accountId,
    cycleNumber: row.cycle.cycleNumber,
    channel: "withdrawal",
    description: `Withdrawal (requested ${money(row.requestedAmount).toFixed(2)}, commission ${money(
      row.commissionAmount
    ).toFixed(2)})`,
    existingDispute: existing,
  };
}

export async function openCustomerDispute(input: {
  subjectType: string;
  subjectId: string;
  category: string;
  details: string;
}): Promise<DisputeActionResponse> {
  const ctx = await requireTenantCustomer();
  const parsed = openDisputeSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }
  const values = parsed.data;

  const subject =
    values.subjectType === "contribution"
      ? await db.contribution.findFirst({
          where: {
            id: values.subjectId,
            tenantId: ctx.tenantId,
            account: { customerId: ctx.userId, tenantId: ctx.tenantId },
          },
          include: { account: { select: { id: true } } },
        })
      : await db.withdrawal.findFirst({
          where: {
            id: values.subjectId,
            tenantId: ctx.tenantId,
            account: { customerId: ctx.userId, tenantId: ctx.tenantId },
          },
          include: { account: { select: { id: true } } },
        });

  if (!subject) {
    return {
      success: false,
      error: `That recorded ${subjectLabel(values.subjectType)} is not on your account.`,
    };
  }
  if (values.subjectType === "withdrawal" && "status" in subject && subject.status === "pending") {
    return {
      success: false,
      error: "A pending withdrawal cannot be disputed until it is completed.",
    };
  }
  if ("status" in subject && subject.status === "rejected") {
    return {
      success: false,
      error: "A rejected withdrawal was not paid, so there is no payment to dispute.",
    };
  }

  const existing = await db.customerDispute.findUnique({
    where: {
      tenantId_subjectType_subjectId: {
        tenantId: ctx.tenantId,
        subjectType: values.subjectType,
        subjectId: values.subjectId,
      },
    },
    select: { id: true, reference: true, status: true },
  });
  if (existing) {
    return {
      success: false,
      error: `A dispute already exists for this ${subjectLabel(values.subjectType)} (${existing.reference}).`,
    };
  }

  const now = new Date();
  const reference = generateDisputeReference(
    now,
    randomBytes(3).toString("hex").toUpperCase()
  );
  const amount =
    values.subjectType === "contribution"
      ? money((subject as { amount: unknown }).amount)
      : money((subject as { netAmount: unknown }).netAmount);
  const subjectReference =
    values.subjectType === "contribution"
      ? (subject as { referenceId: string }).referenceId
      : (subject as { referenceId: string }).referenceId;

  try {
    const dispute = await db.$transaction(async (tx) => {
      const created = await tx.customerDispute.create({
        data: {
          tenantId: ctx.tenantId,
          reference,
          customerId: ctx.userId,
          accountId: subject.account.id,
          subjectType: values.subjectType,
          subjectId: values.subjectId,
          subjectReference,
          subjectAmount: amount,
          category: values.category,
          details: values.details,
          status: "open",
          openedByType: "customer",
          openedById: ctx.userId,
          events: {
            create: {
              tenantId: ctx.tenantId,
              actorType: "customer",
              actorId: ctx.userId,
              action: "opened",
              note: values.details,
            },
          },
        },
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "customer_dispute.opened",
        entityType: "customerDispute",
        entityId: created.id,
        details: {
          reference: created.reference,
          subjectType: values.subjectType,
          subjectReference,
          subjectAmount: amount,
          category: values.category,
        },
      });
      return created;
    });

    await createNotification({
      tenantId: ctx.tenantId,
      audience: "tenant",
      kind: "system",
      severity: "attention",
      title: `Customer dispute ${dispute.reference}`,
      body: `A customer disputed a ${subjectLabel(values.subjectType)} of GH₵${amount.toFixed(
        2
      )}. Review the recorded transaction.`,
      href: "/susu/admin/disputes",
      dedupeKey: `customer_dispute_opened:${dispute.id}`,
    }).catch(() => null);

    revalidateDisputes();
    return { success: true, data: { disputeId: dispute.id, reference: dispute.reference } };
  } catch (error) {
    if (uniqueViolation(error)) {
      return {
        success: false,
        error: "A dispute already exists for this transaction.",
      };
    }
    return { success: false, error: "The dispute could not be opened." };
  }
}

async function customerDisputeRows(customerId: string, tenantId: string) {
  return db.customerDispute.findMany({
    where: { tenantId, customerId },
    include: {
      account: { select: { accountId: true } },
      customer: { select: { fullName: true, customerId: true } },
      events: { orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

type DisputeRow = Awaited<ReturnType<typeof customerDisputeRows>>[number];

function mapCustomerDispute(
  row: DisputeRow,
  adminNames: Map<string, string>
): CustomerDisputeView {
  return {
    id: row.id,
    reference: row.reference,
    subjectType: row.subjectType as DisputeSubjectType,
    subjectId: row.subjectId,
    subjectReference: row.subjectReference,
    subjectAmount: money(row.subjectAmount),
    category: row.category as DisputeCategory,
    details: row.details,
    status: row.status as DisputeStatus,
    accountNumber: row.account?.accountId ?? null,
    cycleNumber: null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    outcomeReference: row.outcomeReference,
    customerName: row.customer.fullName,
    customerNumber: row.customer.customerId,
    events: row.events.map((event) => ({
      id: event.id,
      actorType: event.actorType,
      actorName: eventActorName(
        event.actorType,
        event.actorId,
        row.customer.fullName,
        adminNames
      ),
      action: event.action,
      note: event.note,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

export async function getCustomerDisputes(): Promise<CustomerDisputeView[]> {
  const ctx = await requireTenantCustomer();
  const rows = await customerDisputeRows(ctx.userId, ctx.tenantId);
  const names = await adminNamesFor(
    ctx.tenantId,
    rows.flatMap((row) => row.events.map((event) => event.actorId ?? ""))
  );
  return rows.map((row) => mapCustomerDispute(row, names));
}

export async function getCustomerDispute(id: string): Promise<CustomerDisputeView | null> {
  const ctx = await requireTenantCustomer();
  if (!id) return null;
  const row = await db.customerDispute.findFirst({
    where: { id, tenantId: ctx.tenantId, customerId: ctx.userId },
    include: {
      account: { select: { accountId: true } },
      customer: { select: { fullName: true, customerId: true } },
      events: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!row) return null;
  const names = await adminNamesFor(
    ctx.tenantId,
    row.events.map((event) => event.actorId ?? "").filter(Boolean)
  );
  return mapCustomerDispute(row, names);
}

export async function respondToCustomerDispute(input: {
  disputeId: string;
  note: string;
}): Promise<DisputeActionResponse> {
  const ctx = await requireTenantCustomer();
  const parsed = respondToDisputeSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }
  const values = parsed.data;
  const dispute = await db.customerDispute.findFirst({
    where: { id: values.disputeId, tenantId: ctx.tenantId, customerId: ctx.userId },
  });
  if (!dispute) return { success: false, error: "Dispute not found." };
  if (!["open", "under_review", "awaiting_customer"].includes(dispute.status)) {
    return { success: false, error: "This dispute is already closed." };
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.customerDispute.update({
        where: { id: dispute.id },
        data: { status: "under_review" },
      });
      await tx.customerDisputeEvent.create({
        data: {
          tenantId: ctx.tenantId,
          disputeId: dispute.id,
          actorType: "customer",
          actorId: ctx.userId,
          action: "customer_responded",
          note: values.note,
        },
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "customer_dispute.customer_responded",
        entityType: "customerDispute",
        entityId: dispute.id,
        details: { reference: dispute.reference },
      });
    });
  } catch {
    return { success: false, error: "Your response could not be recorded." };
  }
  revalidateDisputes();
  return { success: true };
}

export async function cancelCustomerDispute(id: string): Promise<DisputeActionResponse> {
  const ctx = await requireTenantCustomer();
  const dispute = await db.customerDispute.findFirst({
    where: { id, tenantId: ctx.tenantId, customerId: ctx.userId },
  });
  if (!dispute) return { success: false, error: "Dispute not found." };
  if (dispute.status !== "open") {
    return {
      success: false,
      error: "Only a dispute that has not entered review can be cancelled.",
    };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.customerDispute.updateMany({
        where: { id: dispute.id, tenantId: ctx.tenantId, status: "open" },
        data: { status: "cancelled" },
      });
      if (updated.count !== 1) throw new Error("DISPUTE_CONFLICT");
      await tx.customerDisputeEvent.create({
        data: {
          tenantId: ctx.tenantId,
          disputeId: dispute.id,
          actorType: "customer",
          actorId: ctx.userId,
          action: "cancelled",
          note: null,
        },
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "customer_dispute.cancelled",
        entityType: "customerDispute",
        entityId: dispute.id,
        details: { reference: dispute.reference },
      });
    });
  } catch {
    return { success: false, error: "The dispute could not be cancelled." };
  }
  revalidateDisputes();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Administrator side
// ---------------------------------------------------------------------------

export interface AdminDisputeBoard {
  disputes: CustomerDisputeView[];
  counts: {
    open: number;
    underReview: number;
    awaitingCustomer: number;
    resolvedUpheld: number;
    resolvedDeclined: number;
    cancelled: number;
  };
}

async function adminDisputeRow(id: string, tenantId: string) {
  return db.customerDispute.findFirst({
    where: { id, tenantId },
    include: {
      account: { select: { accountId: true } },
      customer: { select: { fullName: true, customerId: true } },
      events: { orderBy: { createdAt: "asc" } },
    },
  });
}

export async function getAdminDisputes(filters?: {
  status?: string;
  category?: string;
}): Promise<AdminDisputeBoard> {
  const ctx = await requireTenantAdminSusu();
  const where: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (filters?.status && filters.status !== "all") where.status = filters.status;
  if (filters?.category && filters.category !== "all") where.category = filters.category;

  const [rows, all] = await Promise.all([
    db.customerDispute.findMany({
      where,
      include: {
        account: { select: { accountId: true } },
        customer: { select: { fullName: true, customerId: true } },
        events: { orderBy: { createdAt: "asc" } },
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 200,
    }),
    db.customerDispute.findMany({
      where: { tenantId: ctx.tenantId },
      select: { status: true },
    }),
  ]);

  const names = await adminNamesFor(
    ctx.tenantId,
    rows.flatMap((row) => row.events.map((event) => event.actorId ?? "")).filter(Boolean)
  );

  const statusOrder = (status: string) =>
    status === "open" ? 0 : status === "under_review" ? 1 : status === "awaiting_customer" ? 2 : 3;
  rows.sort(
    (a, b) =>
      statusOrder(a.status) - statusOrder(b.status) ||
      b.createdAt.getTime() - a.createdAt.getTime()
  );

  return {
    disputes: rows.map((row) => mapCustomerDispute(row, names)),
    counts: {
      open: all.filter((row) => row.status === "open").length,
      underReview: all.filter((row) => row.status === "under_review").length,
      awaitingCustomer: all.filter((row) => row.status === "awaiting_customer").length,
      resolvedUpheld: all.filter((row) => row.status === "resolved_upheld").length,
      resolvedDeclined: all.filter((row) => row.status === "resolved_declined").length,
      cancelled: all.filter((row) => row.status === "cancelled").length,
    },
  };
}

export async function getAdminDispute(id: string): Promise<CustomerDisputeView | null> {
  const ctx = await requireTenantAdminSusu();
  const row = await adminDisputeRow(id, ctx.tenantId);
  if (!row) return null;
  const names = await adminNamesFor(
    ctx.tenantId,
    row.events.map((event) => event.actorId ?? "").filter(Boolean)
  );
  return mapCustomerDispute(row, names);
}

export async function startDisputeReview(id: string): Promise<DisputeActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const dispute = await adminDisputeRow(id, ctx.tenantId);
  if (!dispute) return { success: false, error: "Dispute not found." };
  if (!canTransitionDispute(dispute.status as DisputeStatus, "under_review")) {
    return { success: false, error: "This dispute cannot enter review in its current state." };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.customerDispute.updateMany({
        where: { id, tenantId: ctx.tenantId, status: "open" },
        data: { status: "under_review" },
      });
      if (updated.count !== 1) throw new Error("DISPUTE_CONFLICT");
      await tx.customerDisputeEvent.create({
        data: {
          tenantId: ctx.tenantId,
          disputeId: id,
          actorType: "admin",
          actorId: ctx.userId,
          action: "review_started",
          note: null,
        },
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "customer_dispute.review_started",
        entityType: "customerDispute",
        entityId: id,
        details: { reference: dispute.reference },
      });
    });
  } catch {
    return { success: false, error: "The review could not be started." };
  }
  revalidateDisputes();
  return { success: true };
}

export async function requestDisputeInformation(input: {
  disputeId: string;
  note: string;
}): Promise<DisputeActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const parsed = requestDisputeInfoSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }
  const values = parsed.data;
  const dispute = await adminDisputeRow(values.disputeId, ctx.tenantId);
  if (!dispute) return { success: false, error: "Dispute not found." };
  if (dispute.status !== "under_review") {
    return { success: false, error: "Start the review before asking for information." };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.customerDispute.updateMany({
        where: { id: dispute.id, tenantId: ctx.tenantId, status: "under_review" },
        data: { status: "awaiting_customer" },
      });
      if (updated.count !== 1) throw new Error("DISPUTE_CONFLICT");
      await tx.customerDisputeEvent.create({
        data: {
          tenantId: ctx.tenantId,
          disputeId: dispute.id,
          actorType: "admin",
          actorId: ctx.userId,
          action: "information_requested",
          note: values.note,
        },
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "customer_dispute.information_requested",
        entityType: "customerDispute",
        entityId: dispute.id,
        details: { reference: dispute.reference, note: values.note },
      });
    });
  } catch {
    return { success: false, error: "The request could not be recorded." };
  }
  revalidateDisputes();
  return { success: true };
}

export async function resolveCustomerDispute(input: {
  disputeId: string;
  outcome: string;
  note: string;
  outcomeReference?: string;
}): Promise<DisputeActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const parsed = resolveDisputeSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }
  const values = parsed.data;
  const dispute = await adminDisputeRow(values.disputeId, ctx.tenantId);
  if (!dispute) return { success: false, error: "Dispute not found." };
  const nextStatus = outcomeStatus(values.outcome);
  if (!canTransitionDispute(dispute.status as DisputeStatus, nextStatus)) {
    return {
      success: false,
      error: "Start the review before resolving this dispute.",
    };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.customerDispute.updateMany({
        where: {
          id: dispute.id,
          tenantId: ctx.tenantId,
          status: { in: ["under_review", "awaiting_customer"] },
        },
        data: {
          status: nextStatus,
          resolutionNote: values.note,
          resolutionById: ctx.userId,
          resolvedAt: new Date(),
          outcomeReference:
            values.outcome === "upheld" ? values.outcomeReference?.trim() || null : null,
        },
      });
      if (updated.count !== 1) throw new Error("DISPUTE_CONFLICT");
      await tx.customerDisputeEvent.create({
        data: {
          tenantId: ctx.tenantId,
          disputeId: dispute.id,
          actorType: "admin",
          actorId: ctx.userId,
          action: values.outcome === "upheld" ? "resolved_upheld" : "resolved_declined",
          note: values.note,
        },
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "customer_dispute.resolved",
        entityType: "customerDispute",
        entityId: dispute.id,
        details: {
          reference: dispute.reference,
          outcome: values.outcome,
          note: values.note,
          outcomeReference: values.outcomeReference ?? null,
          financialMutation: false,
        },
      });
    });
  } catch {
    return { success: false, error: "The outcome could not be recorded." };
  }

  await createNotification({
    tenantId: ctx.tenantId,
    audience: "tenant",
    kind: "system",
    severity: "info",
    title: `Customer dispute ${dispute.reference} resolved`,
    body:
      values.outcome === "upheld"
        ? "The dispute was upheld. Carry out any correction through the normal financial control and record its reference."
        : "The recorded transaction was confirmed. The customer can see the outcome in the portal.",
    href: "/susu/admin/disputes",
    dedupeKey: `customer_dispute_resolved:${dispute.id}`,
  }).catch(() => null);

  revalidateDisputes();
  return { success: true, data: { status: nextStatus } };
}
