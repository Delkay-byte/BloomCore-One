"use server";

import { db } from "@/lib/db";
import { requireTenantAdmin } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import { buildCsv } from "@/lib/csv";
import {
  ASSOCIATION_CONSENT_LABELS,
  ASSOCIATION_ROLE_LABELS,
  associationAllows,
  associationConsentSchema,
  associationRoleSchema,
  associationSchema,
  associationZoneSchema,
  consentIsActive,
  isAssociationExportType,
  isAssociationRole,
  type AssociationCapability,
  type AssociationConsentType,
  type AssociationExportType,
  type AssociationRole,
} from "@/lib/association-governance";

/**
 * Association entity, zones, roles, consent and exports.
 *
 * The register rows keep their tenant for isolation; `associationId` says which
 * association owns them. Every write is audited with `financialMutation: false`,
 * and an association role never grants authority over a member business's money.
 */

export interface AssociationSummary {
  id: string;
  code: string;
  name: string;
  region: string | null;
  status: string;
  charterVersion: string | null;
  zones: number;
  members: number;
  activeConsents: number;
}

export interface AssociationZoneView {
  id: string;
  associationId: string;
  code: string;
  name: string;
  region: string | null;
  parentZoneId: string | null;
  parentName: string | null;
  members: number;
}

export interface AssociationRoleView {
  id: string;
  associationId: string;
  zoneId: string | null;
  zoneName: string | null;
  userId: string;
  userName: string;
  role: AssociationRole;
  roleLabel: string;
  grantedAt: string;
  revokedAt: string | null;
  /** What the signed-in person may actually do, resolved by the server. */
  capabilities: { manageMembers: boolean; manageGovernance: boolean; manageRoles: boolean };
}

export interface AssociationConsentView {
  id: string;
  associationId: string;
  memberId: string | null;
  memberName: string | null;
  subjectType: AssociationConsentType;
  subjectLabel: string;
  grantedAt: string;
  expiresAt: string | null;
  withdrawnAt: string | null;
  active: boolean;
  documentRef: string | null;
  note: string | null;
}

export interface AssociationGovernanceView {
  associations: AssociationSummary[];
  zones: AssociationZoneView[];
  roles: AssociationRoleView[];
  consents: AssociationConsentView[];
  /** Roles this person holds, so the screen can hide what it cannot do. */
  myRoles: AssociationRole[];
  canManageMembers: boolean;
  canManageGovernance: boolean;
  canManageRoles: boolean;
  /** Consents that have lapsed or been withdrawn, kept visible for review. */
  lapsedConsents: number;
}

export interface GovernanceResponse {
  success: boolean;
  error?: string;
  data?: AssociationGovernanceView;
}

/** The active association roles the signed-in administrator holds. */
async function myAssociationRoles(
  tenantId: string,
  userId: string
): Promise<AssociationRole[]> {
  const rows = await db.associationRoleAssignment.findMany({
    where: { tenantId, userId, revokedAt: null },
    select: { role: true },
  });
  const roles: AssociationRole[] = [];
  for (const row of rows) {
    if (isAssociationRole(row.role) && !roles.includes(row.role)) roles.push(row.role);
  }
  return roles;
}

/**
 * Read the association picture.
 *
 * A business administrator keeps the access the existing register already had;
 * an association role adds nothing over money and only opens the governance
 * screens.
 */
