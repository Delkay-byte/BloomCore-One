"use server";

import { db } from "@/lib/db";
import {
  requireTenantWorker,
  requireTenantAdminMomo,
  getTenantContext,
  assertTenantEntity,
} from "@/lib/tenant";
import { dailyAccountSchema } from "@/lib/validations";
import { calculateReconciliation, resolveStoredDifference } from "@/lib/momo-reconciliation";
import { createAuditLog } from "@/lib/audit";
import { revalidatePath } from "next/cache";

export interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

/**
 * Map the persisted column names onto the approved business terms.
 *
 * totalCashIn       -> Customer deposit (Cash in)
 * totalCashOut      -> Cash out
 * totalAirtimeSold  -> Airtime sold
 * additionalCashReceived / additionalMomoFloat -> extra owner funding
 *
 * totalCashReceived, totalCashPaid and otherIncome are retired duplicate
 * inputs. They stay on historical rows so old records remain readable, but
 * new saves store zero and they never enter any calculation.
 */
function reconcileDailyAccount(data: {
  openingMomoFloat: number;
  openingCash: number;
  additionalCashReceived: number;
  additionalMomoFloat: number;
  totalCashIn: number;
  totalCashOut: number;
  totalAirtimeSold: number;
  commission: number;
  totalExpenses: number;
  closingMomoFloat: number;
  closingCash: number;
}) {
  const result = calculateReconciliation({
    openingMomoFloat: data.openingMomoFloat,
    openingCash: data.openingCash,
    additionalCashReceived: data.additionalCashReceived,
    additionalMomoFloat: data.additionalMomoFloat,
    customerDeposit: data.totalCashIn,
    cashOut: data.totalCashOut,
    airtimeSold: data.totalAirtimeSold,
    commission: data.commission,
    totalExpenses: data.totalExpenses,
    closingMomoFloat: data.closingMomoFloat,
    closingCash: data.closingCash,
  });
  return {
    difference: result.difference,
    differenceStatus: result.status,
    expectedClosing: result.expectedClosing,
    actualClosing: result.actualClosing,
  };
}

/** Legacy per-pocket columns are retained for old reports but no longer
 *  drive the corrected combined reconciliation. Store the combined value in
 *  both legacy columns so any older consumer that sums them still sees the
 *  true difference instead of a stale split. */
function legacyVarianceColumns(difference: number) {
  return {
    calculatedMomoVariance: 0,
    calculatedCashVariance: difference,
  };
}

/**
 * MoMo daily accounts are tenant-owned.
 *
 * Every function resolves the tenant from the session and scopes by tenantId.
 * The location a worker submits against must belong to their tenant AND be the
 * location they are assigned to.
 */

export async function createDailyAccount(
  locationId: string,
  businessDate: string
): Promise<ActionResponse> {
  const ctx = await requireTenantWorker();

  const dbUser = await db.user.findFirst({
    where: { id: ctx.userId, tenantId: ctx.tenantId },
    select: { locationId: true },
  });
  if (!dbUser || dbUser.locationId !== locationId) {
    return { success: false, error: "You are not assigned to this location" };
  }

  const location = await db.location.findFirst({
    where: { id: locationId, tenantId: ctx.tenantId },
  });
  if (!location || location.status !== "active") {
    return { success: false, error: "This location is not active" };
  }

  const dateObj = new Date(businessDate + "T00:00:00.000Z");
  const existing = await db.dailyAccount.findFirst({
    where: {
      locationId,
      businessDate: dateObj,
      tenantId: ctx.tenantId,
    },
  });

  if (existing) {
    return {
      success: false,
      error: "A daily account already exists for this location and date",
    };
  }

  const account = await db.dailyAccount.create({
    data: {
      tenantId: ctx.tenantId,
      locationId,
      workerId: ctx.userId,
      businessDate: dateObj,
      status: "draft",
    },
  });

  await createAuditLog({
    userId: ctx.userId,
    action: "daily_account.created",
    entityType: "daily_account",
    entityId: account.id,
    details: { locationId, businessDate },
  });

  revalidatePath("/worker/dashboard");
  return { success: true, data: account };
}

