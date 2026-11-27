"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getTenantContext, type TenantContext } from "@/lib/tenant";
import { createAuditLog, createAuditLogTx } from "@/lib/audit";
import {
  isBranchlessTenant,
  resolveBranchScope,
  resolveWriteBranch,
} from "@/lib/branch";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { hashPassword } from "@/lib/auth";
import { validatePasswordPolicy } from "@/lib/security/password-policy";
import {
  ONBOARDING_LIMITS,
  cleanText,
  isRetryableWriteConflict,
  looksLikeEmail,
  moneyString,
  onboardCustomerWithAccount,
  openAdditionalAccount,
  reusableAccountNumber,
} from "@/lib/susu/onboarding";

export interface ActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

/**
 * Resolve the administrator performing an onboarding action.
 *
 * Returns a reason instead of redirecting so a half-filled form keeps its
 * values and the operator sees why the action was refused.
 */
async function resolveOnboardingActor(): Promise<
  { ok: true; ctx: TenantContext } | { ok: false; error: string }
> {
  const ctx =
    (await getTenantContext("admin", "susu")) ??
    (await getTenantContext("susu", "susu")) ??
    (await getTenantContext("momo", "susu"));
  if (!ctx) return { ok: false, error: "Please sign in again." };
  if (ctx.role !== "admin") {
    return {
      ok: false,
      error: "Only an administrator can register customers from this screen.",
    };
  }
  return { ok: true, ctx };
}

/** Date-only input (YYYY-MM-DD) to a UTC midnight date, or null. */
function parseOpeningDate(value: unknown): Date | null | "invalid" {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "invalid";
  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return "invalid";
  }
  if (date.getTime() > Date.now() + 24 * 60 * 60 * 1000) return "invalid";
  return date;
}

/**
 * Options for the registration form: the branches and collectors this operator
 * may actually use, resolved on the server so the UI can never offer a target
 * that would be refused.
 */
export async function getOnboardingOptions(): Promise<ActionResponse> {
  const actor = await resolveOnboardingActor();
  if (!actor.ok) return { success: false, error: actor.error };
  const { ctx } = actor;

  const scope = await resolveBranchScope(ctx);
  const branchless = await isBranchlessTenant(ctx);

  const branches = await db.location.findMany({
    where: {
      tenantId: ctx.tenantId,
      status: "active",
      ...(scope.kind === "all" ? {} : { id: { in: scope.branchIds } }),
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, code: true },
  });

  const collectors = await db.collector.findMany({
    where: {
      tenantId: ctx.tenantId,
      status: "active",
      ...(scope.kind === "all"
        ? {}
        : {
            OR: [
              { branchId: null },
              { branchId: { in: scope.branchIds } },
            ],
          }),
    },
    orderBy: { user: { fullName: "asc" } },
    select: {
      id: true,
      branchId: true,
      user: { select: { fullName: true, email: true } },
    },
  });

  return {
    success: true,
    data: {
      branches,
      collectors: collectors.map((collector) => ({
        id: collector.id,
        fullName: collector.user.fullName,
        email: collector.user.email,
        branchId: collector.branchId,
      })),
      branchless,
      defaultBranchId: branches.length === 1 ? branches[0].id : null,
      limits: {
        nameMax: ONBOARDING_LIMITS.nameMax,
        dailyContributionMax: ONBOARDING_LIMITS.dailyContributionMax,
        cardFeeMax: ONBOARDING_LIMITS.cardFeeMax,
      },
    },
  };
}

/**
 * Search for an existing customer before opening another account.
 *
 * This is the anti-duplicate control that matters most in daily use: the
 * operator is shown the person they probably already have, with their accounts,
 * instead of being allowed to type the same person in twice.
 */
