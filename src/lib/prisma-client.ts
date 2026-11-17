import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Prisma 7 client factory.
 *
 * Prisma 7 requires a driver adapter. The adapter is chosen from the connection
 * string so the same generated client serves SQLite (development and the unit
 * suite) and PostgreSQL (staging and production):
 *
 * - `file:` → better-sqlite3 (query parameters such as `connection_limit` are
 *   not understood by the driver and are stripped).
 * - anything else → node-postgres against the pooled Neon host.
 */
export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "file:./dev.db";
}

export function buildPrismaAdapter(url: string) {
  if (url.startsWith("file:")) {
    return new PrismaBetterSqlite3({ url: url.split("?")[0] });
  }
  return new PrismaPg({ connectionString: url });
}

export function createPrismaClient(url: string = databaseUrl()): PrismaClient {
  // The generated client accepts either adapter; the union is not expressible in
  // its option types, so the selected adapter is passed through directly.
  return new PrismaClient({
    adapter: buildPrismaAdapter(url) as never,
  });
}