export async function saveDailyAccount(
  accountId: string,
  formData: FormData
): Promise<ActionResponse> {
  const ctx = await requireTenantWorker();

  const account = await db.dailyAccount.findFirst({
    where: { id: accountId, tenantId: ctx.tenantId },
  });
  if (!account) return { success: false, error: "Daily account not found" };
  if (account.workerId !== ctx.userId) {
    return {
      success: false,
      error: "You do not have permission to edit this account",
    };
  }
  if (account.status !== "draft") {
    return { success: false, error: "Only draft accounts can be edited" };
  }

  let expenses: { description: string; amount: number }[] = [];
  const expensesJson = formData.get("expenses") as string;
  if (expensesJson) {
    try {
      expenses = JSON.parse(expensesJson);
    } catch {
      return { success: false, error: "Invalid expense data" };
    }
  }

  const moneyField = (name: string): number => {
    const raw = formData.get(name);
    if (typeof raw !== "string" || raw.trim() === "") return Number.NaN;
    const value = Number(raw);
    return Number.isFinite(value) ? value : Number.NaN;
  };
  // Fields added after the original form shipped default to 0, so an older
  // client that does not post them is still accepted.
  const optionalMoneyField = (name: string): number => {
    const value = moneyField(name);
    return Number.isFinite(value) ? value : 0;
  };

  const parsed = {
    openingMomoFloat: moneyField("openingMomoFloat"),
    openingCash: moneyField("openingCash"),
    additionalCashReceived: optionalMoneyField("additionalCashReceived"),
    additionalMomoFloat: optionalMoneyField("additionalMomoFloat"),
    totalCashIn: moneyField("totalCashIn"),
    totalCashOut: moneyField("totalCashOut"),
    totalAirtimeSold: optionalMoneyField("totalAirtimeSold"),
    // Retired duplicate inputs. New drafts always store 0.
    totalCashReceived: 0,
    totalCashPaid: 0,
    commission: moneyField("commission"),
    otherIncome: 0,
    closingMomoFloat: moneyField("closingMomoFloat"),
    closingCash: moneyField("closingCash"),
  };
  const reconciliationNote =
    (formData.get("reconciliationNote") as string | null)?.trim() || null;

  const validated = dailyAccountSchema.safeParse({
    ...parsed,
    reconciliationNote: reconciliationNote ?? undefined,
    businessDate: account.businessDate.toISOString(),
    expenses,
  });

  if (!validated.success) {
    return { success: false, error: validated.error.issues[0].message };
  }

  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const reconciled = reconcileDailyAccount({
    ...parsed,
    totalExpenses,
  });
  const legacy = legacyVarianceColumns(reconciled.difference);
  let persisted = false;

  await db.$transaction(async (tx) => {
    // Conditional on the draft still being a draft. A concurrent submit wins
    // and this save reports a conflict instead of rewriting a submitted record.
    const updated = await tx.dailyAccount.updateMany({
      where: { id: accountId, tenantId: ctx.tenantId, status: "draft" },
      data: {
        openingMomoFloat: parsed.openingMomoFloat,
        openingCash: parsed.openingCash,
        additionalCashReceived: parsed.additionalCashReceived,
        additionalMomoFloat: parsed.additionalMomoFloat,
        totalCashIn: parsed.totalCashIn,
        totalCashOut: parsed.totalCashOut,
        totalAirtimeSold: parsed.totalAirtimeSold,
        totalCashReceived: 0,
        totalCashPaid: 0,
        commission: parsed.commission,
        otherIncome: 0,
        closingMomoFloat: parsed.closingMomoFloat,
        closingCash: parsed.closingCash,
        totalExpenses,
        calculatedDifference: reconciled.difference,
        differenceStatus: reconciled.differenceStatus,
        reconciliationNote: reconciliationNote,
        ...legacy,
      },
    });
    if (updated.count !== 1) return;
    persisted = true;

    // Expense replacement is scoped to this tenant's account.
    await tx.expense.deleteMany({
      where: { dailyAccountId: accountId, tenantId: ctx.tenantId },
    });
    if (expenses.length > 0) {
      await tx.expense.createMany({
        data: expenses.map((e) => ({
          tenantId: ctx.tenantId,
          dailyAccountId: accountId,
          description: e.description,
          amount: e.amount,
        })),
      });
    }
  });

  if (!persisted) {
    return {
      success: false,
      error: "This account has already been submitted. Reopen it to review the saved figures.",
    };
  }

  await createAuditLog({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    action: "daily_account.updated",
    entityType: "dailyAccount",
    entityId: accountId,
    details: {
      totalExpenses,
      difference: reconciled.difference,
      differenceStatus: reconciled.differenceStatus,
      expenseCount: expenses.length,
    },
  });

  revalidatePath(`/worker/daily/${accountId}`);
  return { success: true };
}