export async function findCustomerCandidates(
  query: string
): Promise<ActionResponse> {
  const actor = await resolveOnboardingActor();
  if (!actor.ok) return { success: false, error: actor.error };
  const { ctx } = actor;

  const term = cleanText(query, 80);
  if (!term || term.length < 2) {
    return { success: false, error: "Type at least 2 characters to search." };
  }

  const customers = await db.customer.findMany({
    where: {
      tenantId: ctx.tenantId,
      OR: [
        { fullName: { contains: term } },
        { customerId: { contains: term } },
        { phone: { contains: term } },
        { externalReference: { contains: term } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      customerId: true,
      fullName: true,
      phone: true,
      email: true,
      externalReference: true,
      status: true,
      accounts: {
        select: {
          id: true,
          accountId: true,
          status: true,
          dailyContribution: true,
          branchId: true,
        },
      },
    },
  });

  return {
    success: true,
    data: {
      customers: customers.map((customer) => ({
        ...customer,
        accounts: customer.accounts.map((account) => ({
          ...account,
          dailyContribution: Number(account.dailyContribution),
        })),
        accountCount: customer.accounts.length,
      })),
    },
  };
}

/**
 * Register a person and open their first savings account.
 *
 * Office onboarding. Both records are created in one transaction with the
 * account's first cycle, so a half-registered customer cannot exist. A card fee
 * is recorded only when the operator states one was actually collected.
 */
export async function registerCustomerOnboarding(
  formData: FormData
): Promise<ActionResponse> {
  const actor = await resolveOnboardingActor();
  if (!actor.ok) return { success: false, error: actor.error };
  const { ctx } = actor;

  const limited = await consumeRateLimit(
    "susu:onboarding:register",
    ctx.userId,
    RATE_LIMITS.financeMutation
  );
  if (!limited.allowed) {
    return {
      success: false,
      error: `Too many registrations. Try again in ${limited.retryAfterSeconds} seconds.`,
    };
  }

  const fullName = cleanText(formData.get("fullName"), ONBOARDING_LIMITS.nameMax);
  const phone = cleanText(formData.get("phone"), ONBOARDING_LIMITS.phoneMax);
  const email = cleanText(formData.get("email"), 160);
  const address = cleanText(formData.get("address"), ONBOARDING_LIMITS.addressMax);
  const notes = cleanText(formData.get("notes"), ONBOARDING_LIMITS.notesMax);
  const externalReference = cleanText(
    formData.get("externalReference"),
    ONBOARDING_LIMITS.externalReferenceMax
  );
  const accountNumber = cleanText(formData.get("accountNumber"), 32);
  const collectorId = cleanText(formData.get("collectorId"), 64);
  const requestedBranchId = cleanText(formData.get("branchId"), 64);
  const temporaryPassword = cleanText(formData.get("temporaryPassword"), 200);

  if (!fullName || fullName.length < ONBOARDING_LIMITS.nameMin) {
    return {
      success: false,
      error: `Full name must be at least ${ONBOARDING_LIMITS.nameMin} characters`,
    };
  }
  if (email && !looksLikeEmail(email)) {
    return { success: false, error: "Enter a valid e-mail address." };
  }

  const dailyContribution = Number(formData.get("dailyContribution"));
  if (
    !Number.isFinite(dailyContribution) ||
    dailyContribution < ONBOARDING_LIMITS.dailyContributionMin ||
    dailyContribution > ONBOARDING_LIMITS.dailyContributionMax
  ) {
    return {
      success: false,
      error: `Daily contribution must be between ${ONBOARDING_LIMITS.dailyContributionMin} and ${ONBOARDING_LIMITS.dailyContributionMax}`,
    };
  }
  if (Math.abs(dailyContribution * 100 - Math.round(dailyContribution * 100)) > 1e-6) {
    return {
      success: false,
      error: "Daily contribution cannot have more than 2 decimal places",
    };
  }

  const rawCardFee = formData.get("cardFee");
  const cardFee =
    rawCardFee === null || rawCardFee === "" ? 0 : Number(rawCardFee);
  if (
    !Number.isFinite(cardFee) ||
    cardFee < ONBOARDING_LIMITS.cardFeeMin ||
    cardFee > ONBOARDING_LIMITS.cardFeeMax
  ) {
    return { success: false, error: "Card fee must be between 0 and 10,000" };
  }

  const openingDate = parseOpeningDate(formData.get("openingDate"));
  if (openingDate === "invalid") {
    return {
      success: false,
      error: "Opening date must be a real date in the past, written as YYYY-MM-DD.",
    };
  }

  if (temporaryPassword) {
    const policyError = validatePasswordPolicy(temporaryPassword);
    if (policyError) {
      return { success: false, error: `Temporary password: ${policyError}` };
    }
  }

  if (accountNumber && !reusableAccountNumber(accountNumber)) {
    return {
      success: false,
      error:
        "That account number cannot be issued. Leave it blank and MaaCash will allocate one.",
    };
  }
  if (accountNumber) {
    const claimed = await db.susuAccount.findFirst({
      where: {
        OR: [
          { accountId: accountNumber },
          { tenantId: ctx.tenantId, externalAccountReference: accountNumber },
        ],
      },
      select: { id: true },
    });
    if (claimed) {
      return {
        success: false,
        error: "That account number is already in use. Choose another or leave it blank.",
      };
    }
  }

  const branchId = await resolveWriteBranch(ctx, requestedBranchId);
  if (requestedBranchId && !branchId) {
    return {
      success: false,
      error: "You are not authorised to register customers in that branch.",
    };
  }
  if (!branchId && !(await isBranchlessTenant(ctx))) {
    return { success: false, error: "Choose the branch for this registration." };
  }

  let collector: { id: string; branchId: string | null } | null = null;
  if (collectorId) {
    collector = await db.collector.findFirst({
      where: { id: collectorId, tenantId: ctx.tenantId, status: "active" },
      select: { id: true, branchId: true },
    });
    if (!collector) {
      return {
        success: false,
        error: "That collector is not active in this business.",
      };
    }
    if (
      collector.branchId &&
      branchId &&
      collector.branchId !== branchId
    ) {
      return {
        success: false,
        error:
          "That collector belongs to a different branch than the one selected.",
      };
    }
  }

  let created: Awaited<ReturnType<typeof onboardCustomerWithAccount>> | null = null;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    try {
      created = await db.$transaction(
        async (tx) => {
          const result = await onboardCustomerWithAccount(tx, {
            tenantId: ctx.tenantId,
            fullName,
            phone,
            email,
            address,
            notes,
            externalReference,
            dailyContribution,
            branchId,
            openingDate,
            externalAccountReference: accountNumber,
            channel: "office",
            actorId: ctx.userId,
            registeredAt: openingDate,
          });

          if (accountNumber) {
            await tx.susuAccount.update({
              where: { id: result.account.id },
              data: { accountId: accountNumber },
            });
          }

          if (cardFee > 0) {
            await tx.cardFee.create({
              data: {
                tenantId: ctx.tenantId,
                accountId: result.account.id,
                amount: cardFee,
                recordedById: ctx.userId,
                notes: "Initial card purchase",
              },
            });
          }

          if (collector) {
            await tx.collectorCustomerAssignment.create({
              data: {
                tenantId: ctx.tenantId,
                collectorId: collector.id,
                customerId: result.customer.id,
                accountId: result.account.id,
                active: true,
                activeAccountKey: result.account.id,
                assignedById: ctx.userId,
              },
            });
          }

          await createAuditLogTx(tx, {
            userId: ctx.userId,
            tenantId: ctx.tenantId,
            branchId,
            action: "susu.customer_created",
            entityType: "customer",
            entityId: result.customer.id,
            details: {
              customerId: result.customer.customerId,
              fullName,
              dailyContribution: moneyString(dailyContribution),
              cardFee,
              accountId: accountNumber ?? result.account.accountId,
              channel: "office",
              branchId,
              collectorId: collector?.id ?? null,
              externalReference: externalReference ?? null,
              openingDate: openingDate ? openingDate.toISOString().slice(0, 10) : null,
            },
          });

          return result;
        },
        { timeout: 20_000, maxWait: 10_000 }
      );
    } catch (error) {
      if (isRetryableWriteConflict(error) && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        continue;
      }
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code === "P2002") {
        return {
          success: false,
          error:
            "That e-mail address or account number is already registered. Search for the existing customer instead.",
        };
      }
      if (process.env.NODE_ENV !== "production") {
        console.error(
          "[onboarding] registration failed",
          code ?? "unknown",
          error instanceof Error ? error.message.slice(0, 200) : ""
        );
      }
      return {
        success: false,
        error: "The customer could not be registered. Please try again.",
      };
    }
  }

  if (!created) {
    return {
      success: false,
      error: "The customer could not be registered. Please try again.",
    };
  }

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
      tenantId: ctx.tenantId,
      action: "susu.customer_portal_created",
      entityType: "customer",
      entityId: created.customer.id,
      details: {
        customerId: created.customer.customerId,
        method: "onboarding",
        forcePasswordReset: true,
      },
    });
  }

  revalidatePath("/susu/admin/customers");
  revalidatePath("/susu/admin/collectors");
  return {
    success: true,
    data: {
      customer: created.customer,
      susuAccount: created.account,
      accountNumber: created.customer.customerId,
      portalEnabled: portalCreated,
    },
  };
}

