"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireTenantAdminMomo } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import {
  BRANCH_ASSET_TYPES,
  isInboundEffective,
  isOutboundEffective,
  type BranchAssetType,
} from "@/lib/branch-transfers";
import {
  LIQUIDITY_DISCLAIMER,
  LIQUIDITY_STATUS_LABELS,
  branchLiquiditySnapshotSchema,
  computeLiquidityLine,
  minorToCedi,
  summariseLiquidity,
  type LiquidityLineResult,
  type LiquiditySnapshotResult,
  type LiquidityStatus,
} from "@/lib/branch-liquidity";
import { createNotification } from "@/lib/notifications/notifications";
import { openExceptionCase } from "./provider-statement.actions";

export interface LiquidityActionResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface LiquidityLocationView {
  locationId: string;
  locationName: string;
  locationCode: string;
  snapshotId: string | null;
  status: LiquidityStatus;
  statusLabel: string;
  note: string | null;
  reviewNote: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  dailyAccountId: string | null;
  dailyAccountDifference: number | null;
  lines: LiquidityLineResult[];
  totals: Omit<LiquiditySnapshotResult, "lines">;
  /** Prefill for a snapshot that has not been saved yet. */
  declaredDefaults: Array<{ assetType: BranchAssetType; declaredMinor: number; declaredAt: string | null }>;
}

export interface LiquidityBoard {
  businessDate: string;
  disclaimer: string;
  locations: LiquidityLocationView[];
  totals: {
    counted: number;
    expected: number;
    variance: number;
    shortBranches: number;
  };
}

