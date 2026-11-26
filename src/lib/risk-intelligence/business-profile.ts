import { db } from "@/lib/db";
import type {
  BusinessLegalProfile,
  EmployeeNoticeSubject,
  SignatoryProfile,
} from "@/lib/risk-intelligence/legal-instruments";

/**
 * Verified business and signatory facts used by controlled legal instruments.
 * Nothing here is inferred from a display name or a free-text note: every field
 * is either recorded on the tenant/user row or supplied by the authenticated
 * signatory and validated before rendering.
 */

export const DPC_REGISTRATION_STATES = [
  "not_provided",
  "pending",
  "registered",
  "exempt",
] as const;

export type DpcRegistrationState = (typeof DPC_REGISTRATION_STATES)[number];

export interface BusinessProfileResult {
  profile: BusinessLegalProfile | null;
  missing: string[];
  dpcRegistrationStatus: DpcRegistrationState;
  dpcRegistrationNumber: string | null;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function businessProfileCompleteness(input: {
  legalName: string;
  registrationNumber: string;
  address: string;
  contactEmail: string;
  contactPhone: string;
}): string[] {
  const missing: string[] = [];
  if (input.legalName.length < 2) missing.push("registered business name");
  if (!/^[A-Za-z0-9][A-Za-z0-9\-\/]{2,39}$/.test(input.registrationNumber)) {
    missing.push("business registration number");
  }
  if (input.address.length < 8) missing.push("principal place of business");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.contactEmail)) missing.push("business email address");
  if (input.contactPhone.replace(/[^0-9]/g, "").length < 9) missing.push("business phone number");
  return missing;
}

export async function getBusinessLegalProfile(tenantId: string): Promise<BusinessProfileResult> {
  const tenant = await db.businessTenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      name: true,
      legalName: true,
      registrationNumber: true,
      address: true,
      contactEmail: true,
      contactPhone: true,
      dpcRegistrationStatus: true,
      dpcRegistrationNumber: true,
    },
  });
  if (!tenant) return { profile: null, missing: ["business record"], dpcRegistrationStatus: "not_provided", dpcRegistrationNumber: null };
  const legalName = clean(tenant.legalName) || clean(tenant.name);
  const registrationNumber = clean(tenant.registrationNumber);
  const address = clean(tenant.address);
  const contactEmail = clean(tenant.contactEmail);
  const contactPhone = clean(tenant.contactPhone);
  const missing = businessProfileCompleteness({ legalName, registrationNumber, address, contactEmail, contactPhone });
  const status = (DPC_REGISTRATION_STATES as readonly string[]).includes(tenant.dpcRegistrationStatus)
    ? (tenant.dpcRegistrationStatus as DpcRegistrationState)
    : "not_provided";
  return {
    profile: missing.length === 0
      ? { tenantId, legalName, registrationNumber, address, contactEmail, contactPhone }
      : null,
    missing,
    dpcRegistrationStatus: status,
    dpcRegistrationNumber: clean(tenant.dpcRegistrationNumber) || null,
  };
}

export async function getSignatoryProfile(
  userId: string,
  tenantId: string,
  capacity: string,
  authorityBasis: string,
  authenticationMethod: string
): Promise<SignatoryProfile | null> {
  const user = await db.user.findFirst({
    where: { id: userId, tenantId },
    select: { id: true, fullName: true },
  });
  if (!user) return null;
  return {
    userId: user.id,
    fullName: clean(user.fullName),
    capacity: clean(capacity),
    authorityBasis: clean(authorityBasis),
    authenticationMethod: clean(authenticationMethod),
  };
}

export async function getEmployeeNoticeSubject(
  tenantId: string,
  userId: string
): Promise<EmployeeNoticeSubject | null> {
  const user = await db.user.findFirst({
    where: { id: userId, tenantId },
    select: { id: true, fullName: true, phone: true },
  });
  if (!user) return null;
  const digits = (user.phone ?? "").replace(/[^0-9]/g, "");
  return {
    userId: user.id,
    fullName: clean(user.fullName),
    phoneLastFour: digits.length >= 4 ? digits.slice(-4) : "not recorded",
  };
}

export function authorityBasisFor(role: string): string {
  if (role === "admin") return "tenant administrator authority recorded on the account";
  return "authority recorded on the account";
}
