/**
 * Controlled business provisioning.
 *
 * Public self-registration stays disabled. Platform Super Admin converts an
 * enquiry (or creates a business directly) into:
 *   tenant (PENDING_PAYMENT) -> first administrator (verified e-mail invite)
 *   -> approved plan and billing term -> optional founding slot
 *   -> pending_payment subscription that the administrator pays after signing in.
 *
 * Nothing here activates a subscription or charges money.
 */

import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { hashPlatformPassword } from "@/lib/platform-auth";
import { issueEmailVerification } from "@/lib/security/account-tokens";
import { assignFoundingAllocation, foundingRemaining } from "@/lib/pricing/founding";
import type { Prisma } from "@prisma/client";

const TENANT_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateTempPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%&*?";
  const all = upper + lower + digits + symbols;
  const pick = (set: string) => set[randomBytes(1)[0] % set.length];
  let out = pick(upper) + pick(lower) + pick(digits) + pick(symbols);
  for (let i = 0; i < 9; i += 1) out += pick(all);
  return out
    .split("")
    .sort(() => (randomBytes(1)[0] % 2 === 0 ? 1 : -1))
    .join("");
}

async function generateTenantCode(tx: Prisma.TransactionClient | typeof db): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let suffix = "";
    for (let i = 0; i < 6; i += 1) {
      suffix += TENANT_CODE_ALPHABET[randomBytes(1)[0] % TENANT_CODE_ALPHABET.length];
    }
    const code = `BT-${suffix}`;
    const existing = await tx.businessTenant.findUnique({ where: { code } });
    if (!existing) return code;
  }
  throw new Error("Could not generate a unique tenant code");
}

export interface ProvisionInput {
  name: string;
  legalName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  address?: string | null;
  momoEnabled: boolean;
  susuEnabled: boolean;
  adminFullName: string;
  adminEmail: string;
  adminPhone?: string | null;
  planCode: string;
  foundingOptIn: boolean;
  enquiryId?: string | null;
  actorId: string;
  actorEmail: string;
}

export type ProvisionResult =
  | {
      ok: true;
      tenantId: string;
      tenantCode: string;
      adminUserId: string;
      adminEmail: string;
      planCode: string;
      planName: string;
      billingTerm: string;
      amount: number;
      standardAmount: number;
      foundingSlot: number | null;
      foundingRemainingPeriods: number;
      subscriptionId: string;
      paymentReference: string;
      /** Returned once to the operator for out-of-band handover. Never logged. */
      temporaryPassword: string;
    }
  | { ok: false; error: string };

export async function provisionBusiness(input: ProvisionInput): Promise<ProvisionResult> {
  const name = input.name.trim();
  const adminEmail = input.adminEmail.trim().toLowerCase();
  if (name.length < 2) return { ok: false, error: "Business name is required." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    return { ok: false, error: "A valid administrator email is required." };
  }
  if (input.adminFullName.trim().length < 2) {
    return { ok: false, error: "Administrator full name is required." };
  }
  if (!input.momoEnabled && !input.susuEnabled) {
    return { ok: false, error: "Choose at least one module (MoMo or Susu)." };
  }

  const plan = await db.zeliPlan.findUnique({ where: { code: input.planCode } });
  if (!plan || plan.status !== "active") {
    return { ok: false, error: "Choose an active package." };
  }
  const existingAdmin = await db.user.findUnique({ where: { email: adminEmail } });
  if (existingAdmin) {
    return { ok: false, error: "A staff account already uses this email." };
  }

  const temporaryPassword = generateTempPassword();
  const passwordHash = await hashPlatformPassword(temporaryPassword);
  const tenantCode = await generateTenantCode(db);

  try {
    const created = await db.$transaction(async (tx) => {
      const tenant = await tx.businessTenant.create({
        data: {
          code: tenantCode,
          name,
          legalName: input.legalName?.trim() || null,
          contactPhone: input.contactPhone?.trim() || null,
          contactEmail: input.contactEmail?.trim().toLowerCase() || adminEmail,
          address: input.address?.trim() || null,
          momoEnabled: input.momoEnabled,
          susuEnabled: input.susuEnabled,
          status: "PENDING_PAYMENT",
          onboardingStatus: "IN_PROGRESS",
        },
      });

      const admin = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: adminEmail,
          fullName: input.adminFullName.trim(),
          phone: input.adminPhone?.trim() || null,
          role: "admin",
          status: "active",
          passwordHash,
          forcePasswordReset: true,
          emailVerified: false,
          momoEnabled: true,
          susuEnabled: true,
        },
      });
      await tx.businessTenant.update({
        where: { id: tenant.id },
        data: { primaryAdminUserId: admin.id },
      });

      let founding = null as null | { id: string; slot: number };
      if (input.foundingOptIn) {
        const assignment = await assignFoundingAllocation({
          tenantId: tenant.id,
          plan: {
            id: plan.id,
            code: plan.code,
            billingInterval: plan.billingInterval,
            price: plan.price,
            foundingPrice: plan.foundingPrice,
          },
          actorId: input.actorId,
          client: tx,
        });
        if (!assignment.ok) {
          throw new ProvisioningError(
            assignment.reason === "capacity_reached"
              ? "All five founding slots are already assigned. Provision at standard pricing."
              : "This package or business is not eligible for the founding offer.",
            "founding_unavailable"
          );
        }
        founding = { id: assignment.allocationId, slot: assignment.slot };
      }

      const amount = founding ? plan.foundingPrice! : plan.price;
      const billingTerm = plan.billingInterval === "year" ? "annual" : "monthly";
      const reference = `PROV-${tenant.id.slice(0, 8)}-${randomBytes(6).toString("hex")}`;

      const subscription = await tx.zeliSubscription.create({
        data: {
          tenantId: tenant.id,
          planId: plan.id,
          status: "pending_payment",
          provider: "paystack",
          providerReference: reference,
          amount,
          currency: plan.currency,
          billingTerm,
          foundingAllocationId: founding?.id ?? null,
          standardAmount: plan.price,
        },
      });

      if (input.enquiryId) {
        await tx.accountEnquiry.updateMany({
          where: { id: input.enquiryId },
          data: {
            status: "provisioned",
            tenantId: tenant.id,
            convertedAt: new Date(),
            assignedPlanCode: plan.code,
            billingTerm,
            reviewedById: input.actorId,
            reviewedAt: new Date(),
          },
        });
      }

      return { tenant, admin, subscription, founding, amount, billingTerm };
    });

    await issueEmailVerification(created.admin.id, { force: true }).catch(() => undefined);

    return {
      ok: true,
      tenantId: created.tenant.id,
      tenantCode: created.tenant.code,
      adminUserId: created.admin.id,
      adminEmail: created.admin.email,
      planCode: plan.code,
      planName: plan.name,
      billingTerm: created.billingTerm,
      amount: Number(created.amount),
      standardAmount: Number(plan.price),
      foundingSlot: created.founding?.slot ?? null,
      foundingRemainingPeriods: created.founding ? foundingRemaining({ periodsGranted: 3, periodsUsed: 0, status: "active" }) : 0,
      subscriptionId: created.subscription.id,
      paymentReference: created.subscription.providerReference,
      temporaryPassword,
    };
  } catch (error) {
    if (error instanceof ProvisioningError) {
      return { ok: false, error: error.message };
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return { ok: false, error: "That administrator email or business code is already in use." };
    }
    return { ok: false, error: "Provisioning failed. No partial records were kept." };
  }
}

class ProvisioningError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ProvisioningError";
    this.code = code;
  }
}
