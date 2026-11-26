/**
 * Database-facing helpers for internal cash/float positions.
 *
 * One implementation is shared by the owner dashboard, the transfer workflow
 * and the availability check, so a screen and a server-side guard can never
 * disagree about how much cash or declared float is actually available.
 */

import { db } from "./db";
import type { Prisma } from "@prisma/client";
import {
  BRANCH_ASSET_TYPES,
  assetDefinition,
  assetPosition,
  transferAdjustmentFor,
  type AssetPosition,
  type BranchAssetType,
  type LocationPosition,
  type TransferBalanceRow,
} from "./branch-transfers";

type DbClient = typeof db | Prisma.TransactionClient;

function toRow(row: {
  id: string;
  assetType: string;
  amount: unknown;
  actualAmountReceived: unknown;
  status: string;
  sourceLocationId: string;
  destinationLocationId: string;
  createdAt: Date;
  dispatchedAt: Date | null;
  receivedAt: Date | null;
}): TransferBalanceRow {
  return {
    id: row.id,
    assetType: row.assetType,
    amount: row.amount,
    actualAmountReceived: row.actualAmountReceived,
    status: row.status,
    sourceLocationId: row.sourceLocationId,
    destinationLocationId: row.destinationLocationId,
    createdAt: row.createdAt,
    dispatchedAt: row.dispatchedAt,
    receivedAt: row.receivedAt,
  };
}