/**
 * Administrative correction of a submitted/reviewed daily account.
 *
 * The live row keeps its unique (location, date) identity and receives the
 * corrected figures. Before the change, an immutable DailyAccountRevision
 * snapshot preserves the exact prior financial values, expenses, status and
 * review metadata, plus the author, timestamp and mandatory reason. A
 * conditional update on revisionCount and a unique (account, version) index
 * make concurrent corrections fail cleanly instead of overwriting each other.
 *
 * This is a revision model, not a negative entry: no balance is adjusted by
 * appending a synthetic transaction.
 */
export async function correctDailyAccount(
  accountId: string,
  formData: FormData,
  reasonInput: string
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminMomo();

  const reason = reasonInput?.trim() ?? "";
  if (reason.length < 10 || reason.length > 500) {
    return {
      success: false,
      error: "Enter a correction reason of at least 10 characters.",
    };
  }

  const account = await db.dailyAccount.findFirst({
    where: { id: accountId, tenantId: ctx.tenantId },
    include: { expenses: true },
  });
  if (!account) return { success: false, error: "Daily account not found" };
  if (account.status !== "submitted" && account.status !== "reviewed") {
    return {
      success: false,
      error: "Only submitted or reviewed daily accounts can be corrected.",
    };
  }

  let expenses: { description: string; amount: number }[] = [];
  const expensesJson = formData.get("expenses") as string;
  if (expensesJson) {
    try {
      expenses = JSON.parse(expensesJson);
    } catch {
      return { success: false, error: "Invalid expense data" };
    }
  }

  const moneyField = (name: string): number => {
    const raw = formData.get(name);
    if (typeof raw !== "string" || raw.trim() === "") return Number.NaN;
    const value = Number(raw);
    return Number.isFinite(value) ? value : Number.NaN;
  };
  // Fields added after the original form shipped default to 0, so an older
  // client that does not post them is still accepted.
  const optionalMoneyField = (name: string): number => {
    const value = moneyField(name);
    return Number.isFinite(value) ? value : 0;
  };

  const parsed = {
    openingMomoFloat: moneyField("openingMomoFloat"),
    openingCash: moneyField("openingCash"),
    additionalCashReceived: optionalMoneyField("additionalCashReceived"),
    additionalMomoFloat: optionalMoneyField("additionalMomoFloat"),
    totalCashIn: moneyField("totalCashIn"),
    totalCashOut: moneyField("totalCashOut"),
    totalAirtimeSold: optionalMoneyField("totalAirtimeSold"),
    totalCashReceived: 0,
    totalCashPaid: 0,
    commission: moneyField("commission"),
    otherIncome: 0,
    closingMomoFloat: moneyField("closingMomoFloat"),
    closingCash: moneyField("closingCash"),
  };
  const reconciliationNote =
    (formData.get("reconciliationNote") as string | null)?.trim() || null;

  const validated = dailyAccountSchema.safeParse({
    ...parsed,
    reconciliationNote: reconciliationNote ?? undefined,
    businessDate: account.businessDate.toISOString(),
    expenses,
  });
  if (!validated.success) {
    return { success: false, error: validated.error.issues[0].message };
  }

  const totalExpenses = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const reconciled = reconcileDailyAccount({
    ...parsed,
    totalExpenses,
  });
  const legacy = legacyVarianceColumns(reconciled.difference);
  const version = account.revisionCount + 1;

  const snapshot = {
    status: account.status,
    submittedAt: account.submittedAt?.toISOString() ?? null,
    reviewedAt: account.reviewedAt?.toISOString() ?? null,
    reviewedBy: account.reviewedBy ?? null,
    reconciliationNote: account.reconciliationNote ?? null,
    openingMomoFloat: Number(account.openingMomoFloat),
    openingCash: Number(account.openingCash),
    additionalCashReceived: Number(account.additionalCashReceived),
    additionalMomoFloat: Number(account.additionalMomoFloat),
    totalCashIn: Number(account.totalCashIn),
    totalCashOut: Number(account.totalCashOut),
    totalAirtimeSold: Number(account.totalAirtimeSold),
    totalCashReceived: Number(account.totalCashReceived),
    totalCashPaid: Number(account.totalCashPaid),
    commission: Number(account.commission),
    otherIncome: Number(account.otherIncome),
    closingMomoFloat: Number(account.closingMomoFloat),
    closingCash: Number(account.closingCash),
    totalExpenses: Number(account.totalExpenses),
    calculatedDifference: Number(account.calculatedDifference),
    differenceStatus: account.differenceStatus,
    calculatedMomoVariance: Number(account.calculatedMomoVariance),
    calculatedCashVariance: Number(account.calculatedCashVariance),
    expenses: account.expenses.map((expense) => ({
      description: expense.description,
      amount: Number(expense.amount),
    })),
  };

  try {
    await db.$transaction(async (tx) => {
      await tx.dailyAccountRevision.create({
        data: {
          tenantId: ctx.tenantId,
          dailyAccountId: accountId,
          version,
          snapshot: JSON.stringify(snapshot),
          reason,
          correctedById: ctx.userId,
        },
      });

      const updated = await tx.dailyAccount.updateMany({
        where: {
          id: accountId,
          tenantId: ctx.tenantId,
          revisionCount: account.revisionCount,
        },
        data: {
          ...parsed,
          totalExpenses,
          calculatedDifference: reconciled.difference,
          differenceStatus: reconciled.differenceStatus,
          reconciliationNote,
          ...legacy,
          correctedAt: new Date(),
          correctedById: ctx.userId,
          correctionReason: reason,
          revisionCount: version,
        },
      });
      if (updated.count !== 1) throw new Error("CORRECTION_CONFLICT");

      await tx.expense.deleteMany({
        where: { dailyAccountId: accountId, tenantId: ctx.tenantId },
      });
      if (expenses.length > 0) {
        await tx.expense.createMany({
          data: expenses.map((expense) => ({
            tenantId: ctx.tenantId,
            dailyAccountId: accountId,
            description: expense.description,
            amount: expense.amount,
          })),
        });
      }
    });
  } catch (error) {
    if (
      (error instanceof Error && error.message === "CORRECTION_CONFLICT") ||
      (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "P2002")
    ) {
      return {
        success: false,
        error: "This account changed while you were correcting it. Reload and try again.",
      };
    }
    return { success: false, error: "The correction could not be saved." };
  }

  await createAuditLog({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    action: "daily_account.corrected",
    entityType: "dailyAccount",
    entityId: accountId,
    details: {
      reason,
      version,
      totalExpenses,
      difference: reconciled.difference,
      differenceStatus: reconciled.differenceStatus,
      previousSnapshotVersion: version,
    },
  });

  revalidatePath(`/worker/daily/${accountId}`);
  revalidatePath("/admin/history");
  revalidatePath("/admin/reports");
  revalidatePath("/admin/dashboard");
  return { success: true, data: { version } };
}

