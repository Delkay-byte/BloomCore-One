/**
 * BIK Prestige Enterprise — Data Migration Script
 *
 * Migrates data from SQLite to PostgreSQL.
 * Run this AFTER applying the PostgreSQL schema migration.
 *
 * Usage:
 *   npx tsx prisma/migrate-data.ts
 *
 * Environment:
 *   SOURCE_DATABASE_URL - SQLite connection string (default: file:./dev.db)
 *   DATABASE_URL - PostgreSQL connection string (required)
 */
import { createPrismaClient } from "../src/lib/prisma-client";


const SQLITE_URL = process.env.SOURCE_DATABASE_URL || "file:./dev.db";
const POSTGRES_URL = process.env.DATABASE_URL;

if (!POSTGRES_URL) {
  console.error("❌ DATABASE_URL environment variable is required");
  process.exit(1);
}

// Source: SQLite database
const source = createPrismaClient(SQLITE_URL);

// Target: PostgreSQL database
const target = createPrismaClient(POSTGRES_URL);

interface MigrationStats {
  table: string;
  sourceCount: number;
  targetCount: number;
  status: "✅" | "❌" | "⚠️";
}

const stats: MigrationStats[] = [];

async function migrateTable<T>(
  tableName: string,
  fetchAll: () => Promise<T[]>,
  insertMany: (data: T[]) => Promise<unknown>
) {
  const data = await fetchAll();
  if (data.length === 0) {
    stats.push({ table: tableName, sourceCount: 0, targetCount: 0, status: "✅" });
    return;
  }

  try {
    await insertMany(data);
    const targetCount = await target.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*) as count FROM "${tableName}"`
    );
    const count = Number(targetCount[0]?.count || 0);
    stats.push({ table: tableName, sourceCount: data.length, targetCount: count, status: count === data.length ? "✅" : "❌" });
  } catch (error) {
    stats.push({ table: tableName, sourceCount: data.length, targetCount: 0, status: "❌" });
    console.error(`  ❌ Error migrating ${tableName}:`, error);
  }
}

async function main() {
  console.log("🚀 BIK Prestige Enterprise — Data Migration\n");
  console.log(`Source: ${SQLITE_URL}`);
  console.log(`Target: ${POSTGRES_URL}\n`);

  // Migration order (respects foreign key dependencies)
  console.log("📋 Migrating shared tables...");

  await migrateTable(
    "Location",
    () => source.location.findMany(),
    (data) => target.location.createMany({ data })
  );

  await migrateTable(
    "User",
    () => source.user.findMany(),
    (data) => target.user.createMany({ data })
  );

  await migrateTable(
    "DailyAccount",
    () => source.dailyAccount.findMany(),
    (data) => target.dailyAccount.createMany({ data })
  );

  await migrateTable(
    "Expense",
    () => source.expense.findMany(),
    (data) => target.expense.createMany({ data })
  );

  await migrateTable(
    "AuditLog",
    () => source.auditLog.findMany(),
    (data) => target.auditLog.createMany({ data })
  );

  console.log("\n📋 Migrating Susu tables...");

  await migrateTable(
    "Customer",
    () => source.customer.findMany(),
    (data) => target.customer.createMany({ data })
  );

  await migrateTable(
    "SusuAccount",
    () => source.susuAccount.findMany(),
    (data) => target.susuAccount.createMany({ data })
  );

  await migrateTable(
    "SusuCycle",
    () => source.susuCycle.findMany(),
    (data) => target.susuCycle.createMany({ data })
  );

  await migrateTable(
    "Collector",
    () => source.collector.findMany(),
    (data) => target.collector.createMany({ data })
  );

  await migrateTable(
    "Contribution",
    () => source.contribution.findMany(),
    (data) => target.contribution.createMany({ data })
  );

  await migrateTable(
    "ContributionAllocation",
    () => source.contributionAllocation.findMany(),
    (data) => target.contributionAllocation.createMany({ data })
  );

  await migrateTable(
    "Withdrawal",
    () => source.withdrawal.findMany(),
    (data) => target.withdrawal.createMany({ data })
  );

  await migrateTable(
    "Commission",
    () => source.commission.findMany(),
    (data) => target.commission.createMany({ data })
  );

  await migrateTable(
    "CardFee",
    () => source.cardFee.findMany(),
    (data) => target.cardFee.createMany({ data })
  );

  await migrateTable(
    "CollectorCustomerAssignment",
    () => source.collectorCustomerAssignment.findMany(),
    (data) => target.collectorCustomerAssignment.createMany({ data })
  );

  await migrateTable(
    "CollectorRemittance",
    () => source.collectorRemittance.findMany(),
    (data) => target.collectorRemittance.createMany({ data })
  );

  // Print summary
  console.log("\n" + "═".repeat(60));
  console.log("📊 Migration Summary\n");

  const maxTableLen = Math.max(...stats.map((s) => s.table.length));
  console.log("Table".padEnd(maxTableLen + 2) + "Source".padStart(8) + "Target".padStart(8) + "  Status");
  console.log("-".repeat(maxTableLen + 22));

  for (const s of stats) {
    console.log(
      s.table.padEnd(maxTableLen + 2) +
        String(s.sourceCount).padStart(8) +
        String(s.targetCount).padStart(8) +
        "  " +
        s.status
    );
  }

  const failures = stats.filter((s) => s.status === "❌");
  if (failures.length > 0) {
    console.log(`\n❌ Migration failed: ${failures.length} table(s) had errors`);
    process.exit(1);
  } else {
    console.log("\n✅ All tables migrated successfully");
  }

  await source.$disconnect();
  await target.$disconnect();
}

main().catch(async (e) => {
  console.error("Migration error:", e);
  await source.$disconnect().catch(() => {});
  await target.$disconnect().catch(() => {});
  process.exit(1);
});
