/**
 * Internal cash and declared network float — domain rules.
 *
 * These are INTERNAL positions. A declared balance is an operator declaration,
 * never a telco or aggregator confirmation. The system clearly labels every
 * figure as `manual_declaration`, `declaration_plus_transfers` or
 * `no_declared_balance`, and never calls a declared figure "real-time".
 *
 * Transfers move value between two of the business's own locations, so a
 * transfer never increases the total business position; it only changes where
 * the money is declared to be.
 */

import { z } from "zod";
import { hasCurrencyPrecision } from "./expense-lines";

export const BRANCH_ASSET_TYPES = [
  "cash",
  "mtn_float",
  "telecel_float",
  "at_money_float",
] as const;
export type BranchAssetType = (typeof BRANCH_ASSET_TYPES)[number];

export interface BranchAssetDefinition {
  label: string;
  shortLabel: string;
  kind: "cash" | "float";
  network: "mtn" | "telecel" | "at_money" | "none";
  help: string;
}

export const BRANCH_ASSET_DEFINITIONS: Record<BranchAssetType, BranchAssetDefinition> = {
  cash: {
    label: "Physical cash",
    shortLabel: "Cash",
    kind: "cash",
    network: "none",
    help: "Counted physical business cash held at this location.",
  },
  mtn_float: {
    label: "MTN MoMo float (declared)",
    shortLabel: "MTN float",
    kind: "float",
    network: "mtn",
    help: "The MTN MoMo float you last declared for this location. Not a real-time network balance.",
  },
  telecel_float: {
    label: "Telecel Cash float (declared)",
    shortLabel: "Telecel float",
    kind: "float",
    network: "telecel",
    help: "The Telecel Cash float you last declared for this location. Not a real-time network balance.",
  },
  at_money_float: {
    label: "AT Money float (declared)",
    shortLabel: "AT float",
    kind: "float",
    network: "at_money",
    help: "The AT Money float you last declared for this location. Not a real-time network balance.",
  },
};

export function isBranchAssetType(value: unknown): value is BranchAssetType {
  return typeof value === "string" && (BRANCH_ASSET_TYPES as readonly string[]).includes(value);
}

export function assetDefinition(asset: BranchAssetType): BranchAssetDefinition {
  return BRANCH_ASSET_DEFINITIONS[asset];
}

export function networkForAsset(asset: BranchAssetType): string {
  return assetDefinition(asset).network;
}

export const BRANCH_TRANSFER_STATUSES = [
  "draft",
  "requested",
  "approved",
  "dispatched",
  "received",
  "completed",
  "rejected",
  "cancelled",
  "disputed",
  "variance_investigation",
] as const;
export type BranchTransferStatus = (typeof BRANCH_TRANSFER_STATUSES)[number];

export const TRANSFER_STATUS_LABELS: Record<BranchTransferStatus, string> = {
  draft: "Draft",
  requested: "Awaiting approval",
  approved: "Approved — awaiting dispatch",
  dispatched: "In transit — awaiting receipt",
  received: "Received",
  completed: "Completed",
  rejected: "Rejected",
  cancelled: "Cancelled",
  disputed: "Disputed",
  variance_investigation: "Variance investigation",
};

export const TRANSFER_STATUS_TONES: Record<
  BranchTransferStatus,
  "neutral" | "attention" | "positive" | "critical"
> = {
  draft: "neutral",
  requested: "attention",
  approved: "attention",
  dispatched: "attention",
  received: "positive",
  completed: "positive",
  rejected: "neutral",
  cancelled: "neutral",
  disputed: "critical",
  variance_investigation: "critical",
};

const TRANSITIONS: Record<BranchTransferStatus, BranchTransferStatus[]> = {
  draft: ["requested", "cancelled"],
  requested: ["approved", "rejected", "cancelled", "disputed"],
  approved: ["dispatched", "cancelled", "rejected"],
  dispatched: ["received", "completed", "disputed", "variance_investigation"],
  received: ["completed", "variance_investigation"],
  completed: [],
  rejected: [],
  cancelled: [],
  disputed: ["completed", "variance_investigation", "cancelled"],
  variance_investigation: ["completed", "disputed"],
};

export function canTransition(
  from: BranchTransferStatus,
  to: BranchTransferStatus
): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function isOpenTransfer(status: string): boolean {
  return status === "requested" || status === "approved" || status === "dispatched";
}