export async function submitDailyAccount(
  accountId: string
): Promise<ActionResponse> {
  const ctx = await requireTenantWorker();

  const account = await db.dailyAccount.findFirst({
    where: { id: accountId, tenantId: ctx.tenantId },
  });
  if (!account) return { success: false, error: "Daily account not found" };
  if (account.workerId !== ctx.userId) {
    return {
      success: false,
      error: "You do not have permission to submit this account",
    };
  }
  if (account.status !== "draft") {
    return { success: false, error: "Only draft accounts can be submitted" };
  }

  if (
    Number(account.openingMomoFloat) === 0 &&
    Number(account.openingCash) === 0 &&
    Number(account.additionalCashReceived) === 0 &&
    Number(account.additionalMomoFloat) === 0 &&
    Number(account.totalCashIn) === 0 &&
    Number(account.totalCashOut) === 0 &&
    Number(account.totalAirtimeSold) === 0 &&
    Number(account.closingMomoFloat) === 0 &&
    Number(account.closingCash) === 0
  ) {
    return {
      success: false,
      error: "Please fill in the account details before submitting",
    };
  }

  const reconciled = reconcileDailyAccount({
    openingMomoFloat: Number(account.openingMomoFloat),
    openingCash: Number(account.openingCash),
    additionalCashReceived: Number(account.additionalCashReceived),
    additionalMomoFloat: Number(account.additionalMomoFloat),
    totalCashIn: Number(account.totalCashIn),
    totalCashOut: Number(account.totalCashOut),
    totalAirtimeSold: Number(account.totalAirtimeSold),
    commission: Number(account.commission),
    totalExpenses: Number(account.totalExpenses),
    closingMomoFloat: Number(account.closingMomoFloat),
    closingCash: Number(account.closingCash),
  });

  if (
    reconciled.differenceStatus === "shortage" &&
    !account.reconciliationNote?.trim()
  ) {
    return {
      success: false,
      error:
        "This account has a shortage. Explain the shortage before submitting. Your cash and float figures stay unchanged.",
    };
  }

  const submitted = await db.dailyAccount.updateMany({
    where: { id: accountId, tenantId: ctx.tenantId, workerId: ctx.userId, status: "draft" },
    data: {
      status: "submitted",
      submittedAt: new Date(),
      calculatedDifference: reconciled.difference,
      differenceStatus: reconciled.differenceStatus,
      ...legacyVarianceColumns(reconciled.difference),
    },
  });
  if (submitted.count !== 1) {
    return {
      success: false,
      error: "This account has already been submitted. Reopen it to review the saved figures.",
    };
  }

  await createAuditLog({
    userId: ctx.userId,
    action: "daily_account.submitted",
    entityType: "daily_account",
    entityId: accountId,
    details: {
      businessDate: account.businessDate,
      locationId: account.locationId,
      difference: reconciled.difference,
      differenceStatus: reconciled.differenceStatus,
    },
  });

  revalidatePath("/worker/dashboard");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin/reports");
  return { success: true };
}

