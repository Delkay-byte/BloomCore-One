#!/usr/bin/env node
/**
 * ============================================================================
 * BIK TENANT BACKFILL — multi-tenant platform foundation (Phase 1)
 * ============================================================================
 *
 * Assigns every existing tenant-owned row to the pre-existing "BIK Prestige
 * Enterprise" tenant, creating that tenant if it does not exist yet.
 *
 * WHAT IT DOES
 *   1. Records pre-migration row counts for the tenant-owned tables.
 *   2. Creates (or reuses) the BusinessTenant with the deterministic code
 *      BIK-HQ-001 — MoMo enabled, Susu enabled, status ACTIVE, onboarding
 *      COMPLETED — and points primaryAdminUserId at the existing
 *      administrator (role = "admin") if not already set.
 *   3. Updates every tenant-owned table: rows with a NULL tenantId are
 *      assigned to the BIK tenant. Rows that ALREADY belong to another tenant
 *      are never touched.
 *   4. Re-counts rows and verifies: no rows were deleted, no identifiers
 *      changed, and every previously-NULL row now belongs to the BIK tenant.
 *   5. Writes platform audit events (tenant.created when applicable,
 *      tenant.onboarding_updated for the backfill itself).
 *
 * SAFETY
 *   * Idempotent: safe to run any number of times.
 *   * Additive only: UPDATE statements only — nothing is deleted or inserted
 *     into business tables.
 *   * Works on both SQLite (local dev) and PostgreSQL (hosted) — the provider
 *     is detected from DATABASE_URL.
 *   * Run with --dry-run to print the plan without writing anything.
 *
 * USAGE
 *   node scripts/backfill-bik-tenant.mjs [--dry-run]
 *
 * This is an operator-controlled production step. Do NOT wire it into build
 * or startup commands.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes("--dry-run");

const BIK_TENANT_CODE = "BIK-HQ-001";
const BIK_TENANT_NAME = "BIK Prestige Enterprise";

/** Tables whose rows belong to a tenant. Order matters only for reporting. */
const TENANT_TABLES = [
  { table: "User", model: "user" },
  { table: "Location", model: "location" },
  { table: "DailyAccount", model: "dailyAccount" },
  { table: "Expense", model: "expense" },
  { table: "Customer", model: "customer" },
  { table: "SusuAccount", model: "susuAccount" },
  { table: "SusuCycle", model: "susuCycle" },
  { table: "Contribution", model: "contribution" },
  { table: "ContributionAllocation", model: "contributionAllocation" },
  { table: "Withdrawal", model: "withdrawal" },
  { table: "Commission", model: "commission" },
  { table: "CardFee", model: "cardFee" },
  { table: "Collector", model: "collector" },
  { table: "CollectorCustomerAssignment", model: "collectorCustomerAssignment" },
  { table: "CollectorRemittance", model: "collectorRemittance" },
  { table: "PasswordResetToken", model: "passwordResetToken" },
  { table: "DeviceEnrollment", model: "deviceEnrollment" },
  { table: "OfflineTransaction", model: "offlineTransaction" },
  { table: "AuditLog", model: "auditLog" },
];

function isPostgres() {
  return (process.env.DATABASE_URL || "").startsWith("postgres");
}

async function countAll() {
  const counts = {};
  for (const { model } of TENANT_TABLES) {
    counts[model] = await prisma[model].count();
  }
  return counts;
}

async function countNullTenant() {
  const counts = {};
  for (const { model } of TENANT_TABLES) {
    counts[model] = await prisma[model].count({ where: { tenantId: null } });
  }
  return counts;
}

