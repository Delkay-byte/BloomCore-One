/**
 * Association membership, sponsorship and training rules.
 *
 * These records are administrative. A sponsorship is an agreement snapshot,
 * never a payment instruction, and a training record does not grant a licence.
 * Nothing here writes a contribution, withdrawal, MoMo ledger row or balance.
 */

import { z } from "zod";
import { hasCurrencyPrecision } from "./expense-lines";

export const ASSOCIATION_MEMBER_STATUSES = [
  "invited",
  "active",
  "suspended",
  "withdrawn",
] as const;
export type AssociationMemberStatus = (typeof ASSOCIATION_MEMBER_STATUSES)[number];

export const ASSOCIATION_MEMBER_STATUS_LABELS: Record<AssociationMemberStatus, string> = {
  invited: "Invited",
  active: "Active",
  suspended: "Suspended",
  withdrawn: "Withdrawn",
};

export const ASSOCIATION_SPONSORSHIP_STATUSES = [
  "pledged",
  "active",
  "ended",
  "cancelled",
] as const;
export type AssociationSponsorshipStatus =
  (typeof ASSOCIATION_SPONSORSHIP_STATUSES)[number];

export const ASSOCIATION_SPONSORSHIP_STATUS_LABELS: Record<
  AssociationSponsorshipStatus,
  string
> = {
  pledged: "Pledged",
  active: "Active",
  ended: "Ended",
  cancelled: "Cancelled",
};

export const ASSOCIATION_TRAINING_STATUSES = [
  "scheduled",
  "completed",
  "expired",
  "cancelled",
] as const;
export type AssociationTrainingStatus = (typeof ASSOCIATION_TRAINING_STATUSES)[number];

export const ASSOCIATION_TRAINING_STATUS_LABELS: Record<AssociationTrainingStatus, string> = {
  scheduled: "Scheduled",
  completed: "Completed",
  expired: "Expired",
  cancelled: "Cancelled",
};

const optionalText = (max: number) =>
  z.string().trim().max(max).optional().or(z.literal(""));

const isoDate = (label: string) =>
  z
    .string()
    .trim()
    .refine((value) => !value || !Number.isNaN(new Date(value).getTime()), `${label} is invalid.`)
    .optional();

export const associationMemberSchema = z.object({
  memberCode: z
    .string()
    .trim()
    .min(2, "Enter a member code of at least 2 characters.")
    .max(30, "Member code must be 30 characters or fewer.")
    .regex(/^[A-Za-z0-9._/-]+$/, "Use letters, numbers, dot, slash, dash or underscore."),
  businessName: z.string().trim().min(2, "Enter the member business name.").max(120),
  contactName: z.string().trim().min(2, "Enter the contact person.").max(120),
  phone: optionalText(30),
  email: z.union([z.string().trim().email("Enter a valid email.").max(160), z.literal("")]).optional(),
  region: optionalText(60),
  status: z.enum(ASSOCIATION_MEMBER_STATUSES).default("active"),
  joinedAt: isoDate("Join date"),
  notes: optionalText(500),
});

export const associationSponsorshipSchema = z
  .object({
    memberId: z.string().min(1, "Choose a member."),
    sponsorName: z.string().trim().min(2, "Enter the sponsor.").max(120),
    planCode: optionalText(40),
    amount: z
      .number()
      .finite("Amount must be a number.")
      .min(0, "Amount cannot be negative.")
      .max(999_999_999.99)
      .refine(hasCurrencyPrecision, "Amount must use no more than two decimal places."),
    status: z.enum(ASSOCIATION_SPONSORSHIP_STATUSES).default("pledged"),
    startDate: isoDate("Start date"),
    endDate: isoDate("End date"),
    reference: optionalText(64),
    notes: optionalText(500),
  })
  .superRefine((value, ctx) => {
    if (value.startDate && value.endDate && new Date(value.endDate) < new Date(value.startDate)) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "The end date cannot be before the start date.",
      });
    }
  });

export const associationTrainingSchema = z
  .object({
    memberId: z.string().min(1, "Choose a member."),
    title: z.string().trim().min(2, "Enter the training title.").max(120),
    provider: optionalText(120),
    status: z.enum(ASSOCIATION_TRAINING_STATUSES).default("completed"),
    completedAt: isoDate("Completion date"),
    expiresAt: isoDate("Expiry date"),
    certificateReference: optionalText(120),
    notes: optionalText(500),
  })
  .superRefine((value, ctx) => {
    if (
      value.completedAt &&
      value.expiresAt &&
      new Date(value.expiresAt) < new Date(value.completedAt)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Expiry cannot be before completion.",
      });
    }
  });

export const associationMemberStatusSchema = z.object({
  memberId: z.string().min(1),
  status: z.enum(ASSOCIATION_MEMBER_STATUSES),
});

export const associationSponsorshipStatusSchema = z.object({
  sponsorshipId: z.string().min(1),
  status: z.enum(ASSOCIATION_SPONSORSHIP_STATUSES),
});

export function isMemberStatus(value: string): value is AssociationMemberStatus {
  return (ASSOCIATION_MEMBER_STATUSES as readonly string[]).includes(value);
}