export async function loadTransferRows(
  client: DbClient,
  tenantId: string,
  locationIds?: string[]
): Promise<TransferBalanceRow[]> {
  const rows = await client.branchTransfer.findMany({
    where: {
      tenantId,
      ...(locationIds?.length
        ? {
            OR: [
              { sourceLocationId: { in: locationIds } },
              { destinationLocationId: { in: locationIds } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      assetType: true,
      amount: true,
      actualAmountReceived: true,
      status: true,
      sourceLocationId: true,
      destinationLocationId: true,
      createdAt: true,
      dispatchedAt: true,
      receivedAt: true,
    },
  });
  return rows.map(toRow);
}

/**
 * The current internal position for one location and asset.
 *
 * `effective` is the declared snapshot plus transfer movements recorded after
 * the declaration. When no declaration exists, the position is explicitly
 * unavailable rather than assumed to be zero.
 */
export async function positionFor(
  client: DbClient,
  tenantId: string,
  locationId: string,
  assetType: BranchAssetType
): Promise<AssetPosition> {
  const [balance, transfers] = await Promise.all([
    client.branchAssetBalance.findFirst({
      where: { tenantId, locationId, assetType },
      select: { declaredBalance: true, declaredAt: true, declaredById: true },
    }),
    loadTransferRows(client, tenantId, [locationId]),
  ]);
  return assetPosition({
    assetType,
    locationId,
    declared: balance
      ? {
          balance: balance.declaredBalance,
          declaredAt: balance.declaredAt,
          declaredById: balance.declaredById,
        }
      : null,
    rows: transfers,
  });
}

export interface BranchPositionBoard {
  locations: LocationPosition[];
  transfers: TransferBalanceRow[];
  declaredCashTotal: number | null;
  declaredFloatTotal: number | null;
  effectiveCashTotal: number | null;
  effectiveFloatTotal: number | null;
  floatByNetwork: Record<string, number | null>;
  missingDeclarations: number;
}

/**
 * Consolidated internal position.
 *
 * Total business cash/float is only summed from locations that actually have a
 * declaration. A location with no declaration is counted in
 * `missingDeclarations`, never treated as zero, so an owner can see the gap
 * instead of a misleading total.
 */
export async function loadBranchPositionBoard(
  tenantId: string
): Promise<BranchPositionBoard> {
  const [locations, balances, transfers] = await Promise.all([
    db.location.findMany({
      where: { tenantId },
      select: { id: true, name: true, code: true, status: true },
      orderBy: { name: "asc" },
    }),
    db.branchAssetBalance.findMany({
      where: { tenantId },
      select: {
        locationId: true,
        assetType: true,
        declaredBalance: true,
        declaredAt: true,
        declaredById: true,
      },
    }),
    loadTransferRows(db, tenantId),
  ]);

  const balanceByKey = new Map(
    balances.map((row) => [`${row.locationId}:${row.assetType}`, row])
  );

  let declaredCashTotal: number | null = 0;
  let declaredFloatTotal: number | null = 0;
  let effectiveCashTotal: number | null = 0;
  let effectiveFloatTotal: number | null = 0;
  const floatByNetwork: Record<string, number | null> = {};
  let missingDeclarations = 0;

  const positions: LocationPosition[] = locations.map((location) => {
    const assets = BRANCH_ASSET_TYPES.map((assetType) => {
      const balance = balanceByKey.get(`${location.id}:${assetType}`);
      return assetPosition({
        assetType,
        locationId: location.id,
        declared: balance
          ? {
              balance: balance.declaredBalance,
              declaredAt: balance.declaredAt,
              declaredById: balance.declaredById,
            }
          : null,
        rows: transfers,
      });
    });

    const cashAssets = assets.filter((asset) => asset.kind === "cash");
    const floatAssets = assets.filter((asset) => asset.kind === "float");
    const cashTotal =
      cashAssets.length > 0 && cashAssets.every((asset) => asset.effective !== null)
        ? cashAssets.reduce((sum, asset) => sum + (asset.effective ?? 0), 0)
        : null;
    const floatTotal =
      floatAssets.length > 0 && floatAssets.every((asset) => asset.effective !== null)
        ? floatAssets.reduce((sum, asset) => sum + (asset.effective ?? 0), 0)
        : null;

    for (const asset of assets) {
      if (asset.effective === null) {
        missingDeclarations += 1;
        continue;
      }
      if (asset.kind === "cash") {
        effectiveCashTotal = (effectiveCashTotal ?? 0) + asset.effective;
        declaredCashTotal = (declaredCashTotal ?? 0) + (asset.declared ?? 0);
      } else {
        effectiveFloatTotal = (effectiveFloatTotal ?? 0) + asset.effective;
        declaredFloatTotal = (declaredFloatTotal ?? 0) + (asset.declared ?? 0);
        floatByNetwork[asset.network] =
          (floatByNetwork[asset.network] ?? 0) + asset.effective;
      }
    }

    return {
      locationId: location.id,
      locationName: location.name,
      locationCode: location.code,
      assets,
      cashTotal,
      floatTotal,
    };
  });

  return {
    locations: positions,
    transfers,
    declaredCashTotal,
    declaredFloatTotal,
    effectiveCashTotal,
    effectiveFloatTotal,
    floatByNetwork,
    missingDeclarations,
  };
}

/** Helper for tests and reporting: one location's full asset set. */
export async function loadLocationPositions(
  tenantId: string,
  locationId: string
): Promise<AssetPosition[]> {
  const transfers = await loadTransferRows(db, tenantId, [locationId]);
  const balances = await db.branchAssetBalance.findMany({
    where: { tenantId, locationId },
    select: {
      assetType: true,
      declaredBalance: true,
      declaredAt: true,
      declaredById: true,
    },
  });
  const byAsset = new Map(balances.map((row) => [row.assetType, row]));
  return BRANCH_ASSET_TYPES.map((assetType) => {
    const balance = byAsset.get(assetType);
    return assetPosition({
      assetType,
      locationId,
      declared: balance
        ? {
            balance: balance.declaredBalance,
            declaredAt: balance.declaredAt,
            declaredById: balance.declaredById,
          }
        : null,
      rows: transfers,
    });
  });
}

export function describeAsset(assetType: string): string {
  return (BRANCH_ASSET_TYPES as readonly string[]).includes(assetType)
    ? assetDefinition(assetType as BranchAssetType).shortLabel
    : assetType;
}

/** Adjustment helper kept exported for the transfer detail screen. */
export function adjustmentFor(
  rows: TransferBalanceRow[],
  locationId: string,
  assetType: BranchAssetType,
  declaredAt: Date | null
) {
  return transferAdjustmentFor({ rows, locationId, assetType, declaredAt });
}