export async function getAssociationGovernance(): Promise<GovernanceResponse> {
  const ctx = await requireTenantAdmin();
  const [associations, zones, roleRows, consentRows, myRoles] = await Promise.all([
    db.association.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: "asc" },
    }),
    db.associationZone.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { code: "asc" },
    }),
    db.associationRoleAssignment.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { grantedAt: "asc" },
    }),
    db.associationConsentRecord.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { grantedAt: "desc" },
      take: 200,
    }),
    myAssociationRoles(ctx.tenantId, ctx.userId),
  ]);

  const [memberCounts, zoneNames, users, members] = await Promise.all([
    db.associationMember.groupBy({
      by: ["associationId"],
      where: { tenantId: ctx.tenantId, associationId: { not: null } },
      _count: { _all: true },
    }),
    db.associationZone.findMany({
      where: { tenantId: ctx.tenantId },
      select: { id: true, name: true },
    }),
    db.user.findMany({
      where: {
        tenantId: ctx.tenantId,
        id: { in: roleRows.map((row) => row.userId) },
      },
      select: { id: true, fullName: true },
    }),
    db.associationMember.findMany({
      where: { tenantId: ctx.tenantId, id: { in: consentRows.map((row) => row.memberId ?? "") } },
      select: { id: true, businessName: true },
    }),
  ]);

  const zoneName = new Map(zoneNames.map((zone) => [zone.id, zone.name]));
  const userName = new Map(users.map((user) => [user.id, user.fullName]));
  const memberName = new Map(members.map((member) => [member.id, member.businessName]));
  const countFor = (associationId: string) =>
    memberCounts.find((row) => row.associationId === associationId)?._count._all ?? 0;

  const consents: AssociationConsentView[] = consentRows.map((row) => ({
    id: row.id,
    associationId: row.associationId,
    memberId: row.memberId,
    memberName: row.memberId ? memberName.get(row.memberId) ?? null : null,
    subjectType: row.subjectType as AssociationConsentType,
    subjectLabel:
      ASSOCIATION_CONSENT_LABELS[row.subjectType as AssociationConsentType] ??
      row.subjectType,
    grantedAt: row.grantedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    active: consentIsActive(row),
    documentRef: row.documentRef,
    note: row.note,
  }));

  return {
    success: true,
    data: {
      associations: associations.map((association) => ({
        id: association.id,
        code: association.code,
        name: association.name,
        region: association.region,
        status: association.status,
        charterVersion: association.charterVersion,
        zones: zones.filter((zone) => zone.associationId === association.id).length,
        members: countFor(association.id),
        activeConsents: consents.filter(
          (consent) => consent.associationId === association.id && consent.active
        ).length,
      })),
      zones: zones.map((zone) => ({
        id: zone.id,
        associationId: zone.associationId,
        code: zone.code,
        name: zone.name,
        region: zone.region,
        parentZoneId: zone.parentZoneId,
        parentName: zone.parentZoneId ? zoneName.get(zone.parentZoneId) ?? null : null,
        members: 0,
      })),
      roles: roleRows.map((row) => ({
        id: row.id,
        associationId: row.associationId,
        zoneId: row.zoneId,
        zoneName: row.zoneId ? zoneName.get(row.zoneId) ?? null : null,
        userId: row.userId,
        userName: userName.get(row.userId) ?? "Unknown user",
        role: row.role as AssociationRole,
        roleLabel: ASSOCIATION_ROLE_LABELS[row.role as AssociationRole] ?? row.role,
        grantedAt: row.grantedAt.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
        capabilities: capabilitySummary(row.role),
      })),
      consents,
      myRoles,
      canManageMembers: associationAllows(myRoles, "manageMembers"),
      canManageGovernance: associationAllows(myRoles, "manageGovernance"),
      canManageRoles: associationAllows(myRoles, "manageRoles"),
      lapsedConsents: consents.filter((consent) => !consent.active).length,
    },
  };
}

function capabilitySummary(role: string) {
  const parsed = isAssociationRole(role) ? role : null;
  return {
    manageMembers: parsed ? associationAllows([parsed], "manageMembers") : false,
    manageGovernance: parsed ? associationAllows([parsed], "manageGovernance") : false,
    manageRoles: parsed ? associationAllows([parsed], "manageRoles") : false,
  };
}

async function requireCapability(
  capability: AssociationCapability,
  opts: { allowTenantAdminFor?: AssociationCapability[] } = {}
): Promise<{ tenantId: string; userId: string; roles: AssociationRole[] }> {
  const ctx = await requireTenantAdmin();
  const roles = await myAssociationRoles(ctx.tenantId, ctx.userId);
  if (associationAllows(roles, capability)) return { ...ctx, roles };
  // A business administrator keeps the register they already had. That cover is
  // deliberately narrow: it never includes handing out association roles.
  if ((opts.allowTenantAdminFor ?? []).includes(capability)) {
    return { ...ctx, roles };
  }
  throw new Error(
    "Your association role does not allow this. Ask an association administrator."
  );
}

