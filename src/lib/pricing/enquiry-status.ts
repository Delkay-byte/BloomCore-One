/**
 * Account-enquiry status vocabulary.
 *
 * Plain module: a `"use server"` file may only export async functions, so the
 * shared constants and types live here.
 */

export const ENQUIRY_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "converted",
  "rejected",
] as const;

export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export type EnquiryType = "ACCOUNT_REQUEST" | "DEMO_REQUEST";

export interface EnquiryRow {
  id: string;
  businessName: string;
  contactName: string;
  phone: string;
  email: string | null;
  locationCount: number | null;
  interestedPlan: string | null;
  message: string | null;
  status: string;
  enquiryType: string;
  modules: string | null;
  createdAt: string;
}
