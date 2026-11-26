"use server";

import { db } from "@/lib/db";
import { requireTenantAdmin } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import {
  ASSOCIATION_MEMBER_STATUS_LABELS,
  ASSOCIATION_SPONSORSHIP_STATUS_LABELS,
  ASSOCIATION_TRAINING_STATUS_LABELS,
  associationMemberSchema,
  associationMemberStatusSchema,
  associationSponsorshipSchema,
  associationSponsorshipStatusSchema,
  associationTrainingSchema,
  type AssociationMemberStatus,
  type AssociationSponsorshipStatus,
  type AssociationTrainingStatus,
} from "@/lib/association";

export interface AssociationActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface AssociationMemberView {
  id: string;
  memberCode: string;
  businessName: string;
  contactName: string;
  phone: string | null;
  email: string | null;
  region: string | null;
  status: AssociationMemberStatus;
  statusLabel: string;
  joinedAt: string | null;
  notes: string | null;
  sponsorshipCount: number;
  activeSponsorshipValue: number;
  trainingCount: number;
  createdAt: string;
}

export interface AssociationSponsorshipView {
  id: string;
  memberId: string;
  memberName: string;
  sponsorName: string;
  planCode: string | null;
  amount: number;
  currency: string;
  status: AssociationSponsorshipStatus;
  statusLabel: string;
  startDate: string | null;
  endDate: string | null;
  reference: string | null;
  notes: string | null;
  createdAt: string;
}

export interface AssociationTrainingView {
  id: string;
  memberId: string;
  memberName: string;
  title: string;
  provider: string | null;
  status: AssociationTrainingStatus;
  statusLabel: string;
  completedAt: string | null;
  expiresAt: string | null;
  certificateReference: string | null;
  notes: string | null;
  createdAt: string;
}

