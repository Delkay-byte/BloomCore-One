#!/usr/bin/env node
/**
 * Read-only schema introspection: which tables exist, and which carry tenantId.
 * Used to verify the multi-tenant foundation landed in the local database.
 * Never writes. Never prints connection strings or row data.
 */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

(async () => {
  const isPg = (process.env.DATABASE_URL || "").startsWith("postgres");

  let tables;
  if (isPg) {
    tables = await prisma.$queryRawUnsafe(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name"
    );
  } else {
    tables = await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%' ORDER BY name"
    );
  }

  const names = tables.map((t) => t.name);
  console.log(`provider: ${isPg ? "postgresql" : "sqlite"}`);
  console.log(`tables (${names.length}): ${names.join(", ")}`);

  const withTenant = [];
  const withoutTenant = [];
  for (const name of names) {
    let cols;
    if (isPg) {
      cols = await prisma.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name='${name}'`
      );
      cols = cols.map((c) => c.column_name);
    } else {
      cols = await prisma.$queryRawUnsafe(`PRAGMA table_info("${name}")`);
      cols = cols.map((c) => c.name);
    }
    (cols.includes("tenantId") ? withTenant : withoutTenant).push(name);
  }

  console.log(`\nwith tenantId (${withTenant.length}): ${withTenant.join(", ")}`);
  console.log(`without tenantId (${withoutTenant.length}): ${withoutTenant.join(", ") || "(none)"}`);

  await prisma.$disconnect();
})().catch((e) => {
  console.error("introspect failed:", e.message);
  process.exit(1);
});