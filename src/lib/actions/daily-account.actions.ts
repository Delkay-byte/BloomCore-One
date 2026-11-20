"use server";

import { db } from "@/lib/db";
import { getAdminSession, getMomoSession } from "@/lib/auth";
import { claimStepUpGrant, StepUpDeniedError } from "@/lib/security/step-up";
import {
  listNotifications,
  unreadNotificationCount,
} from "@/lib/notifications/notifications";
import { stepUpSessionBinding } from "@/lib/security/step-up";
import {
  requireTenantWorker,
  requireTenantAdminMomo,
  getTenantContext,
  assertTenantEntity,
} from "@/lib/tenant";
import { dailyAccountSchema } from "@/lib/validations";
import {
  ACTOR_PROOF_REQUIRED,
  SHIFT_REQUIRED_REFUSAL,
  businessDayBounds,
} from "@/lib/tenant-policy";
import { readTenantPolicy } from "@/lib/actions/tenant-policy.actions";
import {
  hasCurrencyPrecision,
  parseExpenseLines,
  readExpenseFormValue,
} from "@/lib/expense-lines";
import {
  calculateReconciliation,
  encodeReconciliationStatus,
  resolveStoredDifference,
} from "@/lib/momo-reconciliation";
import { createAuditLogTx } from "@/lib/audit";
import {
  ledgerSummaryForAccount,
  latestPriorDailyAccount,
  resolveOpeningCarryForward,
} from "@/lib/momo-ledger-service";
import { openingDifferenceIsMaterial } from "@/lib/momo-ledger";
import { revalidatePath } from "next/cache";

export interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

/**
 * Approved simplified daily closing.
 *
 * Only opening cash/E-cash, closing cash/E-cash, expenses, commission and
 * debts collected drive the reconciliation. Customer deposits, cash out and
 * airtime move money between the two pockets, so they are neither asked for
 * nor counted. Legacy columns stay on historical rows.
 */