export async function createAssociation(input: {
  code: string;
  name: string;
  region?: string;
  charterVersion?: string;
  contactEmail?: string;
  contactPhone?: string;
}): Promise<GovernanceResponse> {
  let ctx: { tenantId: string; userId: string };
  try {
    // Creating the first association is how the roles come to exist, so the
    // business administrator may bootstrap it. Everything after this point is
    // gated by an association role.
    ctx = await requireCapability("manageGovernance", {
      allowTenantAdminFor: ["manageGovernance"],
    });
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
  const parsed = associationSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const values = parsed.data;
  const existing = await db.association.findFirst({
    where: { tenantId: ctx.tenantId, code: values.code },
    select: { id: true },
  });
  if (existing) {
    return { success: false, error: "An association with that code already exists." };
  }

  await db.$transaction(async (tx) => {
    const created = await tx.association.create({
      data: {
        tenantId: ctx.tenantId,
        code: values.code,
        name: values.name,
        region: values.region || null,
        charterVersion: values.charterVersion || null,
        contactEmail: values.contactEmail || null,
        contactPhone: values.contactPhone || null,
        createdById: ctx.userId,
      },
    });
    // The person who creates it must be able to run it, or the association would
    // be unreachable until someone else granted a role.
    await tx.associationRoleAssignment.create({
      data: {
        tenantId: ctx.tenantId,
        associationId: created.id,
        userId: ctx.userId,
        role: "association_admin",
        grantedById: ctx.userId,
        note: "Created the association.",
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "association.created",
      entityType: "association",
      entityId: created.id,
      details: { code: values.code, name: values.name, financialMutation: false },
    });
  });

  return getAssociationGovernance();
}

export async function createAssociationZone(input: {
  associationId: string;
  code: string;
  name: string;
  region?: string;
  parentZoneId?: string | null;
}): Promise<GovernanceResponse> {
  let ctx: { tenantId: string; userId: string };
  try {
    ctx = await requireCapability("manageGovernance");
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
  const parsed = associationZoneSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const values = parsed.data;
  const association = await db.association.findFirst({
    where: { id: values.associationId, tenantId: ctx.tenantId },
    select: { id: true },
  });
  if (!association) return { success: false, error: "That association was not found." };

  if (values.parentZoneId) {
    const parent = await db.associationZone.findFirst({
      where: {
        id: values.parentZoneId,
        tenantId: ctx.tenantId,
        associationId: values.associationId,
      },
      select: { id: true },
    });
    if (!parent) {
      return { success: false, error: "The parent zone is not in this association." };
    }
  }

  const duplicate = await db.associationZone.findFirst({
    where: { associationId: values.associationId, code: values.code },
    select: { id: true },
  });
  if (duplicate) return { success: false, error: "That zone code is already used." };

  await db.$transaction(async (tx) => {
    const zone = await tx.associationZone.create({
      data: {
        tenantId: ctx.tenantId,
        associationId: values.associationId,
        code: values.code,
        name: values.name,
        region: values.region || null,
        parentZoneId: values.parentZoneId || null,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "association.zone_created",
      entityType: "associationZone",
      entityId: zone.id,
      details: {
        associationId: values.associationId,
        code: values.code,
        parentZoneId: values.parentZoneId || null,
        financialMutation: false,
      },
    });
  });

  return getAssociationGovernance();
}

export async function assignAssociationRole(input: {
  associationId: string;
  zoneId?: string | null;
  userId: string;
  role: AssociationRole;
}): Promise<GovernanceResponse> {
  let ctx: { tenantId: string; userId: string };
  try {
    ctx = await requireCapability("manageRoles");
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
  const parsed = associationRoleSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const values = parsed.data;
  const [association, person, zone] = await Promise.all([
    db.association.findFirst({
      where: { id: values.associationId, tenantId: ctx.tenantId },
      select: { id: true },
    }),
    db.user.findFirst({
      where: { id: values.userId, tenantId: ctx.tenantId, status: "active" },
      select: { id: true, fullName: true },
    }),
    values.zoneId
      ? db.associationZone.findFirst({
          where: {
            id: values.zoneId,
            tenantId: ctx.tenantId,
            associationId: values.associationId,
          },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  if (!association) return { success: false, error: "That association was not found." };
  if (!person) return { success: false, error: "That person is not an active user here." };
  if (values.zoneId && !zone) {
    return { success: false, error: "The zone does not belong to this association." };
  }

  await db.$transaction(async (tx) => {
    const existing = await tx.associationRoleAssignment.findFirst({
      where: {
        associationId: values.associationId,
        userId: values.userId,
        role: values.role,
        revokedAt: null,
      },
      select: { id: true },
    });
    if (existing) return;
    await tx.associationRoleAssignment.create({
      data: {
        tenantId: ctx.tenantId,
        associationId: values.associationId,
        zoneId: values.zoneId || null,
        userId: values.userId,
        role: values.role,
        grantedById: ctx.userId,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "association.role_granted",
      entityType: "associationRoleAssignment",
      entityId: values.userId,
      details: {
        associationId: values.associationId,
        zoneId: values.zoneId || null,
        role: values.role,
        financialMutation: false,
      },
    });
  });

  return getAssociationGovernance();
}

/**
 * Remove a role.
 *
 * An association must keep at least one administrator; otherwise nobody could
 * grant the next one and the association would be locked.
 */
export async function revokeAssociationRole(input: {
  assignmentId: string;
}): Promise<GovernanceResponse> {
  let ctx: { tenantId: string; userId: string };
  try {
    ctx = await requireCapability("manageRoles");
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
  const row = await db.associationRoleAssignment.findFirst({
    where: { id: input.assignmentId, tenantId: ctx.tenantId, revokedAt: null },
  });
  if (!row) return { success: false, error: "That role was not found." };

  if (row.role === "association_admin") {
    const admins = await db.associationRoleAssignment.count({
      where: {
        associationId: row.associationId,
        role: "association_admin",
        revokedAt: null,
        tenantId: ctx.tenantId,
      },
    });
    if (admins <= 1) {
      return {
        success: false,
        error: "Keep at least one association administrator so the role can be granted again.",
      };
    }
  }

  await db.$transaction(async (tx) => {
    await tx.associationRoleAssignment.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "association.role_revoked",
      entityType: "associationRoleAssignment",
      entityId: row.userId,
      details: {
        associationId: row.associationId,
        role: row.role,
        financialMutation: false,
      },
    });
  });
  return getAssociationGovernance();
}

export async function recordAssociationConsent(input: {
  associationId: string;
  memberId?: string | null;
  subjectType: AssociationConsentType;
  expiresAt?: string;
  documentRef?: string;
  note?: string;
}): Promise<GovernanceResponse> {
  let ctx: { tenantId: string; userId: string };
  try {
    ctx = await requireCapability("manageGovernance");
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
  const parsed = associationConsentSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const values = parsed.data;
  const association = await db.association.findFirst({
    where: { id: values.associationId, tenantId: ctx.tenantId },
    select: { id: true },
  });
  if (!association) return { success: false, error: "That association was not found." };

  let expiresAt: Date | null = null;
  if (values.expiresAt) {
    const parsedDate = new Date(values.expiresAt);
    if (Number.isNaN(parsedDate.getTime())) {
      return { success: false, error: "The expiry date is invalid." };
    }
    if (parsedDate.getTime() <= Date.now()) {
      return { success: false, error: "The expiry date must be in the future." };
    }
    expiresAt = parsedDate;
  }
  if (values.memberId) {
    const member = await db.associationMember.findFirst({
      where: { id: values.memberId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!member) return { success: false, error: "That member was not found." };
  }

  await db.$transaction(async (tx) => {
    const record = await tx.associationConsentRecord.create({
      data: {
        tenantId: ctx.tenantId,
        associationId: values.associationId,
        memberId: values.memberId || null,
        subjectType: values.subjectType,
        grantedById: ctx.userId,
        expiresAt,
        documentRef: values.documentRef || null,
        note: values.note || null,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "association.consent_recorded",
      entityType: "associationConsentRecord",
      entityId: record.id,
      details: {
        associationId: values.associationId,
        subjectType: values.subjectType,
        expiresAt: expiresAt?.toISOString() ?? null,
        financialMutation: false,
      },
    });
  });

  return getAssociationGovernance();
}

export async function withdrawAssociationConsent(input: {
  consentId: string;
  note: string;
}): Promise<GovernanceResponse> {
  let ctx: { tenantId: string; userId: string };
  try {
    ctx = await requireCapability("manageGovernance");
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
  if (input.note.trim().length < 10) {
    return { success: false, error: "Say why the consent is being withdrawn (10 characters)." };
  }
  const row = await db.associationConsentRecord.findFirst({
    where: { id: input.consentId, tenantId: ctx.tenantId },
  });
  if (!row) return { success: false, error: "That consent record was not found." };
  if (row.withdrawnAt) return { success: false, error: "That consent is already withdrawn." };

  await db.$transaction(async (tx) => {
    await tx.associationConsentRecord.update({
      where: { id: row.id },
      data: { withdrawnAt: new Date(), note: input.note.trim() },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "association.consent_withdrawn",
      entityType: "associationConsentRecord",
      entityId: row.id,
      details: {
        subjectType: row.subjectType,
        note: input.note.trim(),
        financialMutation: false,
      },
    });
  });
  return getAssociationGovernance();
}

/**
 * Build one association report as CSV.
 *
 * Every row is tenant-scoped, so an export cannot carry another business's
 * members. Contacts are included because the association already holds them; the
 * file is generated on demand and never stored.
 */
export async function exportAssociationReport(
  type: AssociationExportType
): Promise<{ success: boolean; error?: string; csv?: string; filename?: string }> {
  const ctx = await requireTenantAdmin();
  if (!isAssociationExportType(type)) {
    return { success: false, error: "Choose a report to export." };
  }
  const stamp = new Date().toISOString().slice(0, 10);

  if (type === "members") {
    const rows = await db.associationMember.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { memberCode: "asc" },
    });
    const csv = buildCsv([
      ["Member code", "Business", "Contact", "Phone", "Email", "Region", "Status", "Joined"],
      ...rows.map((row) => [
        row.memberCode,
        row.businessName,
        row.contactName,
        row.phone ?? "",
        row.email ?? "",
        row.region ?? "",
        row.status,
        row.joinedAt ? row.joinedAt.toISOString().slice(0, 10) : "",
      ]),
    ]);
    return { success: true, csv, filename: `association-members-${stamp}.csv` };
  }

  if (type === "zones") {
    const rows = await db.associationZone.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { code: "asc" },
    });
    const names = new Map(rows.map((row) => [row.id, row.name]));
    const csv = buildCsv([
      ["Zone code", "Name", "Region", "Parent zone", "Status"],
      ...rows.map((row) => [
        row.code,
        row.name,
        row.region ?? "",
        row.parentZoneId ? names.get(row.parentZoneId) ?? "" : "",
        row.status,
      ]),
    ]);
    return { success: true, csv, filename: `association-zones-${stamp}.csv` };
  }

  if (type === "sponsorships") {
    const rows = await db.associationSponsorship.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: "asc" },
      include: { member: { select: { memberCode: true, businessName: true } } },
    });
    const csv = buildCsv([
      ["Member code", "Business", "Sponsor", "Plan", "Amount", "Currency", "Status", "Start", "End", "Reference"],
      ...rows.map((row) => [
        row.member.memberCode,
        row.member.businessName,
        row.sponsorName,
        row.planCode ?? "",
        Number(row.amount).toFixed(2),
        row.currency,
        row.status,
        row.startDate ? row.startDate.toISOString().slice(0, 10) : "",
        row.endDate ? row.endDate.toISOString().slice(0, 10) : "",
        row.reference ?? "",
      ]),
    ]);
    return { success: true, csv, filename: `association-sponsorships-${stamp}.csv` };
  }

  if (type === "training") {
    const rows = await db.associationTrainingRecord.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: "asc" },
      include: { member: { select: { memberCode: true, businessName: true } } },
    });
    const csv = buildCsv([
      ["Member code", "Business", "Training", "Provider", "Status", "Completed", "Expires", "Certificate"],
      ...rows.map((row) => [
        row.member.memberCode,
        row.member.businessName,
        row.title,
        row.provider ?? "",
        row.status,
        row.completedAt ? row.completedAt.toISOString().slice(0, 10) : "",
        row.expiresAt ? row.expiresAt.toISOString().slice(0, 10) : "",
        row.certificateReference ?? "",
      ]),
    ]);
    return { success: true, csv, filename: `association-training-${stamp}.csv` };
  }

  const rows = await db.associationConsentRecord.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { grantedAt: "desc" },
  });
  const memberIds = rows.map((row) => row.memberId ?? "");
  const members = await db.associationMember.findMany({
    where: { tenantId: ctx.tenantId, id: { in: memberIds } },
    select: { id: true, memberCode: true, businessName: true },
  });
  const memberMap = new Map(members.map((row) => [row.id, row]));
  const csv = buildCsv([
    ["Subject", "Member code", "Business", "Granted", "Expires", "Withdrawn", "Active", "Document", "Note"],
    ...rows.map((row) => {
      const member = row.memberId ? memberMap.get(row.memberId) : null;
      return [
        ASSOCIATION_CONSENT_LABELS[row.subjectType as AssociationConsentType] ?? row.subjectType,
        member?.memberCode ?? "",
        member?.businessName ?? "",
        row.grantedAt.toISOString().slice(0, 10),
        row.expiresAt ? row.expiresAt.toISOString().slice(0, 10) : "",
        row.withdrawnAt ? row.withdrawnAt.toISOString().slice(0, 10) : "",
        consentIsActive(row) ? "yes" : "no",
        row.documentRef ?? "",
        row.note ?? "",
      ];
    }),
  ]);
  return { success: true, csv, filename: `association-consent-${stamp}.csv` };
}
