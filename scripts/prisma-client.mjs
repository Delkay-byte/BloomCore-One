/**
 * Script-only Prisma 7 client factory.
 *
 * Operator scripts run outside Next.js. Prisma 7 no longer loads `.env`, so this
 * helper does it explicitly and then builds the same adapter the application
 * uses (better-sqlite3 for `file:` URLs, node-postgres otherwise).
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";

export function createPrismaClient(url = process.env.DATABASE_URL ?? "file:./dev.db") {
  const adapter = url.startsWith("file:")
    ? new PrismaBetterSqlite3({ url: url.split("?")[0] })
    : new PrismaPg({ connectionString: url });
  return new PrismaClient({ adapter });
}