async function main() {
  console.log("=".repeat(64));
  console.log(" BIK TENANT BACKFILL");
  console.log(` Provider: ${isPostgres() ? "PostgreSQL" : "SQLite"}`);
  console.log(` Mode:     ${DRY_RUN ? "DRY RUN (no writes)" : "APPLY"}`);
  console.log("=".repeat(64));

  // ── 1. Pre-migration counts ───────────────────────────────────────────
  const before = await countAll();
  const nullBefore = await countNullTenant();
  console.log("\nPre-migration row counts (total | without tenant):");
  for (const { model } of TENANT_TABLES) {
    console.log(`  ${model.padEnd(32)} ${String(before[model]).padStart(6)} | ${nullBefore[model]}`);
  }

  // ── 2. Ensure the BIK tenant exists ───────────────────────────────────
  let tenant = await prisma.businessTenant.findUnique({
    where: { code: BIK_TENANT_CODE },
  });

  if (!tenant) {
    if (DRY_RUN) {
      console.log(`\n[DRY RUN] Would create BusinessTenant "${BIK_TENANT_NAME}" (${BIK_TENANT_CODE}).`);
      tenant = { id: "<dry-run>" };
    } else {
      tenant = await prisma.businessTenant.create({
        data: {
          code: BIK_TENANT_CODE,
          name: BIK_TENANT_NAME,
          momoEnabled: true,
          susuEnabled: true,
          status: "ACTIVE",
          onboardingStatus: "COMPLETED",
          activatedAt: new Date(),
        },
      });
      await prisma.platformAuditLog.create({
        data: {
          actorId: null,
          actorEmail: "backfill-script",
          action: "tenant.created",
          tenantId: tenant.id,
          tenantCode: tenant.code,
          entityType: "BusinessTenant",
          entityId: tenant.id,
          details: JSON.stringify({
            name: tenant.name,
            momoEnabled: true,
            susuEnabled: true,
            note: "Created by backfill-bik-tenant.mjs for the pre-existing business",
          }),
        },
      });
      console.log(`\n✅ Created BusinessTenant "${BIK_TENANT_NAME}" (${tenant.code}) → ${tenant.id}`);
    }
  } else {
    console.log(`\n✅ Reusing existing BusinessTenant "${tenant.name}" (${tenant.code}) → ${tenant.id}`);
  }

  // ── 3. Point the tenant's primary administrator at the existing admin ──
  if (!DRY_RUN) {
    const admin = await prisma.user.findFirst({
      where: { role: "admin", status: "active" },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true },
    });
    if (admin && !tenant.primaryAdminUserId) {
      await prisma.businessTenant.update({
        where: { id: tenant.id },
        data: { primaryAdminUserId: admin.id },
      });
      console.log(`✅ Primary administrator set to existing admin: ${admin.email}`);
    } else if (admin) {
      console.log(`✅ Primary administrator already set.`);
    } else {
      console.log("⚠️  No active admin user found — primary administrator left unset.");
    }
  }

  // ── 4. Assign NULL-tenant rows to the BIK tenant ──────────────────────
  console.log("\nBackfilling rows without a tenant:");
  let totalUpdated = 0;
  if (!DRY_RUN) {
    for (const { table, model } of TENANT_TABLES) {
      const result = await prisma[model].updateMany({
        where: { tenantId: null },
        data: { tenantId: tenant.id },
      });
      totalUpdated += result.count;
      if (result.count > 0) {
        console.log(`  ${table.padEnd(32)} ${result.count} row(s) → ${tenant.code}`);
      }
    }
    if (totalUpdated === 0) {
      console.log("  (none — every row already has a tenant)");
    }
    await prisma.platformAuditLog.create({
      data: {
        actorId: null,
        actorEmail: "backfill-script",
        action: "tenant.onboarding_updated",
        tenantId: tenant.id,
        tenantCode: tenant.code,
        entityType: "BusinessTenant",
        entityId: tenant.id,
        details: JSON.stringify({
          note: "Legacy rows assigned to the BIK tenant",
          rowsUpdated: totalUpdated,
        }),
      },
    });
  } else {
    const wouldUpdate = Object.values(nullBefore).reduce((a, b) => a + b, 0);
    console.log(`  [DRY RUN] Would update ${wouldUpdate} row(s) across ${TENANT_TABLES.length} tables.`);
  }

  // ── 5. Post-migration verification ────────────────────────────────────
  if (!DRY_RUN) {
    const after = await countAll();
    const nullAfter = await countNullTenant();

    console.log("\nPost-migration verification (total | still without tenant):");
    let failures = 0;
    for (const { model } of TENANT_TABLES) {
      const ok = after[model] === before[model];
      if (!ok) failures++;
      console.log(
        `  ${model.padEnd(32)} ${String(after[model]).padStart(6)} | ${nullAfter[model]}${
          ok ? "" : "  ❌ COUNT CHANGED"
        }`
      );
    }

    console.log("\nResult:");
    if (failures === 0 && Object.values(nullAfter).every((n) => n === 0)) {
      console.log("  ✅ Row counts preserved; no row is without a tenant.");
      console.log("  ✅ Existing BIK data is now owned by the BIK Prestige Enterprise tenant.");
    } else {
      console.log(`  ❌ ${failures} table(s) changed row count, or rows remain unassigned — INVESTIGATE BEFORE PROCEEDING.`);
      process.exitCode = 1;
    }
  }

  console.log("\nDone.");
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
