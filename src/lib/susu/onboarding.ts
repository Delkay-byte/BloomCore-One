/**
 * Shared Susu onboarding core.
 *
 * Three callers create customers and accounts: an administrator registering a
 * person in the office, a collector registering a person in the field, and the
 * Phase 7 import committer migrating existing records. They must produce the
 * SAME shape of record, or a migrated account behaves differently from an
 * account created by hand. This module is the single place where that shape is
 * defined.
 *
 * What lives here, and what deliberately does not:
 *
 *   * Identity only — customer, account, and the account's first cycle.
 *   * No money. A card fee is only created when an operator explicitly says a
 *     card was sold today. A migration never invents a contribution, a
 *     withdrawal, a commission or a card-fee payment.
 *   * No authorisation. Callers resolve the tenant, branch and role from the
 *     session and pass the already-authorised identifiers in. This module
 *     trusts its inputs because it is not a public surface.
 */

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/** A Prisma client scoped to a transaction. */
export type OnboardingTx = Prisma.TransactionClient;

// Identity rules, bounds and normalisation live in "./identity" so client
// components can reuse them without importing the database client. They are
// re-exported here so every existing importer of this module keeps working.
export * from "./identity";
import {
  moneyString,
  referenceKey,
  type OnboardingChannel,
} from "./identity";

/** The canonical prefixes used for human-readable identifiers. */
const ID_PREFIX = { customer: "BIK-C", account: "BIK-S" } as const;

/**
 * Allocate `count` unused human-readable identifiers.
 *
 * Identifiers stay globally unique because the customer portal signs in with
 * them and login carries no tenant hint. They are allocated from the current
 * row count upward, but the count is only a starting point: every candidate is
 * checked against the database in one round trip, and the unique index is the
 * final arbiter for a concurrent writer.
 */
export async function allocateHumanIds(
  tx: OnboardingTx,
  kind: "customer" | "account",
  count: number
): Promise<string[]> {
  if (count <= 0) return [];
  const prefix = ID_PREFIX[kind];
  const base =
    kind === "customer"
      ? await tx.customer.count()
      : await tx.susuAccount.count();

  const chosen: string[] = [];
  let next = base + 1;
  // Bounded so a corrupt table cannot spin forever; the caller surfaces a
  // generic failure instead of an unbounded loop.
  for (let round = 0; round < 40 && chosen.length < count; round++) {
    const probeSize = Math.max(50, (count - chosen.length) * 2);
    const candidates: string[] = [];
    for (let i = 0; i < probeSize; i++) {
      candidates.push(`${prefix}-${String(next + i).padStart(6, "0")}`);
    }
    next += probeSize;

    const taken = new Set(
      kind === "customer"
        ? (
            await tx.customer.findMany({
              where: { customerId: { in: candidates } },
              select: { customerId: true },
            })
          ).map((row) => row.customerId)
        : (
            await tx.susuAccount.findMany({
              where: { accountId: { in: candidates } },
              select: { accountId: true },
            })
          ).map((row) => row.accountId)
    );

    for (const candidate of candidates) {
      if (chosen.length >= count) break;
      if (!taken.has(candidate) && !chosen.includes(candidate)) {
        chosen.push(candidate);
      }
    }
  }

  if (chosen.length < count) {
    throw new Error("Could not allocate unique customer or account numbers.");
  }
  return chosen;
}