function dayBounds(dateIso: string): { start: Date; end: Date } {
  const start = new Date(`${dateIso}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86_400_000);
  return { start, end };
}

function minor(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

function revalidateLiquidity() {
  revalidatePath("/admin/liquidity");
  revalidatePath("/admin/reconciliation");
}

/**
 * Per-asset transfer movement for one branch and one business day.
 *
 * The server decides these figures. A submitted adjustment is never trusted from
 * the browser, because it is derived from transfer records the operator cannot
 * edit from this screen.
 */
async function transferAdjustmentForDay(
  tenantId: string,
  locationId: string,
  day: { start: Date; end: Date }
): Promise<Record<BranchAssetType, number>> {
  const transfers = await db.branchTransfer.findMany({
    where: {
      tenantId,
      OR: [{ sourceLocationId: locationId }, { destinationLocationId: locationId }],
      AND: [
        {
          OR: [
            { dispatchedAt: { gte: day.start, lt: day.end } },
            { receivedAt: { gte: day.start, lt: day.end } },
          ],
        },
      ],
    },
    select: {
      assetType: true,
      amount: true,
      actualAmountReceived: true,
      status: true,
      sourceLocationId: true,
      destinationLocationId: true,
      dispatchedAt: true,
      receivedAt: true,
    },
  });

  const adjustments = Object.fromEntries(
    BRANCH_ASSET_TYPES.map((asset) => [asset, 0])
  ) as Record<BranchAssetType, number>;

  for (const transfer of transfers) {
    if (!(BRANCH_ASSET_TYPES as readonly string[]).includes(transfer.assetType)) continue;
    const asset = transfer.assetType as BranchAssetType;
    const dispatchedAmount = minor(transfer.amount);
    const receivedAmount =
      transfer.actualAmountReceived === null ? dispatchedAmount : minor(transfer.actualAmountReceived);

    if (
      transfer.sourceLocationId === locationId &&
      transfer.dispatchedAt &&
      transfer.dispatchedAt >= day.start &&
      transfer.dispatchedAt < day.end &&
      isOutboundEffective(transfer.status)
    ) {
      adjustments[asset] -= dispatchedAmount;
    }
    if (
      transfer.destinationLocationId === locationId &&
      transfer.receivedAt &&
      transfer.receivedAt >= day.start &&
      transfer.receivedAt < day.end &&
      isInboundEffective(transfer.status)
    ) {
      adjustments[asset] += receivedAmount;
    }
  }
  return adjustments;
}

export async function getLiquidityBoard(businessDate?: string): Promise<LiquidityBoard> {
  const ctx = await requireTenantAdminMomo();
  const date = businessDate ?? new Date().toISOString().slice(0, 10);
  const day = dayBounds(date);

  const locations = await db.location.findMany({
    where: { tenantId: ctx.tenantId, status: "active" },
    select: { id: true, name: true, code: true },
    orderBy: { name: "asc" },
    take: 200,
  });

  const [snapshots, declarations] = await Promise.all([
    db.branchLiquiditySnapshot.findMany({
      where: {
        tenantId: ctx.tenantId,
        businessDate: { gte: day.start, lt: day.end },
      },
      include: {
        lines: true,
        dailyAccount: { select: { id: true, calculatedDifference: true } },
      },
    }),
    db.branchAssetBalance.findMany({
      where: { tenantId: ctx.tenantId },
      select: { locationId: true, assetType: true, declaredBalance: true, declaredAt: true },
    }),
  ]);

  const views: LiquidityLocationView[] = [];
  for (const location of locations) {
    const snapshot = snapshots.find((row) => row.locationId === location.id) ?? null;
    const adjustments = await transferAdjustmentForDay(ctx.tenantId, location.id, day);
    const declaredDefaults = BRANCH_ASSET_TYPES.map((asset) => {
      const declaration = declarations.find(
        (row) => row.locationId === location.id && row.assetType === asset
      );
      return {
        assetType: asset,
        declaredMinor: declaration ? minor(declaration.declaredBalance) : 0,
        declaredAt: declaration ? declaration.declaredAt.toISOString() : null,
      };
    });

    const lines: LiquidityLineResult[] = snapshot
      ? snapshot.lines
          .filter((line) => (BRANCH_ASSET_TYPES as readonly string[]).includes(line.assetType))
          .map((line) =>
            computeLiquidityLine({
              assetType: line.assetType as BranchAssetType,
              openingDeclaredMinor: minor(line.openingDeclared),
              transferAdjustmentMinor: minor(line.transferAdjustment),
              countedCloseMinor: minor(line.countedClose),
              note: line.note,
            })
          )
      : declaredDefaults.map((entry) =>
          computeLiquidityLine({
            assetType: entry.assetType,
            openingDeclaredMinor: entry.declaredMinor,
            transferAdjustmentMinor: adjustments[entry.assetType],
            countedCloseMinor: entry.declaredMinor + adjustments[entry.assetType],
          })
        );

    const totals = summariseLiquidity(lines);
    views.push({
      locationId: location.id,
      locationName: location.name,
      locationCode: location.code,
      snapshotId: snapshot?.id ?? null,
      status: (snapshot?.status as LiquidityStatus) ?? "draft",
      statusLabel: snapshot ? LIQUIDITY_STATUS_LABELS[snapshot.status as LiquidityStatus] : "Not recorded",
      note: snapshot?.note ?? null,
      reviewNote: snapshot?.reviewNote ?? null,
      submittedAt: snapshot?.submittedAt?.toISOString() ?? null,
      reviewedAt: snapshot?.reviewedAt?.toISOString() ?? null,
      dailyAccountId: snapshot?.dailyAccountId ?? null,
      dailyAccountDifference: snapshot?.dailyAccount
        ? Number(snapshot.dailyAccount.calculatedDifference)
        : null,
      lines,
      totals: {
        openingTotalMinor: totals.openingTotalMinor,
        expectedTotalMinor: totals.expectedTotalMinor,
        countedTotalMinor: totals.countedTotalMinor,
        varianceTotalMinor: totals.varianceTotalMinor,
        cashVarianceMinor: totals.cashVarianceMinor,
        floatVarianceMinor: totals.floatVarianceMinor,
        shortLines: totals.shortLines,
        balanced: totals.balanced,
        requiresExplanation: totals.requiresExplanation,
      },
      declaredDefaults,
    });
  }

  const totalCounted = views.reduce((sum, view) => sum + view.totals.countedTotalMinor, 0);
  const totalExpected = views.reduce((sum, view) => sum + view.totals.expectedTotalMinor, 0);
  return {
    businessDate: date,
    disclaimer: LIQUIDITY_DISCLAIMER,
    locations: views,
    totals: {
      counted: minorToCedi(totalCounted),
      expected: minorToCedi(totalExpected),
      variance: minorToCedi(totalCounted - totalExpected),
      shortBranches: views.filter((view) => view.totals.shortLines > 0).length,
    },
  };
}

/**
 * Create or update the draft snapshot for one branch and day.
 *
 * The opening declaration is the operator's input. The transfer adjustment and
 * expected close are computed on the server from transfer records. Counted
 * figures are the operator's count.
 */
export async function saveLiquiditySnapshot(input: unknown): Promise<LiquidityActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const parsed = branchLiquiditySnapshotSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Enter the snapshot." };
  }
  const data = parsed.data;
  const day = dayBounds(data.businessDate);

  const location = await db.location.findFirst({
    where: { id: data.locationId, tenantId: ctx.tenantId, status: "active" },
    select: { id: true },
  });
  if (!location) return { success: false, error: "Choose a branch of this business." };

  let dailyAccountId: string | null = data.dailyAccountId ?? null;
  if (dailyAccountId) {
    const account = await db.dailyAccount.findFirst({
      where: { id: dailyAccountId, tenantId: ctx.tenantId, locationId: data.locationId },
      select: { id: true },
    });
    if (!account) return { success: false, error: "That daily account does not belong to this branch." };
  } else {
    // Link to the branch's daily close when one exists, so the two records can be
    // compared without the operator choosing anything.
    const account = await db.dailyAccount.findFirst({
      where: {
        tenantId: ctx.tenantId,
        locationId: data.locationId,
        businessDate: { gte: day.start, lt: day.end },
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    dailyAccountId = account?.id ?? null;
  }

  const existing = await db.branchLiquiditySnapshot.findFirst({
    where: {
      tenantId: ctx.tenantId,
      locationId: data.locationId,
      businessDate: { gte: day.start, lt: day.end },
    },
  });
  if (existing && existing.status === "reviewed") {
    return {
      success: false,
      error: "A reviewed liquidity snapshot is final. Open an exception case to record a difference.",
    };
  }

  const adjustments = await transferAdjustmentForDay(ctx.tenantId, data.locationId, day);
  const computed = data.lines.map((line) =>
    computeLiquidityLine({
      assetType: line.assetType,
      openingDeclaredMinor: line.openingDeclaredMinor,
      transferAdjustmentMinor: adjustments[line.assetType] ?? 0,
      countedCloseMinor: line.countedCloseMinor,
      note: line.note,
    })
  );
  const totals = summariseLiquidity(computed);

  // A short asset needs an explanation. This is re-checked here against the
  // server-computed expected close, so a client cannot skip it.
  for (const line of computed) {
    if (line.state === "short" && (line.note?.length ?? 0) < 10) {
      return {
        success: false,
        error: `Explain the ${line.label} shortfall in at least 10 characters before saving.`,
      };
    }
  }

  try {
    const id = await db.$transaction(async (tx) => {
      const snapshot = existing
        ? await tx.branchLiquiditySnapshot.update({
            where: { id: existing.id },
            data: {
              dailyAccountId,
              note: data.note ?? null,
              status: "draft",
              submittedAt: null,
              submittedById: null,
            },
            select: { id: true },
          })
        : await tx.branchLiquiditySnapshot.create({
            data: {
              tenantId: ctx.tenantId,
              locationId: data.locationId,
              businessDate: day.start,
              dailyAccountId,
              note: data.note ?? null,
              status: "draft",
              recordedById: ctx.userId,
            },
            select: { id: true },
          });

      await tx.branchLiquidityLine.deleteMany({ where: { snapshotId: snapshot.id } });
      for (const line of computed) {
        await tx.branchLiquidityLine.create({
          data: {
            tenantId: ctx.tenantId,
            snapshotId: snapshot.id,
            assetType: line.assetType,
            openingDeclared: minorToCedi(line.openingDeclaredMinor),
            transferAdjustment: minorToCedi(line.transferAdjustmentMinor),
            expectedClose: minorToCedi(line.expectedCloseMinor),
            countedClose: minorToCedi(line.countedCloseMinor),
            variance: minorToCedi(line.varianceMinor),
            note: line.note,
          },
        });
      }

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "branch_liquidity.saved",
        entityType: "branchLiquiditySnapshot",
        entityId: snapshot.id,
        details: {
          businessDate: data.businessDate,
          locationId: data.locationId,
          countedTotal: minorToCedi(totals.countedTotalMinor),
          expectedTotal: minorToCedi(totals.expectedTotalMinor),
          varianceTotal: minorToCedi(totals.varianceTotalMinor),
          financialMutation: false,
        },
      });

      return snapshot.id;
    });
    revalidateLiquidity();
    return {
      success: true,
      data: {
        id,
        expectedTotal: minorToCedi(totals.expectedTotalMinor),
        varianceTotal: minorToCedi(totals.varianceTotalMinor),
        requiresExplanation: totals.requiresExplanation,
      },
    };
  } catch {
    return { success: false, error: "The liquidity snapshot could not be saved." };
  }
}

export async function submitLiquiditySnapshot(id: string): Promise<LiquidityActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const snapshot = await db.branchLiquiditySnapshot.findFirst({
    where: { id, tenantId: ctx.tenantId },
    include: { lines: true },
  });
  if (!snapshot) return { success: false, error: "That snapshot was not found." };
  if (snapshot.status !== "draft") {
    return { success: false, error: "Only a draft snapshot can be submitted." };
  }

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.branchLiquiditySnapshot.updateMany({
        where: { id: snapshot.id, tenantId: ctx.tenantId, status: "draft" },
        data: { status: "submitted", submittedAt: new Date(), submittedById: ctx.userId },
      });
      if (updated.count !== 1) throw new Error("CONFLICT");
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "branch_liquidity.submitted",
        entityType: "branchLiquiditySnapshot",
        entityId: snapshot.id,
        details: { lines: snapshot.lines.length, financialMutation: false },
      });
    });
  } catch {
    return { success: false, error: "The snapshot could not be submitted." };
  }

  revalidateLiquidity();
  return { success: true };
}

/**
 * Review a submitted snapshot. A short branch opens a reconciliation exception
 * case so the difference has an owner and an age instead of disappearing.
 */
export async function reviewLiquiditySnapshot(input: {
  id: string;
  note?: string;
  openCase?: boolean;
}): Promise<LiquidityActionResponse> {
  const ctx = await requireTenantAdminMomo();
  const snapshot = await db.branchLiquiditySnapshot.findFirst({
    where: { id: input.id, tenantId: ctx.tenantId },
    include: { lines: true, location: { select: { name: true } } },
  });
  if (!snapshot) return { success: false, error: "That snapshot was not found." };
  if (snapshot.status !== "submitted") {
    return { success: false, error: "Only a submitted snapshot can be reviewed." };
  }

  const shortLines = snapshot.lines.filter((line) => Number(line.variance) < 0);
  let caseId: string | null = null;

  try {
    await db.$transaction(async (tx) => {
      const updated = await tx.branchLiquiditySnapshot.updateMany({
        where: { id: snapshot.id, tenantId: ctx.tenantId, status: "submitted" },
        data: {
          status: "reviewed",
          reviewedAt: new Date(),
          reviewedById: ctx.userId,
          reviewNote: input.note?.trim() || null,
        },
      });
      if (updated.count !== 1) throw new Error("CONFLICT");
      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "branch_liquidity.reviewed",
        entityType: "branchLiquiditySnapshot",
        entityId: snapshot.id,
        details: {
          shortLines: shortLines.length,
          note: input.note ?? null,
          financialMutation: false,
        },
      });
    });
  } catch {
    return { success: false, error: "The snapshot could not be reviewed." };
  }

  if (input.openCase && shortLines.length > 0) {
    const total = shortLines.reduce((sum, line) => sum + Number(line.variance), 0);
    const created = await openExceptionCase({
      category: "branch_liquidity",
      severity: Math.abs(total) >= 1000 ? "high" : "medium",
      title: `Liquidity shortfall at ${snapshot.location.name}`,
      description: `Reviewed closing count is below the transfer-adjusted expectation for ${
        shortLines.length
      } asset(s). Total difference GH₵${Math.abs(total).toFixed(2)}.`,
      evidence: shortLines
        .map((line) => `${line.assetType}: variance ${Number(line.variance).toFixed(2)} — ${line.note ?? "no note"}`)
        .join("\n"),
      links: [
        { entityType: "branchLiquiditySnapshot", entityId: snapshot.id, note: "Source snapshot" },
      ],
    });
    if (created.success) {
      caseId = (created.data as { id: string }).id;
      await createNotification({
        tenantId: ctx.tenantId,
        audience: "tenant",
        kind: "system",
        severity: "attention",
        title: "Branch liquidity shortfall recorded",
        body: `A reviewed liquidity snapshot for ${snapshot.location.name} is short. A reconciliation case was opened.`,
        href: "/admin/reconciliation/exceptions",
        dedupeKey: `liquidity_case:${snapshot.id}`,
      }).catch(() => null);
    }
  }

  revalidateLiquidity();
  return { success: true, data: { caseId } };
}

export async function getLiquidityLocationOptions(): Promise<
  Array<{ id: string; name: string; code: string }>
> {
  const ctx = await requireTenantAdminMomo();
  return db.location.findMany({
    where: { tenantId: ctx.tenantId, status: "active" },
    select: { id: true, name: true, code: true },
    orderBy: { name: "asc" },
    take: 200,
  });
}

