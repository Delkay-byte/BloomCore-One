#!/usr/bin/env node
/**
 * BIK Prestige Enterprise — first administrator bootstrap (one-time)
 *
 * The application cannot be used before one `User` row with role "admin"
 * exists, and the repository's `prisma/seed.ts` must NOT be used for
 * production: it inserts demo locations, staff and sample financial records.
 *
 * This script creates exactly one administrator account and nothing else.
 * It is idempotent by refusal: if any administrator already exists it exits
 * without writing anything.
 *
 * Usage (PostgreSQL, direct connection recommended):
 *
 *   DATABASE_URL="postgresql://..." \
 *   ADMIN_EMAIL="owner@example.com" \
 *   ADMIN_NAME="Owner Name" \
 *   ADMIN_PASSWORD="<at least 12 characters>" \
 *   node scripts/bootstrap-first-admin.mjs
 *
 * Rules:
 *   - The password is read from the environment and never printed.
 *   - The password is stored only as a bcrypt hash (cost 12).
 *   - No demo data, no locations, no customers, no financial records.
 *   - Safe to re-run: it refuses once an administrator exists.
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 12;

function fail(message) {
  console.error(`bootstrap-first-admin: ${message}`);
  process.exit(1);
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const fullName = (process.env.ADMIN_NAME || "").trim();
  const password = process.env.ADMIN_PASSWORD || "";

  if (!url) fail("DATABASE_URL is not set.");
  if (!url.startsWith("postgres")) fail("DATABASE_URL is not a PostgreSQL URL.");
  if (!email) fail("ADMIN_EMAIL is not set.");
  if (!EMAIL_RE.test(email)) fail("ADMIN_EMAIL is not a valid email address.");
  if (!fullName) fail("ADMIN_NAME is not set.");
  if (!password) fail("ADMIN_PASSWORD is not set.");
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const existingAdmins = await prisma.user.findMany({
    where: { role: "admin" },
    select: { email: true },
  });

  if (existingAdmins.length > 0) {
    console.error(
      "bootstrap-first-admin: an administrator already exists — nothing written."
    );
    for (const admin of existingAdmins) console.error(`  existing: ${admin.email}`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await prisma.user.create({
    data: {
      email,
      fullName,
      role: "admin",
      status: "active",
      passwordHash,
      forcePasswordReset: false,
    },
    select: { id: true, email: true, role: true, createdAt: true },
  });

  console.log("bootstrap-first-admin: administrator created.");
  console.log(`  id:        ${admin.id}`);
  console.log(`  email:     ${admin.email}`);
  console.log(`  role:      ${admin.role}`);
  console.log(`  createdAt: ${admin.createdAt.toISOString()}`);
  console.log("  password:  (not displayed — it is the value you supplied)");
  console.log("");
  console.log("Remove ADMIN_PASSWORD from your shell/environment now.");
}

main()
  .catch((error) => {
    console.error(`bootstrap-first-admin failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