function reconcileDailyAccount(data: {
  openingMomoFloat: number;
  openingCash: number;
  debtsCollected: number;
  commission: number;
  otherIncome?: number;
  totalExpenses: number;
  closingMomoFloat: number;
  closingCash: number;
}) {
  const result = calculateReconciliation({
    openingMomoFloat: data.openingMomoFloat,
    openingCash: data.openingCash,
    debtsCollected: data.debtsCollected,
    commission: data.commission,
    otherIncome: data.otherIncome ?? 0,
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

  // Opening roll-forward. Only a reviewed, balanced previous close is carried;
  // anything else stays manual and must be explained when it is entered.
  const carry = await resolveOpeningCarryForward({
    tenantId: ctx.tenantId,
    locationId,
    businessDate: dateObj,
  });

  const account = await db.$transaction(async (tx) => {
    const created = await tx.dailyAccount.create({
      data: {
        tenantId: ctx.tenantId,
        locationId,
        workerId: ctx.userId,
        businessDate: dateObj,
        status: "draft",
        openingCash: carry.openingCash ?? 0,
        openingMomoFloat: carry.openingMomoFloat ?? 0,
        openingBalanceSource: carry.available ? "carried" : "manual",
        carriedFromAccountId: carry.sourceAccountId,
      },
    });

    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "daily_account.created",
      entityType: "daily_account",
      entityId: created.id,
      details: {
        locationId,
        businessDate,
        openingBalanceSource: created.openingBalanceSource,
        carriedFromAccountId: carry.sourceAccountId,
        carryReason: carry.reason,
      },
    });

    return created;
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

  const expenseResult = readExpenseFormValue(formData.get("expenses"));
  if (!expenseResult.ok) {
    return { success: false, error: expenseResult.error };
  }
  const expenses = expenseResult.lines;

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
  // Airtime is optional. A blank field means zero. A malformed value stays NaN
  // so schema validation rejects it instead of silently recording zero.
  const optionalMoneyFieldStrict = (name: string): number => {
    const raw = formData.get(name);
    if (typeof raw !== "string" || raw.trim() === "") return 0;
    return moneyField(name);
  };

  const parsed = {
    openingMomoFloat: moneyField("openingMomoFloat"),
    openingCash: moneyField("openingCash"),
    // Legacy columns remain writable as zero for backward compatibility.
    // They never enter the simplified formula or the current form.
    additionalCashReceived: 0,
    additionalMomoFloat: 0,
    totalCashIn: 0,
    totalCashOut: 0,
    totalAirtimeSold: optionalMoneyFieldStrict("totalAirtimeSold"),
    totalCashReceived: 0,
    totalCashPaid: 0,
    commission: moneyField("commission"),
    debtsCollected: optionalMoneyField("debtsCollected"),
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

  // In ledger mode the individual transaction rows are the source of truth for
  // commission, debts, other income, airtime and expenses. The manual fields in
  // the same form are ignored so the same money cannot be counted twice.
  const isLedger = account.ledgerMode === "ledger";
  const ledgerSummary = isLedger
    ? await ledgerSummaryForAccount(account.id, ctx.tenantId)
    : null;
  const effective = ledgerSummary
    ? {
        commission: ledgerSummary.commission,
        debtsCollected: ledgerSummary.debtsCollected,
        otherIncome: ledgerSummary.otherIncome,
        airtimeSold: ledgerSummary.airtimeSold,
        totalExpenses: ledgerSummary.expenses,
      }
    : {
        commission: parsed.commission,
        debtsCollected: parsed.debtsCollected,
        otherIncome: 0,
        airtimeSold: parsed.totalAirtimeSold,
        totalExpenses: expenseResult.total,
      };
  const effectiveExpenses = ledgerSummary ? [] : expenses;
  const totalExpenses = effective.totalExpenses;

  // Opening-balance continuity. A material difference from the latest known
  // close has to be explained; the source is recorded so a reader can tell an
  // automatically carried balance from a manual one.
  const prior = await latestPriorDailyAccount({
    tenantId: ctx.tenantId,
    locationId: account.locationId,
    businessDate: account.businessDate,
    excludeAccountId: account.id,
  });
  const openingReasonRaw =
    (formData.get("openingAdjustmentReason") as string | null)?.trim() ?? "";
  const materialOpeningDifference = prior
    ? openingDifferenceIsMaterial(
        { cash: parsed.openingCash, float: parsed.openingMomoFloat },
        { cash: prior.closingCash, float: prior.closingMomoFloat }
      )
    : false;
  if (materialOpeningDifference && openingReasonRaw.length < 10) {
    return {
      success: false,
      error:
        "This opening balance differs from the last recorded close. Explain the difference in at least 10 characters.",
    };
  }
  if (openingReasonRaw.length > 500) {
    return {
      success: false,
      error: "The opening balance explanation must be 500 characters or fewer.",
    };
  }
  const openingBalanceSource = materialOpeningDifference
    ? "manual_adjusted"
    : account.carriedFromAccountId && prior?.accountId === account.carriedFromAccountId
      ? "carried"
      : "manual";
  const openingAdjustmentReason = materialOpeningDifference ? openingReasonRaw : null;

  const reconciled = reconcileDailyAccount({
    openingMomoFloat: parsed.openingMomoFloat,
    openingCash: parsed.openingCash,
    debtsCollected: effective.debtsCollected,
    commission: effective.commission,
    otherIncome: effective.otherIncome,
    totalExpenses,
    closingMomoFloat: parsed.closingMomoFloat,
    closingCash: parsed.closingCash,
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
        totalAirtimeSold: effective.airtimeSold,
        totalCashReceived: 0,
        totalCashPaid: 0,
        commission: effective.commission,
        debtsCollected: effective.debtsCollected,
        otherIncome: effective.otherIncome,
        closingMomoFloat: parsed.closingMomoFloat,
        closingCash: parsed.closingCash,
        totalExpenses,
        openingBalanceSource,
        openingAdjustmentReason,
        calculatedDifference: reconciled.difference,
        differenceStatus: encodeReconciliationStatus(reconciled.differenceStatus),
        reconciliationNote: reconciliationNote,
        ...legacy,
      },
    });
    if (updated.count !== 1) return;
    persisted = true;

    // Expense replacement is scoped to this tenant's account. A ledger-mode
    // day has no Expense rows at all: its expenses live in the transaction
    // ledger so the same cost is never present in two places.
    await tx.expense.deleteMany({
      where: { dailyAccountId: accountId, tenantId: ctx.tenantId },
    });
    if (effectiveExpenses.length > 0) {
      await tx.expense.createMany({
        data: effectiveExpenses.map((e) => ({
          tenantId: ctx.tenantId,
          dailyAccountId: accountId,
          description: e.description,
          amount: e.amount,
        })),
      });
    }

    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "daily_account.updated",
      entityType: "dailyAccount",
      entityId: accountId,
      details: {
        totalExpenses,
        airtimeSold: effective.airtimeSold,
        commission: effective.commission,
        debtsCollected: effective.debtsCollected,
        otherIncome: effective.otherIncome,
        difference: reconciled.difference,
        differenceStatus: reconciled.differenceStatus,
        expenseCount: effectiveExpenses.length,
        ledgerMode: account.ledgerMode,
        openingBalanceSource,
        openingAdjusted: materialOpeningDifference,
      },
    });
  });

  if (!persisted) {
    return {
      success: false,
      error: "This account has already been submitted. Reopen it to review the saved figures.",
    };
  }

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
  reasonInput: string,
  stepUpToken?: string
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const session = await getAdminSession();


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
  if (account.ledgerMode === "ledger") {
    return {
      success: false,
      error:
        "This day was closed from the transaction ledger. Correct or reverse the individual transactions instead; the daily totals then re-derive without overwriting posting history.",
    };
  }

  const expenseResult = readExpenseFormValue(formData.get("expenses"));
  if (!expenseResult.ok) {
    return { success: false, error: expenseResult.error };
  }
  const expenses = expenseResult.lines;

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
  // Airtime is optional; malformed input must fail validation, not become zero.
  const optionalMoneyFieldStrict = (name: string): number => {
    const raw = formData.get(name);
    if (typeof raw !== "string" || raw.trim() === "") return 0;
    return moneyField(name);
  };

  const parsed = {
    openingMomoFloat: moneyField("openingMomoFloat"),
    openingCash: moneyField("openingCash"),
    // Legacy columns remained for historical compatibility; corrections use
    // the same simplified fields as the current daily closing form.
    additionalCashReceived: 0,
    additionalMomoFloat: 0,
    totalCashIn: 0,
    totalCashOut: 0,
    totalAirtimeSold: optionalMoneyFieldStrict("totalAirtimeSold"),
    totalCashReceived: 0,
    totalCashPaid: 0,
    commission: moneyField("commission"),
    debtsCollected: optionalMoneyField("debtsCollected"),
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

  // The corrected itemised rows are authoritative; the client total is ignored.
  const totalExpenses = expenseResult.total;
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
    debtsCollected: Number(account.debtsCollected),
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
      const grant = await claimStepUpGrant(tx, {
        token: stepUpToken,
        subjectType: "user",
        subjectId: ctx.userId,
        sessionId: stepUpSessionBinding(session, ctx.userId),
        purpose: "finance.daily_account.correct",
        targetType: "dailyAccount",
        targetId: accountId,
        context: { version: account.revisionCount },
      });
      if (!grant.ok) throw new StepUpDeniedError(grant.error);

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
          differenceStatus: encodeReconciliationStatus(reconciled.differenceStatus),
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

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "daily_account.corrected",
        entityType: "dailyAccount",
        entityId: accountId,
        details: {
          reason,
          version,
          totalExpenses,
          airtimeSold: parsed.totalAirtimeSold,
          difference: reconciled.difference,
          differenceStatus: reconciled.differenceStatus,
          previousSnapshotVersion: version,
        },
      });
    });
  } catch (error) {
    if (error instanceof StepUpDeniedError) {
      return { success: false, error: error.message };
    }
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

  revalidatePath(`/worker/daily/${accountId}`);
  revalidatePath("/admin/history");
  revalidatePath("/admin/reports");
  revalidatePath("/admin/dashboard");
  return { success: true, data: { version } };
}