export interface AssociationDashboard {
  members: AssociationMemberView[];
  sponsorships: AssociationSponsorshipView[];
  trainings: AssociationTrainingView[];
  counts: {
    members: number;
    activeMembers: number;
    activeSponsorships: number;
    activeSponsorshipValue: number;
    completedTrainings: number;
    expiringTrainings: number;
  };
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

function revalidateAssociation() {
  revalidatePath("/admin/association");
}

export async function getAssociationDashboard(): Promise<AssociationDashboard> {
  const ctx = await requireTenantAdmin();
  const [members, sponsorships, trainings] = await Promise.all([
    db.associationMember.findMany({
      where: { tenantId: ctx.tenantId },
      include: {
        _count: { select: { sponsorships: true, trainings: true } },
        sponsorships: { where: { status: "active" }, select: { amount: true } },
      },
      orderBy: [{ status: "asc" }, { businessName: "asc" }],
      take: 300,
    }),
    db.associationSponsorship.findMany({
      where: { tenantId: ctx.tenantId },
      include: { member: { select: { businessName: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    db.associationTrainingRecord.findMany({
      where: { tenantId: ctx.tenantId },
      include: { member: { select: { businessName: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);

  const memberRows: AssociationMemberView[] = members.map((row) => ({
    id: row.id,
    memberCode: row.memberCode,
    businessName: row.businessName,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    region: row.region,
    status: row.status as AssociationMemberStatus,
    statusLabel:
      ASSOCIATION_MEMBER_STATUS_LABELS[row.status as AssociationMemberStatus] ?? row.status,
    joinedAt: row.joinedAt?.toISOString() ?? null,
    notes: row.notes,
    sponsorshipCount: row._count.sponsorships,
    activeSponsorshipValue: money(
      row.sponsorships.reduce((total, item) => total + Number(item.amount), 0)
    ),
    trainingCount: row._count.trainings,
    createdAt: row.createdAt.toISOString(),
  }));

  const sponsorshipRows: AssociationSponsorshipView[] = sponsorships.map((row) => ({
    id: row.id,
    memberId: row.memberId,
    memberName: row.member.businessName,
    sponsorName: row.sponsorName,
    planCode: row.planCode,
    amount: money(row.amount),
    currency: row.currency,
    status: row.status as AssociationSponsorshipStatus,
    statusLabel:
      ASSOCIATION_SPONSORSHIP_STATUS_LABELS[row.status as AssociationSponsorshipStatus] ??
      row.status,
    startDate: row.startDate?.toISOString() ?? null,
    endDate: row.endDate?.toISOString() ?? null,
    reference: row.reference,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  }));

  const trainingRows: AssociationTrainingView[] = trainings.map((row) => ({
    id: row.id,
    memberId: row.memberId,
    memberName: row.member.businessName,
    title: row.title,
    provider: row.provider,
    status: row.status as AssociationTrainingStatus,
    statusLabel:
      ASSOCIATION_TRAINING_STATUS_LABELS[row.status as AssociationTrainingStatus] ?? row.status,
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    certificateReference: row.certificateReference,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  }));

  const now = Date.now();
  const inNinetyDays = now + 90 * 24 * 60 * 60 * 1000;
  return {
    members: memberRows,
    sponsorships: sponsorshipRows,
    trainings: trainingRows,
    counts: {
      members: members.length,
      activeMembers: members.filter((row) => row.status === "active").length,
      activeSponsorships: sponsorships.filter((row) => row.status === "active").length,
      activeSponsorshipValue: money(
        sponsorships
          .filter((row) => row.status === "active")
          .reduce((total, row) => total + Number(row.amount), 0)
      ),
      completedTrainings: trainings.filter((row) => row.status === "completed").length,
      expiringTrainings: trainings.filter(
        (row) =>
          row.status === "completed" &&
          row.expiresAt !== null &&
          row.expiresAt.getTime() >= now &&
          row.expiresAt.getTime() <= inNinetyDays
      ).length,
    },
  };
}

export async function createAssociationMember(input: {
  memberCode: string;
  businessName: string;
  contactName: string;
  phone?: string;
  email?: string;
  region?: string;
  status?: string;
  joinedAt?: string;
  notes?: string;
}): Promise<AssociationActionResponse> {
  const ctx = await requireTenantAdmin();
  const parsed = associationMemberSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message };
  const values = parsed.data;

  try {
    const member = await db.$transaction(async (tx) => {
      const created = await tx.associationMember.create({
        data: {
          tenantId: ctx.tenantId,
          memberCode: values.memberCode,
          businessName: values.businessName,
          contactName: values.contactName,
          phone: values.phone?.trim() || null,
          email: values.email?.trim() || null,
          region: values.region?.trim() || null,
          status: values.status,
          joinedAt: values.joinedAt ? new Date(values.joinedAt) : null,
          notes: values.notes?.trim() || null,
          createdById: ctx.userId,
        },
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "association.member_created",
        entityType: "associationMember",
        entityId: created.id,
        details: {
          memberCode: created.memberCode,
          businessName: created.businessName,
          status: created.status,
          financialMutation: false,
        },
      });
      return created;
    });
    revalidateAssociation();
    return { success: true, data: { memberId: member.id } };
  } catch (error) {
    if (uniqueViolation(error)) {
      return { success: false, error: "That member code or phone number is already registered." };
    }
    return { success: false, error: "The member could not be registered." };
  }
}

export async function updateAssociationMemberStatus(input: {
  memberId: string;
  status: string;
}): Promise<AssociationActionResponse> {
  const ctx = await requireTenantAdmin();
  const parsed = associationMemberStatusSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message };
  const values = parsed.data;
  const existing = await db.associationMember.findFirst({
    where: { id: values.memberId, tenantId: ctx.tenantId },
  });
  if (!existing) return { success: false, error: "Member not found." };

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.associationMember.updateMany({
        where: { id: existing.id, tenantId: ctx.tenantId, status: existing.status },
        data: { status: values.status },
      });
      if (updated.count !== 1) throw new Error("ASSOCIATION_CONFLICT");
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "association.member_status_changed",
        entityType: "associationMember",
        entityId: existing.id,
        details: {
          memberCode: existing.memberCode,
          from: existing.status,
          to: values.status,
          financialMutation: false,
        },
      });
    });
    revalidateAssociation();
    return { success: true };
  } catch {
    return { success: false, error: "The member status could not be updated." };
  }
}

export async function createAssociationSponsorship(input: {
  memberId: string;
  sponsorName: string;
  planCode?: string;
  amount: number;
  status?: string;
  startDate?: string;
  endDate?: string;
  reference?: string;
  notes?: string;
}): Promise<AssociationActionResponse> {
  const ctx = await requireTenantAdmin();
  const parsed = associationSponsorshipSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message };
  const values = parsed.data;
  const member = await db.associationMember.findFirst({
    where: { id: values.memberId, tenantId: ctx.tenantId },
    select: { id: true, memberCode: true },
  });
  if (!member) return { success: false, error: "Choose a member in your association." };

  try {
    const row = await db.$transaction(async (tx) => {
      const created = await tx.associationSponsorship.create({
        data: {
          tenantId: ctx.tenantId,
          memberId: member.id,
          sponsorName: values.sponsorName,
          planCode: values.planCode?.trim() || null,
          amount: values.amount,
          status: values.status,
          startDate: values.startDate ? new Date(values.startDate) : null,
          endDate: values.endDate ? new Date(values.endDate) : null,
          reference: values.reference?.trim() || null,
          notes: values.notes?.trim() || null,
          createdById: ctx.userId,
        },
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "association.sponsorship_recorded",
        entityType: "associationSponsorship",
        entityId: created.id,
        details: {
          memberId: member.id,
          memberCode: member.memberCode,
          sponsorName: created.sponsorName,
          amount: money(created.amount),
          status: created.status,
          financialMutation: false,
        },
      });
      return created;
    });
    revalidateAssociation();
    return { success: true, data: { sponsorshipId: row.id } };
  } catch (error) {
    if (uniqueViolation(error)) {
      return { success: false, error: "That sponsorship reference is already recorded." };
    }
    return { success: false, error: "The sponsorship could not be recorded." };
  }
}

export async function updateAssociationSponsorshipStatus(input: {
  sponsorshipId: string;
  status: string;
}): Promise<AssociationActionResponse> {
  const ctx = await requireTenantAdmin();
  const parsed = associationSponsorshipStatusSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message };
  const values = parsed.data;
  const existing = await db.associationSponsorship.findFirst({
    where: { id: values.sponsorshipId, tenantId: ctx.tenantId },
  });
  if (!existing) return { success: false, error: "Sponsorship not found." };

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.associationSponsorship.updateMany({
        where: { id: existing.id, tenantId: ctx.tenantId, status: existing.status },
        data: { status: values.status },
      });
      if (updated.count !== 1) throw new Error("ASSOCIATION_CONFLICT");
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "association.sponsorship_status_changed",
        entityType: "associationSponsorship",
        entityId: existing.id,
        details: { from: existing.status, to: values.status, financialMutation: false },
      });
    });
    revalidateAssociation();
    return { success: true };
  } catch {
    return { success: false, error: "The sponsorship status could not be updated." };
  }
}