/** First day of the month containing `date`, in server-local time. */
function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** Last day of the month containing `date`, in server-local time. */
function monthEnd(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export interface CustomerFields {
  tenantId: string;
  customerId: string;
  fullName: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  externalReference?: string | null;
  registeredVia: OnboardingChannel;
  registeredById?: string | null;
  registeredBranchId?: string | null;
  /** Only the import committer sets this, to preserve a real historical date. */
  registeredAt?: Date | null;
}

/** Insert one customer row. Identity only — no money, no accounts. */
export async function insertCustomer(
  tx: OnboardingTx,
  fields: CustomerFields
) {
  return tx.customer.create({
    data: {
      tenantId: fields.tenantId,
      customerId: fields.customerId,
      fullName: fields.fullName,
      phone: fields.phone ?? null,
      email: fields.email ?? null,
      address: fields.address ?? null,
      notes: fields.notes ?? null,
      externalReference: fields.externalReference ?? null,
      registeredVia: fields.registeredVia,
      registeredById: fields.registeredById ?? null,
      registeredBranchId: fields.registeredBranchId ?? null,
      ...(fields.registeredAt ? { registeredAt: fields.registeredAt } : {}),
      status: "active",
    },
  });
}

export interface AccountFields {
  tenantId: string;
  accountId: string;
  customerId: string;
  dailyContribution: number;
  branchId?: string | null;
  openingDate?: Date | null;
  openedVia: OnboardingChannel;
  openedById?: string | null;
  externalAccountReference?: string | null;
  importBatchId?: string | null;
}

/**
 * Insert one Susu account together with its first cycle.
 *
 * The cycle is required, not cosmetic: `recordContribution` refuses an account
 * with no active cycle, so an account created without one is a dead record that
 * looks alive in the list. The cycle always starts in the current month, even
 * when the account's real opening date is historical, because MaaCash must not
 * pretend it was collecting during months it did not exist. The real opening
 * date is kept on the account for audits.
 */
export async function insertAccountWithCycle(
  tx: OnboardingTx,
  fields: AccountFields
) {
  const account = await tx.susuAccount.create({
    data: {
      tenantId: fields.tenantId,
      accountId: fields.accountId,
      customerId: fields.customerId,
      dailyContribution: moneyString(fields.dailyContribution),
      status: "active",
      cardCustody: "customer",
      branchId: fields.branchId ?? null,
      openingDate: fields.openingDate ?? null,
      openedVia: fields.openedVia,
      openedById: fields.openedById ?? null,
      externalAccountReference: fields.externalAccountReference ?? null,
      importBatchId: fields.importBatchId ?? null,
    },
  });

  const now = new Date();
  await tx.susuCycle.create({
    data: {
      tenantId: fields.tenantId,
      accountId: account.id,
      cycleNumber: 1,
      startDate: monthStart(now),
      endDate: monthEnd(now),
      dailyContribution: moneyString(fields.dailyContribution),
      status: "active",
      commissionCharged: false,
    },
  });

  return account;
}

export interface OnboardInput {
  tenantId: string;
  fullName: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  externalReference?: string | null;
  dailyContribution: number;
  branchId?: string | null;
  openingDate?: Date | null;
  externalAccountReference?: string | null;
  channel: OnboardingChannel;
  actorId?: string | null;
  importBatchId?: string | null;
  registeredAt?: Date | null;
}

/**
 * Create a new customer together with their first account and that account's
 * first cycle. Returns the created rows so the caller can add its own audit
 * entry inside the same transaction.
 */
export async function onboardCustomerWithAccount(
  tx: OnboardingTx,
  input: OnboardInput
) {
  const [customerId] = await allocateHumanIds(tx, "customer", 1);
  const [accountId] = await allocateHumanIds(tx, "account", 1);

  const customer = await insertCustomer(tx, {
    tenantId: input.tenantId,
    customerId,
    fullName: input.fullName,
    phone: input.phone,
    email: input.email,
    address: input.address,
    notes: input.notes,
    externalReference: input.externalReference,
    registeredVia: input.channel,
    registeredById: input.actorId,
    registeredBranchId: input.branchId,
    registeredAt: input.registeredAt,
  });

  const account = await insertAccountWithCycle(tx, {
    tenantId: input.tenantId,
    accountId,
    customerId: customer.id,
    dailyContribution: input.dailyContribution,
    branchId: input.branchId,
    openingDate: input.openingDate,
    openedVia: input.channel,
    openedById: input.actorId,
    externalAccountReference: input.externalAccountReference,
    importBatchId: input.importBatchId,
  });

  return { customer, account };
}

/**
 * Add another account to a customer that already exists.
 *
 * This is the operation a person actually needs when they open a second
 * savings line or move to a different branch. It creates an ACCOUNT, never a
 * second customer record — the whole point of the Phase 7 identity split.
 */
export async function openAdditionalAccount(
  tx: OnboardingTx,
  input: Omit<OnboardInput, "fullName" | "phone" | "email" | "registeredAt"> & {
    customerId: string;
    externalAccountReference?: string | null;
  }
) {
  const [accountId] = await allocateHumanIds(tx, "account", 1);
  const account = await insertAccountWithCycle(tx, {
    tenantId: input.tenantId,
    accountId,
    customerId: input.customerId,
    dailyContribution: input.dailyContribution,
    branchId: input.branchId,
    openingDate: input.openingDate,
    openedVia: input.channel,
    openedById: input.actorId,
    externalAccountReference: input.externalAccountReference,
    importBatchId: input.importBatchId,
  });
  return account;
}

/**
 * Assert that a tenant-scoped unique-ish reference is not already claimed by a
 * DIFFERENT customer. Returns the conflicting customer, if any.
 *
 * References are not unique by design; this is a duplicate *signal* used by the
 * importer to ask a human, never a hard constraint that rejects a real person.
 */
export async function findCustomerByExternalReference(
  tx: OnboardingTx,
  tenantId: string,
  reference: string
) {
  const key = referenceKey(reference);
  if (!key) return null;
  return tx.customer.findFirst({
    where: {
      tenantId,
      externalReference: { equals: reference.trim() },
    },
    select: { id: true, customerId: true, fullName: true, phone: true },
  });
}

/**
 * Whether the database is currently reachable, without leaking a driver error.
 * Used only to turn a low-level failure into an operator-readable message.
 */
export function isRetryableWriteConflict(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: string }).code
      : undefined;
  const message = error instanceof Error ? error.message : "";
  return (
    code === "P2002" ||
    code === "P2034" ||
    code === "P2028" ||
    code === "P1008" ||
    /database is locked|SQLITE_BUSY|timed out|transaction already closed|deadlock/i.test(
      message
    )
  );
}

/** A Prisma client or a transaction — for read-only helper queries. */
export type OnboardingReader = OnboardingTx | typeof db;
