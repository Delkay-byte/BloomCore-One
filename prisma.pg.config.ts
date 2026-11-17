import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * PostgreSQL CLI configuration.
 *
 * Used by every command that touches the PostgreSQL schema:
 *   npx prisma migrate deploy --config prisma.pg.config.ts
 *   npx prisma migrate status --config prisma.pg.config.ts
 *   npx prisma migrate diff --from-config-datasource --config prisma.pg.config.ts ...
 *
 * Schema administration uses the UNPOOLED Neon host (DIRECT_URL). The runtime
 * uses the pooled DATABASE_URL through the driver adapter in src/lib/db.ts.
 */
const url =
  process.env.PRISMA_CLI_DATABASE_URL ??
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL ??
  "";

export default defineConfig({
  schema: "prisma/schema-pg.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: { url },
});