export async function submitDailyAccount(
  accountId: string,
  actorProofToken?: string
): Promise<ActionResponse> {
  const ctx = await requireTenantWorker();

  const account = await db.dailyAccount.findFirst({
    where: { id: accountId, tenantId: ctx.tenantId },
    include: { expenses: true },
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

  // The day has one financial source of truth.
  //   ledger    — commission, debts, other income, airtime and expenses are
  //               re-derived from the effective transaction rows now. Stored
  //               aggregates are outputs, never trusted inputs.
  //   aggregate — the itemised expense rows are re-totalled and the manual
  //               commission/debts figures are used exactly as before.
  let totalExpenses: number;
  let commission: number;
  let debtsCollected: number;
  let otherIncome: number;
  let airtimeSold: number;
  let ledgerEntryCount = 0;

  if (account.ledgerMode === "ledger") {
    const summary = await ledgerSummaryForAccount(account.id, ctx.tenantId);
    ledgerEntryCount = summary.entryCount;
    totalExpenses = summary.expenses;
    commission = summary.commission;
    debtsCollected = summary.debtsCollected;
    otherIncome = summary.otherIncome;
    airtimeSold = summary.airtimeSold;
  } else {
    const validatedExpenses = parseExpenseLines(
      account.expenses.map((expense) => ({
        description: expense.description,
        amount: Number(expense.amount),
      }))
    );
    if (!validatedExpenses.ok) {
      return { success: false, error: validatedExpenses.error };
    }
    totalExpenses = validatedExpenses.total;
    commission = Number(account.commission);
    debtsCollected = Number(account.debtsCollected);
    otherIncome = Number(account.otherIncome ?? 0);
    airtimeSold = Number(account.totalAirtimeSold);
  }

  if (
    Number(account.openingMomoFloat) === 0 &&
    Number(account.openingCash) === 0 &&
    Number(account.closingMomoFloat) === 0 &&
    Number(account.closingCash) === 0 &&
    debtsCollected === 0 &&
    commission === 0 &&
    otherIncome === 0 &&
    airtimeSold === 0 &&
    totalExpenses === 0
  ) {
    return {
      success: false,
      error: "Please fill in the account details before submitting",
    };
  }

  // A2: the business decides whether a day can close without a shift, and
  // whether a shared device must prove the actor again. Both rules are checked
  // here, on the server, immediately before the state change.
  const policy = await readTenantPolicy(ctx.tenantId);
  if (policy.shiftsRequired) {
    const day = businessDayBounds(account.businessDate);
    const closedShift = await db.shift.findFirst({
      where: {
        tenantId: ctx.tenantId,
        locationId: account.locationId,
        assignedUserId: account.workerId,
        businessDate: { gte: day.start, lt: day.end },
        status: "closed",
      },
      select: { id: true },
    });
    if (!closedShift) {
      return { success: false, error: SHIFT_REQUIRED_REFUSAL };
    }
  }

  const reconciled = reconcileDailyAccount({
    openingMomoFloat: Number(account.openingMomoFloat),
    openingCash: Number(account.openingCash),
    debtsCollected,
    commission,
    otherIncome,
    totalExpenses,
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

  const actorSession = await getMomoSession();
  let submitted: { count: number };
  try {
    submitted = await db.$transaction(async (tx) => {
      if (policy.actorProofForSensitiveCounts) {
        const grant = await claimStepUpGrant(tx, {
          token: actorProofToken,
          subjectType: "user",
          subjectId: ctx.userId,
          sessionId: stepUpSessionBinding(actorSession, ctx.userId),
          purpose: "finance.daily_close.submit",
          targetType: "dailyAccount",
          targetId: accountId,
          context: {},
        });
        if (!grant.ok) throw new StepUpDeniedError(grant.error);
      }
      const updated = await tx.dailyAccount.updateMany({
        where: {
          id: accountId,
          tenantId: ctx.tenantId,
          workerId: ctx.userId,
          status: "draft",
        },
        data: {
          status: "submitted",
          submittedAt: new Date(),
          totalExpenses,
          commission,
          debtsCollected,
          otherIncome,
          totalAirtimeSold: airtimeSold,
          calculatedDifference: reconciled.difference,
          differenceStatus: encodeReconciliationStatus(reconciled.differenceStatus),
          ...legacyVarianceColumns(reconciled.difference),
        },
      });
      if (updated.count === 1) {
        await createAuditLogTx(tx, {
          userId: ctx.userId,
          tenantId: ctx.tenantId,
          action: "daily_account.submitted",
          entityType: "daily_account",
          entityId: accountId,
          details: {
            businessDate: account.businessDate,
            locationId: account.locationId,
            difference: reconciled.difference,
            differenceStatus: reconciled.differenceStatus,
            ledgerMode: account.ledgerMode,
            ledgerEntryCount,
            commission,
            debtsCollected,
            otherIncome,
            totalExpenses,
          },
        });
      }
      return updated;
    });
  } catch (error) {
    if (error instanceof StepUpDeniedError) {
      return { success: false, error: ACTOR_PROOF_REQUIRED };
    }
    return {
      success: false,
      error:
        "The daily account could not be submitted. No changes were saved. Please try again.",
    };
  }
  if (submitted.count !== 1) {
    return {
      success: false,
      error: "This account has already been submitted. Reopen it to review the saved figures.",
    };
  }

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

  const reviewed = await db.$transaction(async (tx) => {
    const updated = await tx.dailyAccount.updateMany({
      where: { id: accountId, tenantId: ctx.tenantId, status: "submitted" },
      data: { status: "reviewed", reviewedAt: new Date(), reviewedBy: ctx.userId },
    });
    if (updated.count === 1) {
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "daily_account.reviewed",
        entityType: "daily_account",
        entityId: accountId,
      });
    }
    return updated;
  });
  if (reviewed.count !== 1) {
    return {
      success: false,
      error: "This account changed while you were reviewing it. Reload and try again.",
    };
  }

  revalidatePath("/admin/reports");
  revalidatePath(`/admin/reports/${accountId}`);
  revalidatePath("/admin/dashboard");
  return { success: true };
}

/**
 * Confirm the money physically received from the agent.
 *
 * This is deliberately separate from `reviewDailyAccount`. Approving the
 * accounting review does not prove that cash was handed over. The actual amount
 * and any discrepancy are preserved; a mismatch always requires an explanation
 * and is never silently treated as balanced.
 *
 * Expected Money to Hand Over stays:
 *   opening total + commission + debts collected - total expenses
 * Airtime Sold is operational information and never enters this calculation.
 */
export async function confirmDailyHandover(
  accountId: string,
  formData: FormData
): Promise<ActionResponse> {
  const ctx = await requireTenantAdminMomo();

  const account = await db.dailyAccount.findFirst({
    where: { id: accountId, tenantId: ctx.tenantId },
    include: { expenses: true },
  });
  if (!account) return { success: false, error: "Daily account not found" };
  if (account.status !== "submitted" && account.status !== "reviewed") {
    return {
      success: false,
      error: "Only a submitted daily account can have its handover confirmed.",
    };
  }
  if (account.handoverConfirmedAt) {
    return {
      success: false,
      error:
        "Money received has already been confirmed for this account. The existing confirmation is preserved.",
    };
  }

  const raw = formData.get("actualAmountReceived");
  if (typeof raw !== "string" || raw.trim() === "") {
    return { success: false, error: "Enter the actual amount received." };
  }
  const actual = Number(raw);
  if (!Number.isFinite(actual) || actual < 0) {
    return { success: false, error: "Enter a valid amount received." };
  }
  if (actual > 999999.99) {
    return { success: false, error: "The amount received is too large." };
  }
  if (!hasCurrencyPrecision(actual)) {
    return {
      success: false,
      error: "The amount received must use no more than two decimal places.",
    };
  }

  const totalExpenses = Number(account.totalExpenses);
  const expected = reconcileDailyAccount({
    openingMomoFloat: Number(account.openingMomoFloat),
    openingCash: Number(account.openingCash),
    debtsCollected: Number(account.debtsCollected),
    commission: Number(account.commission),
    totalExpenses,
    closingMomoFloat: Number(account.closingMomoFloat),
    closingCash: Number(account.closingCash),
  }).expectedClosing;

  const difference =
    Math.round((actual - expected) * 100) / 100;
  const note = (formData.get("handoverNote") as string | null)?.trim() || null;
  if (difference !== 0 && (!note || note.length < 5)) {
    return {
      success: false,
      error:
        "The amount received differs from the expected handover. Explain the difference before confirming.",
    };
  }
  if (note && note.length > 500) {
    return { success: false, error: "Handover note must be 500 characters or fewer." };
  }

  const updated = await db.$transaction(async (tx) => {
    const row = await tx.dailyAccount.updateMany({
      where: {
        id: accountId,
        tenantId: ctx.tenantId,
        handoverConfirmedAt: null,
      },
      data: {
        actualAmountReceived: actual,
        handoverDifference: difference,
        handoverNote: note,
        handoverConfirmedAt: new Date(),
        handoverConfirmedBy: ctx.userId,
      },
    });
    if (row.count === 1) {
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "daily_account.handover_confirmed",
        entityType: "dailyAccount",
        entityId: accountId,
        details: {
          actualAmountReceived: actual,
          expectedAmount: expected,
          difference,
          handoverNote: note,
        },
      });
    }
    return row;
  });
  if (updated.count !== 1) {
    return {
      success: false,
      error: "This handover was already confirmed. Reload to review it.",
    };
  }

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

async function getDashboardNotifications(tenantId: string) {
  const [items, unread] = await Promise.all([
    listNotifications({ tenantId, audience: "tenant", limit: 6, includeResolved: false }),
    unreadNotificationCount({ tenantId, audience: "tenant" }),
  ]);
  return {
    unread,
    items: items.map((row) => ({
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      title: row.title,
      body: row.body,
      href: row.href,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
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
  const totalDebtsCollected = submitted.reduce(
    (sum, a) => sum + Number(a.debtsCollected),
    0
  );
  const totalCommission = submitted.reduce(
    (sum, a) => sum + Number(a.commission),
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
    totalDebtsCollected,
    totalCommission,
    totalExpenses: totalExpensesToday,
    totalNetIncrease:
      Math.round(
        (totalCommission + totalDebtsCollected - totalExpensesToday) * 100
      ) / 100,
    locationStatus,
    notifications: await getDashboardNotifications(ctx.tenantId),
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
    debtsCollected: number;
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
    debtsCollected: number;
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
        debtsCollected: Number(parsed.debtsCollected ?? 0),
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
        debtsCollected: 0,
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
      debtsCollected: Number(account.debtsCollected),
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
