/**
 * Association governance rules.
 *
 * An association is not a business and not a platform operator. It has its own
 * membership, zones, roles and consent records, and its roles deliberately do
 * not inherit any authority over a member business's money. Nothing here writes
 * a financial row.
 */

import { z } from "zod";

export const ASSOCIATION_STATUSES = ["active", "inactive"] as const;
export type AssociationStatus = (typeof ASSOCIATION_STATUSES)[number];

export const ASSOCIATION_ROLES = [
  "association_admin",
  "zone_officer",
  "member_viewer",
  "auditor",
] as const;
export type AssociationRole = (typeof ASSOCIATION_ROLES)[number];

export const ASSOCIATION_ROLE_LABELS: Record<AssociationRole, string> = {
  association_admin: "Association administrator",
  zone_officer: "Zone officer",
  member_viewer: "Member viewer",
  auditor: "Auditor",
};

/** What each role may do. Read is deliberately separated from write. */
export const ASSOCIATION_ROLE_CAPABILITIES: Record<
  AssociationRole,
  { view: boolean; manageMembers: boolean; manageGovernance: boolean; manageRoles: boolean }
> = {
  association_admin: {
    view: true,
    manageMembers: true,
    manageGovernance: true,
    manageRoles: true,
  },
  zone_officer: {
    view: true,
    manageMembers: true,
    manageGovernance: false,
    manageRoles: false,
  },
  member_viewer: {
    view: true,
    manageMembers: false,
    manageGovernance: false,
    manageRoles: false,
  },
  auditor: {
    view: true,
    manageMembers: false,
    manageGovernance: false,
    manageRoles: false,
  },
};

export type AssociationCapability = keyof Omit<
  (typeof ASSOCIATION_ROLE_CAPABILITIES)[AssociationRole],
  never
>;

export function isAssociationRole(value: string): value is AssociationRole {
  return (ASSOCIATION_ROLES as readonly string[]).includes(value);
}

/**
 * Whether any active role allows a capability.
 *
 * Revoked assignments are filtered by the caller, so this only answers "does one
 * of these roles allow it". A business administrator is handled separately: they
 * keep the existing register access without needing an association role.
 */
export function associationAllows(
  roles: AssociationRole[],
  capability: AssociationCapability
): boolean {
  return roles.some((role) => ASSOCIATION_ROLE_CAPABILITIES[role][capability]);
}

export const ASSOCIATION_CONSENT_TYPES = [
  "membership_agreement",
  "data_sharing",
  "access_review",
] as const;
export type AssociationConsentType = (typeof ASSOCIATION_CONSENT_TYPES)[number];

export const ASSOCIATION_CONSENT_LABELS: Record<AssociationConsentType, string> = {
  membership_agreement: "Membership agreement",
  data_sharing: "Data-sharing consent",
  access_review: "Access review",
};

export function isConsentType(value: string): value is AssociationConsentType {
  return (ASSOCIATION_CONSENT_TYPES as readonly string[]).includes(value);
}

/**
 * A consent counts only while it is granted, unexpired and not withdrawn.
 *
 * Expiry is evaluated at read time rather than stored as a status, so a consent
 * that lapses overnight stops counting without a job having to run.
 */
export function consentIsActive(
  record: { grantedAt: Date; expiresAt: Date | null; withdrawnAt: Date | null },
  now = new Date()
): boolean {
  if (record.withdrawnAt) return false;
  if (record.expiresAt && record.expiresAt.getTime() <= now.getTime()) return false;
  return record.grantedAt.getTime() <= now.getTime();
}

export const associationSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, "Enter an association code of at least 2 characters.")
    .max(20, "Keep the association code to 20 characters.")
    .regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dot, dash or underscore."),
  name: z.string().trim().min(3, "Enter the association name.").max(140),
  region: z.string().trim().max(80).optional(),
  charterVersion: z.string().trim().max(40).optional(),
  contactEmail: z
    .string()
    .trim()
    .email("Enter a valid contact email.")
    .optional()
    .or(z.literal("")),
  contactPhone: z
    .string()
    .trim()
    .max(30)
    .regex(/^[+\d\s()-]*$/, "Use digits and the usual phone punctuation.")
    .optional()
    .or(z.literal("")),
});

export const associationZoneSchema = z.object({
  associationId: z.string().min(1, "Choose an association."),
  code: z
    .string()
    .trim()
    .min(2, "Enter a zone code of at least 2 characters.")
    .max(20)
    .regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dot, dash or underscore."),
  name: z.string().trim().min(2, "Enter the zone name.").max(120),
  region: z.string().trim().max(80).optional(),
  parentZoneId: z.string().trim().nullable().optional(),
});

export const associationRoleSchema = z.object({
  associationId: z.string().min(1),
  zoneId: z.string().trim().nullable().optional(),
  userId: z.string().min(1, "Choose the person to give the role to."),
  role: z.enum(ASSOCIATION_ROLES),
});

export const associationConsentSchema = z.object({
  associationId: z.string().min(1),
  memberId: z.string().trim().nullable().optional(),
  subjectType: z.enum(ASSOCIATION_CONSENT_TYPES),
  expiresAt: z.string().trim().optional(),
  documentRef: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
});

export const ASSOCIATION_EXPORT_TYPES = [
  "members",
  "zones",
  "sponsorships",
  "training",
  "consent",
] as const;
export type AssociationExportType = (typeof ASSOCIATION_EXPORT_TYPES)[number];

export function isAssociationExportType(value: string): value is AssociationExportType {
  return (ASSOCIATION_EXPORT_TYPES as readonly string[]).includes(value);
}

export const ASSOCIATION_GOVERNANCE_NOTE =
  "Association records are administrative. Roles here never grant authority over a member business's money, and a sponsorship is an agreement, not a payment.";