export async function createAssociationTraining(input: {
  memberId: string;
  title: string;
  provider?: string;
  status?: string;
  completedAt?: string;
  expiresAt?: string;
  certificateReference?: string;
  notes?: string;
}): Promise<AssociationActionResponse> {
  const ctx = await requireTenantAdmin();
  const parsed = associationTrainingSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message };
  const values = parsed.data;
  const member = await db.associationMember.findFirst({
    where: { id: values.memberId, tenantId: ctx.tenantId },
    select: { id: true, memberCode: true },
  });
  if (!member) return { success: false, error: "Choose a member in your association." };

  try {
    const row = await db.$transaction(async (tx) => {
      const created = await tx.associationTrainingRecord.create({
        data: {
          tenantId: ctx.tenantId,
          memberId: member.id,
          title: values.title,
          provider: values.provider?.trim() || null,
          status: values.status,
          completedAt: values.completedAt ? new Date(values.completedAt) : null,
          expiresAt: values.expiresAt ? new Date(values.expiresAt) : null,
          certificateReference: values.certificateReference?.trim() || null,
          notes: values.notes?.trim() || null,
          createdById: ctx.userId,
        },
      });
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "association.training_recorded",
        entityType: "associationTrainingRecord",
        entityId: created.id,
        details: {
          memberId: member.id,
          memberCode: member.memberCode,
          title: created.title,
          status: created.status,
          financialMutation: false,
        },
      });
      return created;
    });
    revalidateAssociation();
    return { success: true, data: { trainingId: row.id } };
  } catch {
    return { success: false, error: "The training record could not be saved." };
  }
}