export function isTerminalTransfer(status: string): boolean {
  return status === "completed" || status === "rejected" || status === "cancelled";
}

/** Statuses whose dispatched value has definitely left the source location. */
const OUTBOUND_EFFECTIVE = new Set([
  "dispatched",
  "received",
  "completed",
  "disputed",
  "variance_investigation",
]);
/** Statuses whose received value has definitely reached the destination. */
const INBOUND_EFFECTIVE = new Set([
  "received",
  "completed",
  "disputed",
  "variance_investigation",
]);

/** Exposed for the daily liquidity snapshot, which must use the same rules. */
export function isOutboundEffective(status: string): boolean {
  return OUTBOUND_EFFECTIVE.has(status);
}

export function isInboundEffective(status: string): boolean {
  return INBOUND_EFFECTIVE.has(status);
}

export interface TransferBalanceRow {
  id: string;
  assetType: string;
  amount: unknown;
  actualAmountReceived?: unknown;
  status: string;
  sourceLocationId: string;
  destinationLocationId: string;
  createdAt: Date;
  dispatchedAt: Date | null;
  receivedAt: Date | null;
}

function money(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const rounded = Math.round((parsed + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function notBefore(date: Date | null | undefined, baseline: Date | null): boolean {
  if (!baseline) return true;
  if (!date) return true;
  return date.getTime() >= baseline.getTime();
}

export interface TransferAdjustment {
  /** Reserved or already dispatched value leaving the source. */
  outbound: number;
  /** Value actually received at the destination after the declaration baseline. */
  inbound: number;
  net: number;
}

/**
 * Apply transfer movements to one declared snapshot.
 *
 * The declared balance is the baseline. A transfer is applied only when the
 * event that moves value happened at or after `declaredAt`, so a fresh
 * declaration is not reduced twice by transfers the operator already counted.
 */
export function transferAdjustmentFor(input: {
  rows: TransferBalanceRow[];
  locationId: string;
  assetType: BranchAssetType;
  declaredAt: Date | null;
}): TransferAdjustment {
  let outbound = 0;
  let inbound = 0;

  for (const row of input.rows) {
    if (row.assetType !== input.assetType) continue;
    const amount = Math.abs(money(row.amount));
    const actual = money(row.actualAmountReceived ?? row.amount);

    if (row.sourceLocationId === input.locationId) {
      const moment =
        row.dispatchedAt ?? row.receivedAt ?? (OUTBOUND_EFFECTIVE.has(row.status) ? row.createdAt : null);
      if (row.status === "requested" || row.status === "approved") {
        if (notBefore(row.createdAt, input.declaredAt)) outbound += amount;
      } else if (OUTBOUND_EFFECTIVE.has(row.status) && notBefore(moment, input.declaredAt)) {
        outbound += amount;
      }
    }

    if (
      row.destinationLocationId === input.locationId &&
      INBOUND_EFFECTIVE.has(row.status) &&
      notBefore(row.receivedAt, input.declaredAt)
    ) {
      inbound += actual;
    }
  }

  const out = money(outbound);
  const into = money(inbound);
  return { outbound: out, inbound: into, net: money(into - out) };
}

export type BalanceSource =
  | "manual_declaration"
  | "declaration_plus_transfers"
  | "no_declared_balance";

export interface AssetPosition {
  assetType: BranchAssetType;
  label: string;
  network: string;
  kind: "cash" | "float";
  declared: number | null;
  declaredAt: string | null;
  declaredById: string | null;
  adjustment: number;
  effective: number | null;
  source: BalanceSource;
}

export interface LocationPosition {
  locationId: string;
  locationName: string;
  locationCode: string;
  assets: AssetPosition[];
  cashTotal: number | null;
  floatTotal: number | null;
}

export function assetPosition(input: {
  assetType: BranchAssetType;
  declared: { balance: unknown; declaredAt: Date; declaredById: string | null } | null;
  rows: TransferBalanceRow[];
  locationId: string;
}): AssetPosition {
  const definition = assetDefinition(input.assetType);
  if (!input.declared) {
    return {
      assetType: input.assetType,
      label: definition.shortLabel,
      network: definition.network,
      kind: definition.kind,
      declared: null,
      declaredAt: null,
      declaredById: null,
      adjustment: 0,
      effective: null,
      source: "no_declared_balance",
    };
  }
  const adjustment = transferAdjustmentFor({
    rows: input.rows,
    locationId: input.locationId,
    assetType: input.assetType,
    declaredAt: input.declared.declaredAt,
  });
  const declared = money(input.declared.balance);
  return {
    assetType: input.assetType,
    label: definition.shortLabel,
    network: definition.network,
    kind: definition.kind,
    declared,
    declaredAt: input.declared.declaredAt.toISOString(),
    declaredById: input.declared.declaredById,
    adjustment: adjustment.net,
    effective: money(declared + adjustment.net),
    source: adjustment.net === 0 ? "manual_declaration" : "declaration_plus_transfers",
  };
}

// ---------------------------------------------------------------------------
// Partial settlement
// ---------------------------------------------------------------------------

export const SETTLEMENT_STATUSES = ["full", "partial_open", "partial_settled", "written_back"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const SETTLEMENT_STATUS_LABELS: Record<SettlementStatus, string> = {
  full: "Full receipt",
  partial_open: "Partial receipt — balance outstanding",
  partial_settled: "Partial receipt — balance settled by follow-up",
  written_back: "Partial receipt — balance written back",
};

/**
 * Decide how a short receipt is settled.
 *
 * A partial receipt never silently reduces the transfer. The original
 * dispatched `amount` stays unchanged, the accepted value is recorded as
 * `settledAmount`, and the remainder is either carried into a follow-up
 * transfer or explicitly written back with a reason. Integer pesewa only.
 */
export function planPartialSettlement(input: {
  dispatchedMinor: number;
  receivedMinor: number;
}): {
  settledMinor: number;
  outstandingMinor: number;
  varianceMinor: number;
  status: SettlementStatus;
} {
  const dispatched = Math.max(0, Math.trunc(input.dispatchedMinor));
  const received = Math.max(0, Math.trunc(input.receivedMinor));
  const settled = Math.min(received, dispatched);
  const outstanding = dispatched - settled;
  return {
    settledMinor: settled,
    outstandingMinor: outstanding,
    varianceMinor: received - dispatched,
    status: outstanding === 0 ? "full" : "partial_open",
  };
}

/** Convert integer pesewa to a cedi value for persistence as a Decimal. */
export function minorToCedi(minor: number): number {
  return Math.round(minor) / 100;
}

export function computeVariance(amount: unknown, actualReceived: unknown): number {
  return money(money(actualReceived) - money(amount));
}

export function describeTransferVariance(variance: unknown): string {
  const value = money(variance);
  if (value === 0) return "No variance";
  return value > 0 ? "More received than dispatched" : "Shortfall on receipt";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const branchBalanceSchema = z.object({
  locationId: z.string().min(1, "Choose a location."),
  assetType: z.enum(BRANCH_ASSET_TYPES),
  declaredBalance: z
    .number()
    .finite()
    .min(0, "A declared balance cannot be negative.")
    .max(999_999_999.99, "The balance is too large.")
    .refine(hasCurrencyPrecision, "Use no more than two decimal places."),
  note: z.string().trim().max(300).optional(),
});

export const branchTransferSchema = z
  .object({
    sourceLocationId: z.string().min(1, "Choose the sending location."),
    destinationLocationId: z.string().min(1, "Choose the receiving location."),
    assetType: z.enum(BRANCH_ASSET_TYPES),
    amount: z
      .number()
      .finite()
      .positive("The transfer amount must be greater than zero.")
      .max(999_999_999.99, "The transfer amount is too large.")
      .refine(hasCurrencyPrecision, "Use no more than two decimal places."),
    purpose: z.string().trim().max(200).optional(),
    notes: z.string().trim().max(500).optional(),
    idempotencyKey: z.string().trim().min(8).max(120),
  })
  .refine((value) => value.sourceLocationId !== value.destinationLocationId, {
    message: "The sending and receiving locations must be different.",
    path: ["destinationLocationId"],
  });

export type BranchTransferInput = z.infer<typeof branchTransferSchema>;

/** High-value transfers require step-up reauthentication at approval. */
export const HIGH_VALUE_TRANSFER_MINOR = 100_000;

export function requiresStepUpForApproval(amountMinor: number): boolean {
  return amountMinor >= HIGH_VALUE_TRANSFER_MINOR;
}

export function generateTransferReference(now: Date, random: string): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `TRF-${stamp}-${random}`.slice(0, 40);
}
