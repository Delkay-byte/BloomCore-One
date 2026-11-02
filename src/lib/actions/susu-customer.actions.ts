"use server";

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import {
  requireTenantAdminSusu,
  requireTenantCustomer,
  assertTenantEntity,
  type TenantContext,
} from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";
import { normalizeGhanaPhone } from "@/lib/utils";
import { revalidatePath } from "next/cache";
import { validateStatusTransition } from "@/lib/security/status";

export interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Human-readable identifier generation
//
// Customer and account identifiers stay GLOBALLY unique (the customer portal
// signs in with them, and login has no tenant hint to disambiguate). They are
// therefore allocated from a global sequence, but the sequence is computed
// safely: we never assume the count is free, we probe for the next unused
// value. Two tenants creating a customer concurrently cannot collide.
// ---------------------------------------------------------------------------

async function nextCustomerId(): Promise<string> {
  const total = await db.customer.count();
  for (let i = total + 1; i < total + 1000; i++) {
    const candidate = `BIK-C-${String(i).padStart(6, "0")}`;
    const taken = await db.customer.findUnique({
      where: { customerId: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  // Extremely unlikely: fall back to a random suffix rather than fail.
  return `BIK-C-${Math.floor(Math.random() * 900000 + 100000)}`;
}

async function nextAccountId(): Promise<string> {
  const total = await db.susuAccount.count();
  for (let i = total + 1; i < total + 1000; i++) {
    const candidate = `BIK-S-${String(i).padStart(6, "0")}`;
    const taken = await db.susuAccount.findUnique({
      where: { accountId: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  return `BIK-S-${Math.floor(Math.random() * 900000 + 100000)}`;
}

export async function createCustomer(
  formData: FormData
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  const fullName = (formData.get("fullName") as string)?.trim();
  const phone = (formData.get("phone") as string)?.trim() || undefined;
  const address = (formData.get("address") as string)?.trim() || undefined;
  const dailyContribution = parseFloat(
    formData.get("dailyContribution") as string
  );
  const cardFee = parseFloat(formData.get("cardFee") as string) || 10;
  const temporaryPassword =
    (formData.get("temporaryPassword") as string)?.trim() || undefined;

  if (!fullName || fullName.length < 2) {
    return { success: false, error: "Full name must be at least 2 characters" };
  }
  if (!dailyContribution || dailyContribution <= 0) {
    return { success: false, error: "Daily contribution must be greater than 0" };
  }
  if (temporaryPassword && temporaryPassword.length < 8) {
    return {
      success: false,
      error: "Temporary password must be at least 8 characters",
    };
  }

  const customerId = await nextCustomerId();
  const accountId = await nextAccountId();

  // Customer, account, card fee and first cycle are created together so a
  // failure cannot leave a customer with no account.
  const created = await db.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: {
        tenantId: ctx.tenantId,
        customerId,
        fullName,
        phone,
        address,
        status: "active",
      },
    });

    const susuAccount = await tx.susuAccount.create({
      data: {
        tenantId: ctx.tenantId,
        accountId,
        customerId: customer.id,
        dailyContribution,
        status: "active",
        cardCustody: "customer",
      },
    });

    await tx.cardFee.create({
      data: {
        tenantId: ctx.tenantId,
        accountId: susuAccount.id,
        amount: cardFee,
        recordedById: ctx.userId,
        notes: "Initial card purchase",
      },
    });

    const now = new Date();
    const cycleStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const cycleEnd = new Date(now.getFullYear(), now.getMonth(), 31);

    await tx.susuCycle.create({
      data: {
        tenantId: ctx.tenantId,
        accountId: susuAccount.id,
        cycleNumber: 1,
        startDate: cycleStart,
        endDate: cycleEnd,
        dailyContribution,
        status: "active",
        commissionCharged: false,
      },
    });

    return { customer, susuAccount };
  });

  let portalCreated = false;
  if (temporaryPassword) {
    const portalPasswordHash = await hashPassword(temporaryPassword);
    await db.customer.update({
      where: { id: created.customer.id },
      data: {
        portalEnabled: true,
        portalPasswordHash,
        forcePortalPasswordReset: true,
      },
    });
    portalCreated = true;
    await createAuditLog({
      userId: ctx.userId,
      action: "susu.customer_portal_created",
      entityType: "customer",
      entityId: created.customer.id,
      details: {
        customerId,
        method: "create_customer",
        forcePasswordReset: true,
      },
    });
  }

  await createAuditLog({
    userId: ctx.userId,
    action: "susu.customer_created",
    entityType: "customer",
    entityId: created.customer.id,
    details: { customerId, fullName, dailyContribution },
  });

  revalidatePath("/susu/admin/customers");
  return {
    success: true,
    data: {
      customer: created.customer,
      susuAccount: created.susuAccount,
      portalEnabled: portalCreated,
    },
  };
}

export async function updateCustomer(
  customerId: string,
  formData: FormData
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  // Cross-tenant guard: the customer must belong to this business.
  if (!(await assertTenantEntity("customer", customerId, ctx))) {
    return { success: false, error: "Customer not found" };
  }

  const fullName = (formData.get("fullName") as string)?.trim();
  const phone = (formData.get("phone") as string)?.trim() || undefined;
  const address = (formData.get("address") as string)?.trim() || undefined;
  const dailyContribution = parseFloat(
    formData.get("dailyContribution") as string
  );

  if (!fullName || fullName.length < 2) {
    return { success: false, error: "Full name must be at least 2 characters" };
  }

  const customer = await db.customer.update({
    where: { id: customerId },
    data: { fullName, phone, address },
  });

  if (dailyContribution && dailyContribution > 0) {
    await db.susuAccount.updateMany({
      where: { customerId, status: "active", tenantId: ctx.tenantId },
      data: { dailyContribution },
    });
  }

  await createAuditLog({
    userId: ctx.userId,
    action: "susu.customer_updated",
    entityType: "customer",
    entityId: customerId,
    details: { fullName },
  });

  revalidatePath("/susu/admin/customers");
  return { success: true, data: customer };
}

export async function toggleCustomerStatus(
  customerId: string,
  newStatus: string
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  if (!(await assertTenantEntity("customer", customerId, ctx))) {
    return { success: false, error: "Customer not found" };
  }

  const current = await db.customer.findFirst({
    where: { id: customerId, tenantId: ctx.tenantId },
    select: { status: true },
  });
  if (!current) return { success: false, error: "Customer not found" };
  const check = validateStatusTransition(current.status, newStatus);
  if (!check.ok) return { success: false, error: check.error };

  await db.customer.update({
    where: { id: customerId },
    data: { status: check.status },
  });

  await createAuditLog({
    userId: ctx.userId,
    action: `susu.customer_${newStatus === "active" ? "activated" : "deactivated"}`,
    entityType: "customer",
    entityId: customerId,
  });

  revalidatePath("/susu/admin/customers");
  return { success: true };
}

export async function getCustomers(params?: {
  page?: number;
  limit?: number;
  status?: string;
  search?: string;
  collectorId?: string;
}) {
  const ctx = await requireTenantAdminSusu();

  const page = params?.page || 1;
  const limit = params?.limit || 20;
  const skip = (page - 1) * limit;

  // Tenant scope is always present and cannot be overridden by params.
  const where: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (params?.status) where.status = params.status;

  if (params?.search) {
    where.OR = [
      { fullName: { contains: params.search } },
      { customerId: { contains: params.search } },
      { phone: { contains: params.search } },
    ];
  }

  if (params?.collectorId) {
    // The collector must belong to this tenant before we filter by it.
    if (!(await assertTenantEntity("collector", params.collectorId, ctx))) {
      return {
        customers: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
      };
    }
    where.assignments = {
      some: {
        collectorId: params.collectorId,
        active: true,
        tenantId: ctx.tenantId,
      },
    };
  }

  const [customers, total] = await Promise.all([
    db.customer.findMany({
      where,
      include: {
        accounts: {
          where: { status: "active", tenantId: ctx.tenantId },
          include: {
            cycles: { where: { status: "active" }, take: 1 },
          },
        },
        assignments: {
          where: { active: true, tenantId: ctx.tenantId },
          include: {
            collector: { include: { user: { select: { fullName: true } } } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    db.customer.count({ where }),
  ]);

  return {
    customers,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getCustomerById(id: string) {
  const ctx = await requireTenantAdminSusu();

  return db.customer.findFirst({
    where: { id, tenantId: ctx.tenantId },
    include: {
      accounts: {
        include: {
          cycles: {
            orderBy: { cycleNumber: "desc" },
            include: {
              contributions: {
                orderBy: { collectionDate: "asc" },
                include: {
                  allocations: true,
                  recordedBy: { select: { fullName: true } },
                  receivedBy: { select: { fullName: true } },
                },
              },
              withdrawals: { orderBy: { createdAt: "desc" } },
              commissions: true,
            },
          },
          cardFees: true,
        },
      },
      assignments: {
        include: {
          collector: {
            include: { user: { select: { fullName: true, id: true } } },
          },
        },
        orderBy: { assignedAt: "desc" },
      },
    },
  });
}

export async function reassignCustomer(params: {
  customerId: string;
  accountId: string;
  newCollectorId: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const { customerId, accountId, newCollectorId } = params;

  // All three referenced entities must belong to this tenant. This is the
  // cross-tenant ID substitution guard: a foreign id fails here.
  const failed = await (async () => {
    for (const [model, id] of [
      ["customer", customerId],
      ["susuAccount", accountId],
      ["collector", newCollectorId],
    ] as const) {
      if (!(await assertTenantEntity(model, id, ctx))) return model;
    }
    return null;
  })();

  if (failed === "customer") {
    return { success: false, error: "Customer not found" };
  }
  if (failed === "susuAccount") {
    return { success: false, error: "Account not found" };
  }
  if (failed === "collector") {
    return { success: false, error: "Selected collector is not available" };
  }

  const customer = await db.customer.findUnique({ where: { id: customerId } });
  if (!customer) return { success: false, error: "Customer not found" };

  const newCollector = await db.collector.findFirst({
    where: { id: newCollectorId, tenantId: ctx.tenantId },
    include: { user: { select: { fullName: true, status: true } } },
  });
  if (!newCollector || newCollector.user.status !== "active") {
    return { success: false, error: "Selected collector is not available" };
  }

  const currentAssignment = await db.collectorCustomerAssignment.findFirst({
    where: { customerId, accountId, active: true, tenantId: ctx.tenantId },
    include: { collector: { include: { user: { select: { fullName: true } } } } },
  });

  if (currentAssignment && currentAssignment.collectorId === newCollectorId) {
    return {
      success: false,
      error: "Customer is already assigned to this collector",
    };
  }

  const previousCollectorName =
    currentAssignment?.collector?.user?.fullName || "None";

  await db.$transaction(async (tx) => {
    if (currentAssignment) {
      await tx.collectorCustomerAssignment.update({
        where: { id: currentAssignment.id },
        data: { active: false, unassignedAt: new Date() },
      });
    }

    const existingNew = await tx.collectorCustomerAssignment.findUnique({
      where: {
        collectorId_accountId: { collectorId: newCollectorId, accountId },
      },
    });

    if (existingNew) {
      await tx.collectorCustomerAssignment.update({
        where: { id: existingNew.id },
        data: { active: true, unassignedAt: null },
      });
    } else {
      await tx.collectorCustomerAssignment.create({
        data: {
          tenantId: ctx.tenantId,
          collectorId: newCollectorId,
          customerId,
          accountId,
          active: true,
        },
      });
    }
  });

  await createAuditLog({
    userId: ctx.userId,
    action: "susu.customer_reassigned",
    entityType: "customer",
    entityId: customerId,
    details: {
      customerId: customer.customerId,
      customerName: customer.fullName,
      previousCollector: previousCollectorName,
      newCollector: newCollector.user.fullName,
    },
  });

  revalidatePath("/susu/admin/customers");
  revalidatePath(`/susu/admin/customers/${customerId}`);
  return { success: true };
}

export async function searchStaff(query: string) {
  const ctx = await requireTenantAdminSusu();

  if (!query || query.length < 2) return [];

  const normalizedQuery = query.trim().toLowerCase();

  // Tenant-scoped: staff search never crosses business boundaries.
  const candidates = await db.user.findMany({
    where: {
      tenantId: ctx.tenantId,
      status: "active",
      role: { in: ["admin", "worker", "collector"] },
    },
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      role: true,
    },
    take: 200,
  });

  return candidates
    .filter((u) => {
      const nameLower = u.fullName.toLowerCase();
      const emailLower = u.email.toLowerCase();
      const phoneLower = (u.phone || "").toLowerCase();
      return (
        nameLower.includes(normalizedQuery) ||
        emailLower.includes(normalizedQuery) ||
        phoneLower.includes(normalizedQuery)
      );
    })
    .slice(0, 20)
    .map((u) => ({
      id: u.id,
      label: u.fullName,
      subLabel: `${u.role} • ${u.email}${u.phone ? ` • ${u.phone}` : ""} • ID: ${u.id.slice(0, 12)}…`,
    }));
}

export async function searchCustomers(query: string) {
  const ctx = await requireTenantAdminSusu();

  if (!query || query.length < 2) return [];

  const normalizedQuery = query.trim().toLowerCase();
  const phoneCandidates = normalizeGhanaPhone(query);

  // Tenant-scoped SmartSearch.
  const candidates = await db.customer.findMany({
    where: { status: "active", tenantId: ctx.tenantId },
    include: {
      accounts: {
        where: { status: "active", tenantId: ctx.tenantId },
        include: {
          cycles: { where: { status: "active" }, take: 1 },
        },
      },
    },
    take: 200,
  });

  const seen = new Set<string>();
  return candidates
    .filter((c) => {
      if (seen.has(c.id)) return false;
      const nameLower = c.fullName.toLowerCase();
      const idLower = c.customerId.toLowerCase();
      const phoneLower = (c.phone || "").toLowerCase();
      const matches =
        nameLower.includes(normalizedQuery) ||
        idLower.includes(normalizedQuery) ||
        phoneLower.includes(normalizedQuery) ||
        phoneCandidates.some((p) =>
          (c.phone || "")
            .replace(/[^\d]/g, "")
            .endsWith(p.replace(/[^\d]/g, ""))
        );
      if (matches) seen.add(c.id);
      return matches;
    })
    .slice(0, 10);
}

// ---------------------------------------------------------------------------
// CUSTOMER PORTAL (self-service)
//
// The portal resolves the customer from the session and additionally scopes
// every query by the customer's tenant, so a portal session can only ever read
// its own business's data.
// ---------------------------------------------------------------------------

export async function getCustomerAccount() {
  const ctx = await requireTenantCustomer();

  return db.customer.findFirst({
    where: { id: ctx.userId, tenantId: ctx.tenantId },
    include: {
      accounts: {
        where: { status: "active", tenantId: ctx.tenantId },
        take: 1,
        include: {
          cycles: {
            where: { status: "active" },
            take: 1,
            include: {
              contributions: {
                orderBy: { collectionDate: "desc" },
                take: 20,
                include: {
                  allocations: true,
                  receivedBy: { select: { fullName: true } },
                  collector: {
                    include: { user: { select: { fullName: true } } },
                  },
                },
              },
              withdrawals: { orderBy: { createdAt: "desc" }, take: 20 },
              commissions: { orderBy: { createdAt: "desc" } },
            },
          },
        },
      },
      assignments: {
        where: { active: true, tenantId: ctx.tenantId },
        include: {
          collector: { include: { user: { select: { fullName: true } } } },
        },
      },
    },
  });
}

export async function getCustomerPayments() {
  const ctx = await requireTenantCustomer();

  return db.contribution.findMany({
    where: {
      tenantId: ctx.tenantId,
      account: { customerId: ctx.userId, tenantId: ctx.tenantId },
    },
    include: {
      cycle: { select: { cycleNumber: true } },
      collector: { include: { user: { select: { fullName: true } } } },
      receivedBy: { select: { fullName: true } },
      allocations: true,
    },
    orderBy: { collectionDate: "desc" },
  });
}

export async function getCustomerCycles() {
  const ctx = await requireTenantCustomer();

  const customer = await db.customer.findFirst({
    where: { id: ctx.userId, tenantId: ctx.tenantId },
    include: {
      accounts: {
        where: { status: "active", tenantId: ctx.tenantId },
        take: 1,
        include: {
          cycles: {
            orderBy: { cycleNumber: "desc" },
            include: {
              contributions: { include: { allocations: true } },
              withdrawals: true,
              commissions: true,
            },
          },
        },
      },
    },
  });

  if (!customer || !customer.accounts[0]) return [];

  const account = customer.accounts[0];

  return account.cycles.map((cycle) => {
    const totalContributed = cycle.contributions.reduce(
      (sum, c) => sum + Number(c.amount),
      0
    );
    const totalWithdrawn = cycle.withdrawals.reduce(
      (sum, w) => sum + Number(w.netAmount),
      0
    );
    const totalCommissions = cycle.commissions.reduce(
      (sum, c) => sum + Number(c.amount),
      0
    );
    const paidDays = new Set(
      cycle.contributions.flatMap((c) => c.allocations.map((a) => a.cycleDay))
    ).size;
    const balance = totalContributed - totalWithdrawn - totalCommissions;

    return {
      id: cycle.id,
      cycleNumber: cycle.cycleNumber,
      startDate: cycle.startDate,
      endDate: cycle.endDate,
      dailyContribution: Number(cycle.dailyContribution),
      status: cycle.status,
      totalContributed,
      totalWithdrawn,
      totalCommissions,
      paidDays,
      balance,
    };
  });
}

export async function getCustomerWithdrawals() {
  const ctx = await requireTenantCustomer();

  return db.withdrawal.findMany({
    where: {
      tenantId: ctx.tenantId,
      account: { customerId: ctx.userId, tenantId: ctx.tenantId },
    },
    include: { cycle: { select: { cycleNumber: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getCustomerStatement() {
  const ctx = await requireTenantCustomer();

  const scope = {
    tenantId: ctx.tenantId,
    account: { customerId: ctx.userId, tenantId: ctx.tenantId },
  };

  const contributions = await db.contribution.findMany({
    where: scope,
    include: {
      cycle: { select: { cycleNumber: true } },
      receivedBy: { select: { fullName: true } },
    },
    orderBy: { collectionDate: "asc" },
  });

  const withdrawals = await db.withdrawal.findMany({
    where: scope,
    include: { cycle: { select: { cycleNumber: true } } },
    orderBy: { createdAt: "asc" },
  });

  const commissions = await db.commission.findMany({
    where: scope,
    include: { cycle: { select: { cycleNumber: true } } },
    orderBy: { createdAt: "asc" },
  });

  const entries: Array<{
    date: Date;
    type: "contribution" | "withdrawal" | "commission";
    amount: number;
    balance?: number;
    channel: string;
    receivedBy?: string;
    cycleNumber: number;
    notes?: string;
  }> = [];

  let runningBalance = 0;

  contributions.forEach((c) => {
    runningBalance += Number(c.amount);
    entries.push({
      date: new Date(c.collectionDate),
      type: "contribution",
      amount: Number(c.amount),
      balance: runningBalance,
      channel: c.channel,
      receivedBy:
        (c as { receivedByName?: string | null }).receivedByName ??
        c.receivedBy?.fullName,
      cycleNumber: c.cycle.cycleNumber,
    });
  });

  withdrawals.forEach((w) => {
    runningBalance -= Number(w.netAmount);
    entries.push({
      date: new Date(w.createdAt),
      type: "withdrawal",
      amount: Number(w.netAmount),
      balance: runningBalance,
      channel: "withdrawal",
      cycleNumber: w.cycle.cycleNumber,
      notes: w.notes || undefined,
    });

    if (Number(w.commissionAmount) > 0) {
      runningBalance -= Number(w.commissionAmount);
      entries.push({
        date: new Date(w.createdAt),
        type: "commission",
        amount: Number(w.commissionAmount),
        balance: runningBalance,
        channel: "commission",
        cycleNumber: w.cycle.cycleNumber,
      });
    }
  });

  commissions.forEach((c) => {
    runningBalance -= Number(c.amount);
    entries.push({
      date: new Date(c.createdAt),
      type: "commission",
      amount: Number(c.amount),
      balance: runningBalance,
      channel: "commission",
      cycleNumber: c.cycle.cycleNumber,
    });
  });

  return entries.sort((a, b) => a.date.getTime() - b.date.getTime());
}

export async function getCustomerProfile() {
  const ctx = await requireTenantCustomer();

  return db.customer.findFirst({
    where: { id: ctx.userId, tenantId: ctx.tenantId },
    include: {
      accounts: {
        where: { status: "active", tenantId: ctx.tenantId },
        take: 1,
        include: {
          cycles: { where: { status: "active" }, take: 1 },
        },
      },
      assignments: {
        where: { active: true, tenantId: ctx.tenantId },
        include: {
          collector: { include: { user: { select: { fullName: true } } } },
        },
      },
    },
  });
}

// ===================================================================
// ADMIN CUSTOMER PORTAL PROVISIONING
// ===================================================================

export async function createCustomerPortalAccess(
  customerId: string,
  formData: FormData
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  const loginIdentifier = (formData.get("loginIdentifier") as string)?.trim();
  const temporaryPassword = formData.get("temporaryPassword") as string;

  if (!loginIdentifier) {
    return { success: false, error: "Login identifier is required" };
  }
  if (!temporaryPassword || temporaryPassword.length < 8) {
    return {
      success: false,
      error: "Temporary password must be at least 8 characters",
    };
  }

  if (!(await assertTenantEntity("customer", customerId, ctx))) {
    return { success: false, error: "Customer not found" };
  }

  const customer = await db.customer.findFirst({
    where: { id: customerId, tenantId: ctx.tenantId },
  });
  if (!customer) return { success: false, error: "Customer not found" };

  if (customer.portalEnabled && customer.portalPasswordHash) {
    return {
      success: false,
      error: "Customer already has portal access. Use password reset instead.",
    };
  }

  const passwordHash = await hashPassword(temporaryPassword);

  await db.customer.update({
    where: { id: customerId },
    data: {
      portalEnabled: true,
      portalPasswordHash: passwordHash,
      forcePortalPasswordReset: true,
    },
  });

  await createAuditLog({
    userId: ctx.userId,
    action: "susu.customer_portal_created",
    entityType: "customer",
    entityId: customerId,
    details: {
      customerId: customer.customerId,
      customerName: customer.fullName,
      loginIdentifier,
    },
  });

  revalidatePath(`/susu/admin/customers/${customerId}`);
  revalidatePath("/susu/admin/customers");
  return { success: true };
}

export async function resetCustomerPassword(
  customerId: string,
  formData: FormData
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  const newPassword = formData.get("newPassword") as string;
  if (!newPassword || newPassword.length < 8) {
    return { success: false, error: "Password must be at least 8 characters" };
  }

  if (!(await assertTenantEntity("customer", customerId, ctx))) {
    return { success: false, error: "Customer not found" };
  }

  const customer = await db.customer.findFirst({
    where: { id: customerId, tenantId: ctx.tenantId },
  });
  if (!customer) return { success: false, error: "Customer not found" };

  const passwordHash = await hashPassword(newPassword);

  await db.customer.update({
    where: { id: customerId },
    data: {
      portalPasswordHash: passwordHash,
      forcePortalPasswordReset: true,
      tokenVersion: { increment: 1 },
    },
  });

  await createAuditLog({
    userId: ctx.userId,
    action: "susu.customer_portal_password_reset",
    entityType: "customer",
    entityId: customerId,
    details: {
      customerId: customer.customerId,
      customerName: customer.fullName,
      sessionsInvalidated: true,
    },
  });

  revalidatePath(`/susu/admin/customers/${customerId}`);
  return { success: true };
}

export async function toggleCustomerPortal(
  customerId: string,
  enabled: boolean
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();

  if (!(await assertTenantEntity("customer", customerId, ctx))) {
    return { success: false, error: "Customer not found" };
  }

  const customer = await db.customer.findFirst({
    where: { id: customerId, tenantId: ctx.tenantId },
  });
  if (!customer) return { success: false, error: "Customer not found" };

  if (!enabled && !customer.portalEnabled) {
    return { success: false, error: "Customer portal is already disabled" };
  }

  if (enabled && !customer.portalPasswordHash) {
    return {
      success: false,
      error: "Cannot enable portal without creating login credentials first",
    };
  }

  await db.customer.update({
    where: { id: customerId },
    data: { portalEnabled: enabled },
  });

  await createAuditLog({
    userId: ctx.userId,
    action: enabled
      ? "susu.customer_portal_enabled"
      : "susu.customer_portal_disabled",
    entityType: "customer",
    entityId: customerId,
    details: {
      customerId: customer.customerId,
      customerName: customer.fullName,
    },
  });

  revalidatePath(`/susu/admin/customers/${customerId}`);
  revalidatePath("/susu/admin/customers");
  return { success: true };
}

/** Re-exported for callers that need the resolved context type. */
export type { TenantContext };
