/**
 * Branch opening/closing liquidity — domain rules.
 *
 * A liquidity snapshot answers one question per asset: what did we declare at
 * the start of the day, what should that have become after the branch's own
 * transfers, and what was actually counted at the end?
 *
 * Three figures are always kept apart and are never collapsed into one:
 *   declared   openingDeclared
 *   adjusted   openingDeclared + transferAdjustment
 *   counted    countedClose
 *
 * Every number is an INTERNAL position. A declared float is an operator
 * declaration, never a provider-confirmed balance, and the labels say so.
 *
 * All money here is integer pesewa.
 */

import { z } from "zod";
import {
  BRANCH_ASSET_DEFINITIONS,
  BRANCH_ASSET_TYPES,
  type BranchAssetType,
} from "./branch-transfers";

export const LIQUIDITY_STATUSES = ["draft", "submitted", "reviewed"] as const;
export type LiquidityStatus = (typeof LIQUIDITY_STATUSES)[number];

export const LIQUIDITY_STATUS_LABELS: Record<LiquidityStatus, string> = {
  draft: "Draft",
  submitted: "Submitted — awaiting review",
  reviewed: "Reviewed",
};

const LIQUIDITY_TRANSITIONS: Record<LiquidityStatus, LiquidityStatus[]> = {
  draft: ["submitted"],
  submitted: ["reviewed", "draft"],
  reviewed: [],
};

export function canTransitionLiquidity(from: string, to: string): boolean {
  return (LIQUIDITY_TRANSITIONS[from as LiquidityStatus] ?? []).includes(to as LiquidityStatus);
}

export interface LiquidityLineInput {
  assetType: BranchAssetType;
  openingDeclaredMinor: number;
  transferAdjustmentMinor: number;
  countedCloseMinor: number;
  note?: string | null;
}

export interface LiquidityLineResult {
  assetType: BranchAssetType;
  label: string;
  network: string;
  kind: "cash" | "float";
  openingDeclaredMinor: number;
  transferAdjustmentMinor: number;
  expectedCloseMinor: number;
  countedCloseMinor: number;
  varianceMinor: number;
  /** Short | Over | Balanced */
  state: "short" | "over" | "balanced";
  note: string | null;
}

export function computeLiquidityLine(input: LiquidityLineInput): LiquidityLineResult {
  const definition = BRANCH_ASSET_DEFINITIONS[input.assetType];
  const opening = Math.trunc(input.openingDeclaredMinor);
  const adjustment = Math.trunc(input.transferAdjustmentMinor);
  const counted = Math.trunc(input.countedCloseMinor);
  const expected = opening + adjustment;
  const variance = counted - expected;
  return {
    assetType: input.assetType,
    label: definition.shortLabel,
    network: definition.network,
    kind: definition.kind,
    openingDeclaredMinor: opening,
    transferAdjustmentMinor: adjustment,
    expectedCloseMinor: expected,
    countedCloseMinor: counted,
    varianceMinor: variance,
    state: variance === 0 ? "balanced" : variance < 0 ? "short" : "over",
    note: input.note?.trim() ? input.note.trim() : null,
  };
}

export interface LiquiditySnapshotResult {
  lines: LiquidityLineResult[];
  openingTotalMinor: number;
  expectedTotalMinor: number;
  countedTotalMinor: number;
  varianceTotalMinor: number;
  cashVarianceMinor: number;
  floatVarianceMinor: number;
  shortLines: number;
  balanced: boolean;
  /** True when any line is short. A short line always needs an explanation. */
  requiresExplanation: boolean;
}

export function summariseLiquidity(lines: LiquidityLineResult[]): LiquiditySnapshotResult {
  let openingTotalMinor = 0;
  let expectedTotalMinor = 0;
  let countedTotalMinor = 0;
  let cashVarianceMinor = 0;
  let floatVarianceMinor = 0;
  let shortLines = 0;

  for (const line of lines) {
    openingTotalMinor += line.openingDeclaredMinor;
    expectedTotalMinor += line.expectedCloseMinor;
    countedTotalMinor += line.countedCloseMinor;
    if (line.kind === "cash") cashVarianceMinor += line.varianceMinor;
    else floatVarianceMinor += line.varianceMinor;
    if (line.state === "short") shortLines += 1;
  }

  const varianceTotalMinor = countedTotalMinor - expectedTotalMinor;
  return {
    lines,
    openingTotalMinor,
    expectedTotalMinor,
    countedTotalMinor,
    varianceTotalMinor,
    cashVarianceMinor,
    floatVarianceMinor,
    shortLines,
    balanced: varianceTotalMinor === 0 && shortLines === 0,
    requiresExplanation: shortLines > 0,
  };
}

const minorSchema = z
  .number()
  .int("Enter a whole number of pesewa.")
  .min(0, "A counted balance cannot be negative.")
  .max(99_999_999_999, "The amount is too large.");

export const branchLiquidityLineSchema = z.object({
  assetType: z.enum(BRANCH_ASSET_TYPES),
  openingDeclaredMinor: minorSchema,
  countedCloseMinor: minorSchema,
  note: z.string().trim().max(300).optional(),
});

export const branchLiquiditySnapshotSchema = z
  .object({
    locationId: z.string().trim().min(1, "Choose a branch."),
    businessDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the business date."),
    dailyAccountId: z.string().trim().min(1).optional(),
    note: z.string().trim().max(500).optional(),
    lines: z.array(branchLiquidityLineSchema).min(1, "Enter at least one asset."),
  })
  .refine(
    (value) => new Set(value.lines.map((line) => line.assetType)).size === value.lines.length,
    { message: "Each asset may appear only once.", path: ["lines"] }
  )
  .refine(
    (value) =>
      value.lines.every((line) => {
        // A short line must be explained. A surplus does not need one because it
        // does not represent missing business money.
        const expected = line.openingDeclaredMinor;
        return line.countedCloseMinor >= expected || (line.note?.trim().length ?? 0) >= 10;
      }),
    {
      message:
        "Every asset counted below its opening declaration needs an explanation of at least 10 characters.",
      path: ["lines"],
    }
  );

export type BranchLiquiditySnapshotInput = z.infer<typeof branchLiquiditySnapshotSchema>;

/** Convert a cedi input to integer pesewa without floating-point drift. */
export function cediToMinor(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

export function minorToCedi(minor: number): number {
  return Math.round(minor) / 100;
}

export const LIQUIDITY_DISCLAIMER =
  "Declared float balances are operator declarations, not provider-confirmed network balances.";
