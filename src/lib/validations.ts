import { z } from "zod";
import { expenseLinesSchema } from "@/lib/expense-lines";

export const loginSchema = z.object({
  email: z.string().min(1, "Email is required").email("Please enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
      .regex(/[0-9]/, "Password must contain at least one number"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

export const locationSchema = z.object({
  name: z.string().min(2, "Location name must be at least 2 characters").max(100),
  code: z
    .string()
    .min(2, "Location code must be at least 2 characters")
    .max(20)
    .regex(/^[A-Z0-9_-]+$/i, "Code must contain only letters, numbers, hyphens, or underscores"),
  description: z.string().max(500).optional(),
  address: z.string().max(500).optional(),
  contactPhone: z.string().max(20).optional(),
  status: z.enum(["active", "inactive"]).default("active"),
});

export const createWorkerSchema = z.object({
  fullName: z.string().min(2, "Full name must be at least 2 characters").max(100),
  email: z.string().email("Please enter a valid email"),
  phone: z.string().max(20).optional(),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[0-9]/, "Password must contain at least one number"),
  locationId: z.string().min(1, "Please select a location"),
  status: z.enum(["active", "inactive"]).default("active"),
});

export const editWorkerSchema = z.object({
  fullName: z.string().min(2, "Full name must be at least 2 characters").max(100),
  email: z.string().email("Please enter a valid email"),
  phone: z.string().max(20).optional(),
  locationId: z.string().min(1, "Please select a location"),
  status: z.enum(["active", "inactive"]),
});

export const createStaffSchema = z.object({
  fullName: z.string().min(2, "Full name must be at least 2 characters").max(100),
  email: z.string().email("Please enter a valid email"),
  phone: z.string().max(20).optional(),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[0-9]/, "Password must contain at least one number"),
  role: z.enum(["worker", "collector"]),
  status: z.enum(["active", "inactive"]).default("active"),
});

export const expenseSchema = z.object({
  description: z.string().min(1, "Description is required").max(200),
  amount: z.number().min(0.01, "Amount must be greater than 0").max(999999.99),
});

const positiveDecimal = z.number().min(0, "Value cannot be negative").max(999999.99, "Value is too large");

export const dailyAccountSchema = z.object({
  businessDate: z.string().min(1, "Business date is required"),
  openingMomoFloat: positiveDecimal,
  openingCash: positiveDecimal,
  additionalCashReceived: positiveDecimal.optional(),
  additionalMomoFloat: positiveDecimal.optional(),
  totalCashIn: positiveDecimal,
  totalCashOut: positiveDecimal,
  totalAirtimeSold: positiveDecimal.optional(),
  // Retired duplicate fields. Accepted only so historical correction payloads
  // stay parseable; they never enter the corrected formula.
  totalCashReceived: positiveDecimal.optional(),
  totalCashPaid: positiveDecimal.optional(),
  commission: positiveDecimal,
  debtsCollected: positiveDecimal.optional(),
  otherIncome: positiveDecimal.optional(),
  reconciliationNote: z.string().max(500).optional(),
  closingMomoFloat: positiveDecimal,
  closingCash: positiveDecimal,
  expenses: expenseLinesSchema.optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type LocationInput = z.infer<typeof locationSchema>;
export type CreateWorkerInput = z.infer<typeof createWorkerSchema>;
export type EditWorkerInput = z.infer<typeof editWorkerSchema>;
export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type DailyAccountInput = z.infer<typeof dailyAccountSchema>;
export type ExpenseInput = z.infer<typeof expenseSchema>;
