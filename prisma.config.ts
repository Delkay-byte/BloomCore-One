import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 CLI configuration.
 *
 * In Prisma 7 the datasource URL is no longer read from the schema, and `.env`
 * is no longer loaded automatically. This file supplies both for CLI commands
 * only (generate / migrate / db push / studio).
 *
 * Resolution order:
 *  1. PRISMA_CLI_DATABASE_URL — explicit override for one-off commands.
 *  2. DIRECT_URL — the unpooled Neon host, used for migrations and schema work.
 *  3. DATABASE_URL — SQLite (development/tests) or a direct PostgreSQL URL.
 *
 * The application runtime never uses this file: `src/lib/db.ts` passes a driver
 * adapter to `PrismaClient` instead, so request handling always uses the pooled
 * runtime connection.
 */
const url =
  process.env.PRISMA_CLI_DATABASE_URL ??
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL ??
  "file:./dev.db";

export default defineConfig({
  // SQLite is the default schema for local development and the unit suite.
  // PostgreSQL commands pass `--schema=prisma/schema-pg.prisma` explicitly.
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: { url },
});