/**
 * Open an additional account for an existing customer.
 *
 * One person, many accounts. The customer record is never duplicated, and the
 * account carries its own branch and daily contribution.
 */
export async function addAccountToCustomerOnboarding(
  formData: FormData
): Promise<ActionResponse> {
  const actor = await resolveOnboardingActor();
  if (!actor.ok) return { success: false, error: actor.error };
  const { ctx } = actor;

  const limited = await consumeRateLimit(
    "susu:onboarding:account",
    ctx.userId,
    RATE_LIMITS.financeMutation
  );
  if (!limited.allowed) {
    return {
      success: false,
      error: `Too many changes. Try again in ${limited.retryAfterSeconds} seconds.`,
    };
  }

  const customerId = cleanText(formData.get("customerId"), 64);
  if (!customerId) {
    return { success: false, error: "Choose the customer first." };
  }
  const customer = await db.customer.findFirst({
    where: { id: customerId, tenantId: ctx.tenantId },
    select: { id: true, customerId: true, fullName: true, status: true },
  });
  if (!customer) {
    return { success: false, error: "Customer not found in this business." };
  }
  if (customer.status !== "active") {
    return {
      success: false,
      error: "This customer is inactive. Reactivate them before opening an account.",
    };
  }

  const dailyContribution = Number(formData.get("dailyContribution"));
  if (
    !Number.isFinite(dailyContribution) ||
    dailyContribution < ONBOARDING_LIMITS.dailyContributionMin ||
    dailyContribution > ONBOARDING_LIMITS.dailyContributionMax
  ) {
    return {
      success: false,
      error: `Daily contribution must be between ${ONBOARDING_LIMITS.dailyContributionMin} and ${ONBOARDING_LIMITS.dailyContributionMax}`,
    };
  }

  const requestedBranchId = cleanText(formData.get("branchId"), 64);
  const branchId = await resolveWriteBranch(ctx, requestedBranchId);
  if (requestedBranchId && !branchId) {
    return {
      success: false,
      error: "You are not authorised to open an account in that branch.",
    };
  }
  if (!branchId && !(await isBranchlessTenant(ctx))) {
    return { success: false, error: "Choose the branch for this account." };
  }

  const openingDate = parseOpeningDate(formData.get("openingDate"));
  if (openingDate === "invalid") {
    return {
      success: false,
      error: "Opening date must be a real date in the past, written as YYYY-MM-DD.",
    };
  }

  const collectorId = cleanText(formData.get("collectorId"), 64);
  let collector: { id: string } | null = null;
  if (collectorId) {
    collector = await db.collector.findFirst({
      where: { id: collectorId, tenantId: ctx.tenantId, status: "active" },
      select: { id: true },
    });
    if (!collector) {
      return { success: false, error: "That collector is not active in this business." };
    }
  }

  const accountNumber = cleanText(formData.get("accountNumber"), 32);
  if (accountNumber && !reusableAccountNumber(accountNumber)) {
    return {
      success: false,
      error:
        "That account number cannot be issued. Leave it blank and MaaCash will allocate one.",
    };
  }
  if (accountNumber) {
    const claimed = await db.susuAccount.findFirst({
      where: {
        OR: [
          { accountId: accountNumber },
          { tenantId: ctx.tenantId, externalAccountReference: accountNumber },
        ],
      },
      select: { id: true },
    });
    if (claimed) {
      return { success: false, error: "That account number is already in use." };
    }
  }

  let created: Awaited<ReturnType<typeof openAdditionalAccount>> | null = null;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    try {
      created = await db.$transaction(
        async (tx) => {
          const account = await openAdditionalAccount(tx, {
            tenantId: ctx.tenantId,
            customerId: customer.id,
            dailyContribution,
            branchId,
            openingDate,
            externalAccountReference: accountNumber,
            channel: "office",
            actorId: ctx.userId,
          });

          if (accountNumber) {
            await tx.susuAccount.update({
              where: { id: account.id },
              data: { accountId: accountNumber },
            });
          }

          if (collector) {
            await tx.collectorCustomerAssignment.create({
              data: {
                tenantId: ctx.tenantId,
                collectorId: collector.id,
                customerId: customer.id,
                accountId: account.id,
                active: true,
                activeAccountKey: account.id,
                assignedById: ctx.userId,
              },
            });
          }

          await createAuditLogTx(tx, {
            userId: ctx.userId,
            tenantId: ctx.tenantId,
            branchId,
            action: "susu.account_opened_for_customer",
            entityType: "susu_account",
            entityId: account.id,
            details: {
              customerId: customer.customerId,
              accountId: accountNumber ?? account.accountId,
              dailyContribution: moneyString(dailyContribution),
              branchId,
              collectorId: collector?.id ?? null,
              openingDate: openingDate ? openingDate.toISOString().slice(0, 10) : null,
            },
          });

          return account;
        },
        { timeout: 20_000, maxWait: 10_000 }
      );
    } catch (error) {
      if (isRetryableWriteConflict(error) && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        continue;
      }
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code === "P2002") {
        return { success: false, error: "That account number is already in use." };
      }
      if (process.env.NODE_ENV !== "production") {
        console.error(
          "[onboarding] additional account failed",
          code ?? "unknown",
          error instanceof Error ? error.message.slice(0, 200) : ""
        );
      }
      return {
        success: false,
        error: "The account could not be opened. Please try again.",
      };
    }
  }

  if (!created) {
    return {
      success: false,
      error: "The account could not be opened. Please try again.",
    };
  }

  revalidatePath("/susu/admin/customers");
  return {
    success: true,
    data: {
      account: created,
      customer: { id: customer.id, customerId: customer.customerId, fullName: customer.fullName },
      accountNumber: accountNumber ?? created.accountId,
    },
  };
}
