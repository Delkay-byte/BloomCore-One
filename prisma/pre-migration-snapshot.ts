/**
 * Pre-migration SQLite snapshot — records row counts for all important tables.
 * Run against SQLite before switching to PostgreSQL.
 */
import { createPrismaClient } from "../src/lib/prisma-client";

const prisma = createPrismaClient("file:./prisma/dev.db");

async function main() {
  console.log("📊 PRE-MIGRATION SNAPSHOT — SQLite Row Counts\n");

  const tables = [
    "User", "Location", "DailyAccount", "Expense", "AuditLog",
    "Customer", "SusuAccount", "SusuCycle", "Contribution",
    "ContributionAllocation", "Withdrawal", "Commission", "CardFee",
    "Collector", "CollectorCustomerAssignment", "CollectorRemittance",
  ];

  const counts: Record<string, number> = {};

  for (const table of tables) {
    try {
      const count = await (prisma as any)[table].count();
      counts[table] = count;
      console.log(`  ${table.padEnd(35)} ${String(count).padStart(6)}`);
    } catch {
      counts[table] = -1;
      console.log(`  ${table.padEnd(35)} ERROR`);
    }
  }

  // Print summary as JSON for comparison later
  console.log("\n--- JSON ---");
  console.log(JSON.stringify(counts, null, 2));
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