export async function reviewDailyAccount(
  accountId: string
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminMomo();

  const account = await db.dailyAccount.findFirst({
    where: { id: accountId, tenantId: ctx.tenantId },
  });
  if (!account) return { success: false, error: "Daily account not found" };
  if (account.status !== "submitted") {
    return { success: false, error: "Only submitted accounts can be reviewed" };
  }

  await db.dailyAccount.update({
    where: { id: accountId },
    data: { status: "reviewed", reviewedAt: new Date(), reviewedBy: ctx.userId },
  });

  await createAuditLog({
    userId: ctx.userId,
    action: "daily_account.reviewed",
    entityType: "daily_account",
    entityId: accountId,
  });

  revalidatePath("/admin/reports");
  revalidatePath(`/admin/reports/${accountId}`);
  revalidatePath("/admin/dashboard");
  return { success: true };
}

export async function getDailyAccounts(params: {
  page?: number;
  limit?: number;
  locationId?: string;
  workerId?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  const ctx = await requireTenantAdminMomo();

  const page = params.page || 1;
  const limit = params.limit || 20;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (params.locationId) where.locationId = params.locationId;
  if (params.workerId) where.workerId = params.workerId;
  if (params.status) where.status = params.status;

  if (params.dateFrom || params.dateTo) {
    where.businessDate = {};
    const bdate = where.businessDate as Record<string, Date>;
    if (params.dateFrom)
      bdate.gte = new Date(params.dateFrom + "T00:00:00.000Z");
    if (params.dateTo) bdate.lte = new Date(params.dateTo + "T23:59:59.999Z");
  }

  const [accounts, total] = await Promise.all([
    db.dailyAccount.findMany({
      where,
      include: {
        location: { select: { id: true, name: true, code: true } },
        worker: { select: { id: true, fullName: true, email: true } },
        expenses: true,
      },
      orderBy: { businessDate: "desc" },
      skip,
      take: limit,
    }),
    db.dailyAccount.count({ where }),
  ]);

  return {
    accounts,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getDailyAccountById(id: string) {
  const ctx =
    (await getTenantContext("momo", "momo")) ??
    (await getTenantContext("admin", "momo"));
  if (!ctx) return null;

  const account = await db.dailyAccount.findFirst({
    where: { id, tenantId: ctx.tenantId },
    include: {
      location: true,
      worker: {
        select: { id: true, fullName: true, email: true, phone: true },
      },
      expenses: true,
    },
  });

  if (!account) return null;

  // A worker may only read their own account at their own location.
  if (ctx.role !== "admin") {
    const dbUser = await db.user.findFirst({
      where: { id: ctx.userId, tenantId: ctx.tenantId },
      select: { locationId: true },
    });
    if (
      account.workerId !== ctx.userId ||
      dbUser?.locationId !== account.locationId
    ) {
      return null;
    }
  }

  return account;
}

export async function getWorkerDailyAccounts(workerId?: string) {
  const ctx =
    (await getTenantContext("momo", "momo")) ??
    (await getTenantContext("admin", "momo"));
  if (!ctx) return [];

  const targetWorkerId =
    ctx.role === "admin" && workerId ? workerId : ctx.userId;

  // An admin asking for another worker must stay inside the tenant.
  if (ctx.role === "admin" && workerId && workerId !== ctx.userId) {
    if (!(await assertTenantEntity("user", workerId, ctx))) return [];
  }

  return db.dailyAccount.findMany({
    where: { workerId: targetWorkerId, tenantId: ctx.tenantId },
    include: {
      location: { select: { id: true, name: true, code: true } },
      worker: { select: { id: true, fullName: true } },
    },
    orderBy: { businessDate: "desc" },
    take: 30,
  });
}

export async function getAdminDashboardStats() {
  const ctx = await requireTenantAdminMomo();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [
    totalActiveLocations,
    totalActiveWorkers,
    todayAccounts,
    allLocations,
  ] = await Promise.all([
    db.location.count({
      where: { status: "active", tenantId: ctx.tenantId },
    }),
    db.user.count({
      where: { role: "worker", status: "active", tenantId: ctx.tenantId },
    }),
    db.dailyAccount.findMany({
      where: {
        tenantId: ctx.tenantId,
        businessDate: {
          gte: today,
          lt: new Date(today.getTime() + 24 * 60 * 60 * 1000),
        },
      },
      include: {
        location: { select: { name: true, code: true } },
        worker: { select: { fullName: true } },
      },
    }),
    db.location.findMany({
      where: { status: "active", tenantId: ctx.tenantId },
      include: {
        users: {
          where: { role: "worker", status: "active", tenantId: ctx.tenantId },
          select: { id: true, fullName: true },
        },
      },
      orderBy: { name: "asc" },
    }),
  ]);

  const submitted = todayAccounts.filter(
    (a) => a.status === "submitted" || a.status === "reviewed"
  );
  const totalCashPosition = submitted.reduce(
    (sum, a) => sum + Number(a.closingCash) + Number(a.closingMomoFloat),
    0
  );
  const totalFloat = submitted.reduce(
    (sum, a) => sum + Number(a.closingMomoFloat),
    0
  );
  const totalExpensesToday = submitted.reduce(
    (sum, a) => sum + Number(a.totalExpenses),
    0
  );
  // Approved business terms: Customer deposit (Cash in), Cash out, Airtime sold.
  const totalCustomerDeposits = submitted.reduce(
    (sum, a) => sum + Number(a.totalCashIn),
    0
  );
  const totalCashOut = submitted.reduce(
    (sum, a) => sum + Number(a.totalCashOut),
    0
  );
  const totalAirtimeSold = submitted.reduce(
    (sum, a) => sum + Number(a.totalAirtimeSold),
    0
  );
  const totalAdditionalFunding = submitted.reduce(
    (sum, a) =>
      sum + Number(a.additionalCashReceived) + Number(a.additionalMomoFloat),
    0
  );
  const differenceOf = (a: (typeof submitted)[number]) =>
    resolveStoredDifference(a).difference;
  const balanced = submitted.filter((a) => differenceOf(a) === 0);
  const withDiscrepancy = submitted.filter((a) => differenceOf(a) < 0);
  const positiveDifference = submitted.filter((a) => differenceOf(a) > 0);

  const locationStatus = allLocations.map((loc) => {
    const account = todayAccounts.find((a) => a.locationId === loc.id);
    return {
      location: { name: loc.name, code: loc.code, id: loc.id },
      worker: loc.users[0]?.fullName || "Unassigned",
      status: account
        ? account.status === "submitted" || account.status === "reviewed"
          ? "Submitted"
          : "Draft"
        : "Pending",
      difference: account ? differenceOf(account) : null,
    };
  });

  return {
    totalActiveLocations,
    totalActiveWorkers,
    submittedToday: submitted.length,
    pendingToday: allLocations.length - submitted.length,
    totalLocations: allLocations.length,
    balancedReports: balanced.length,
    discrepancyReports: withDiscrepancy.length,
    positiveDifferenceReports: positiveDifference.length,
    totalCashPosition,
    totalFloat,
    totalCustomerDeposits,
    totalCashOut,
    totalAirtimeSold,
    totalAdditionalFunding,
    totalExpenses: totalExpensesToday,
    locationStatus,
  };
}

// ---------------------------------------------------------------------------
// Administrative correction screen
// ---------------------------------------------------------------------------

export interface DailyAccountRevisionView {
  id: string;
  version: number;
  reason: string;
  correctedById: string;
  correctedByName: string | null;
  createdAt: string;
  snapshot: {
    status: string;
    openingMomoFloat: number;
    openingCash: number;
    additionalCashReceived: number;
    additionalMomoFloat: number;
    totalCashIn: number;
    totalCashOut: number;
    totalAirtimeSold: number;
    totalCashReceived: number;
    totalCashPaid: number;
    commission: number;
    otherIncome: number;
    closingMomoFloat: number;
    closingCash: number;
    totalExpenses: number;
    calculatedDifference: number;
    differenceStatus: string;
    calculatedMomoVariance: number;
    calculatedCashVariance: number;
    reconciliationNote: string | null;
    expenses: Array<{ description: string; amount: number }>;
  };
}

export interface DailyAccountCorrectionView {
  id: string;
  status: string;
  businessDate: string;
  location: { id: string; name: string; code: string };
  worker: { id: string; fullName: string };
  values: {
    openingMomoFloat: number;
    openingCash: number;
    additionalCashReceived: number;
    additionalMomoFloat: number;
    totalCashIn: number;
    totalCashOut: number;
    totalAirtimeSold: number;
    totalCashReceived: number;
    totalCashPaid: number;
    commission: number;
    otherIncome: number;
    closingMomoFloat: number;
    closingCash: number;
    totalExpenses: number;
    calculatedDifference: number;
    differenceStatus: string;
    calculatedMomoVariance: number;
    calculatedCashVariance: number;
  };
  expenses: Array<{ description: string; amount: number }>;
  reconciliationNote: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  correctedAt: string | null;
  correctionReason: string | null;
  revisionCount: number;
  revisions: DailyAccountRevisionView[];
}

/**
 * Read model for the dedicated correction screen. Only a tenant administrator
 * with the MoMo module may load it; the tenant is resolved from the session,
 * never from the browser. Revision history is returned read-only and is never
 * edited or deleted by this screen.
 */
export async function getDailyAccountCorrectionData(
  accountId: string
): Promise<DailyAccountCorrectionView | null> {
  const ctx = await requireTenantAdminMomo();

  const account = await db.dailyAccount.findFirst({
    where: { id: accountId, tenantId: ctx.tenantId },
    include: {
      location: { select: { id: true, name: true, code: true } },
      worker: { select: { id: true, fullName: true } },
      expenses: { select: { description: true, amount: true } },
      revisions: { orderBy: { version: "desc" } },
    },
  });
  if (!account) return null;

  const correctorIds = Array.from(
    new Set(account.revisions.map((revision) => revision.correctedById))
  );
  const correctors =
    correctorIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: correctorIds }, tenantId: ctx.tenantId },
          select: { id: true, fullName: true },
        })
      : [];
  const nameById = new Map(correctors.map((row) => [row.id, row.fullName]));

  const revisions: DailyAccountRevisionView[] = account.revisions.map((revision) => {
    let snapshot: DailyAccountRevisionView["snapshot"];
    try {
      const parsed = JSON.parse(revision.snapshot) as Record<string, unknown>;
      snapshot = {
        status: String(parsed.status ?? ""),
        openingMomoFloat: Number(parsed.openingMomoFloat ?? 0),
        openingCash: Number(parsed.openingCash ?? 0),
        additionalCashReceived: Number(parsed.additionalCashReceived ?? 0),
        additionalMomoFloat: Number(parsed.additionalMomoFloat ?? 0),
        totalCashIn: Number(parsed.totalCashIn ?? 0),
        totalCashOut: Number(parsed.totalCashOut ?? 0),
        totalAirtimeSold: Number(parsed.totalAirtimeSold ?? 0),
        totalCashReceived: Number(parsed.totalCashReceived ?? 0),
        totalCashPaid: Number(parsed.totalCashPaid ?? 0),
        commission: Number(parsed.commission ?? 0),
        otherIncome: Number(parsed.otherIncome ?? 0),
        closingMomoFloat: Number(parsed.closingMomoFloat ?? 0),
        closingCash: Number(parsed.closingCash ?? 0),
        totalExpenses: Number(parsed.totalExpenses ?? 0),
        calculatedDifference: Number(parsed.calculatedDifference ?? 0),
        differenceStatus: String(parsed.differenceStatus ?? ""),
        calculatedMomoVariance: Number(parsed.calculatedMomoVariance ?? 0),
        calculatedCashVariance: Number(parsed.calculatedCashVariance ?? 0),
        reconciliationNote:
          typeof parsed.reconciliationNote === "string"
            ? parsed.reconciliationNote
            : null,
        expenses: Array.isArray(parsed.expenses)
          ? (parsed.expenses as Array<{ description?: unknown; amount?: unknown }>).map(
              (expense) => ({
                description: String(expense.description ?? ""),
                amount: Number(expense.amount ?? 0),
              })
            )
          : [],
      };
    } catch {
      // A corrupt snapshot must not hide the correction history. Render a
      // clearly-empty snapshot instead of throwing the whole screen away.
      snapshot = {
        status: "",
        openingMomoFloat: 0,
        openingCash: 0,
        additionalCashReceived: 0,
        additionalMomoFloat: 0,
        totalCashIn: 0,
        totalCashOut: 0,
        totalAirtimeSold: 0,
        totalCashReceived: 0,
        totalCashPaid: 0,
        commission: 0,
        otherIncome: 0,
        closingMomoFloat: 0,
        closingCash: 0,
        totalExpenses: 0,
        calculatedDifference: 0,
        differenceStatus: "",
        calculatedMomoVariance: 0,
        calculatedCashVariance: 0,
        reconciliationNote: null,
        expenses: [],
      };
    }
    return {
      id: revision.id,
      version: revision.version,
      reason: revision.reason,
      correctedById: revision.correctedById,
      correctedByName: nameById.get(revision.correctedById) ?? null,
      createdAt: revision.createdAt.toISOString(),
      snapshot,
    };
  });

  return {
    id: account.id,
    status: account.status,
    businessDate: account.businessDate.toISOString(),
    location: account.location,
    worker: account.worker,
    values: {
      openingMomoFloat: Number(account.openingMomoFloat),
      openingCash: Number(account.openingCash),
      additionalCashReceived: Number(account.additionalCashReceived),
      additionalMomoFloat: Number(account.additionalMomoFloat),
      totalCashIn: Number(account.totalCashIn),
      totalCashOut: Number(account.totalCashOut),
      totalAirtimeSold: Number(account.totalAirtimeSold),
      totalCashReceived: Number(account.totalCashReceived),
      totalCashPaid: Number(account.totalCashPaid),
      commission: Number(account.commission),
      otherIncome: Number(account.otherIncome),
      closingMomoFloat: Number(account.closingMomoFloat),
      closingCash: Number(account.closingCash),
      totalExpenses: Number(account.totalExpenses),
      calculatedDifference: Number(account.calculatedDifference),
      differenceStatus: account.differenceStatus || "balanced",
      calculatedMomoVariance: Number(account.calculatedMomoVariance),
      calculatedCashVariance: Number(account.calculatedCashVariance),
    },
    expenses: account.expenses.map((expense) => ({
      description: expense.description,
      amount: Number(expense.amount),
    })),
    reconciliationNote: account.reconciliationNote,
    submittedAt: account.submittedAt?.toISOString() ?? null,
    reviewedAt: account.reviewedAt?.toISOString() ?? null,
    correctedAt: account.correctedAt?.toISOString() ?? null,
    correctionReason: account.correctionReason,
    revisionCount: account.revisionCount,
    revisions,
  };
}
