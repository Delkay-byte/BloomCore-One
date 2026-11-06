/**
 * MaaCash - Deployment Preparation Script
 *
 * This script prepares the application for deployment by:
 * 1. Verifying environment configuration
 * 2. Generating Prisma client
 * 3. Applying database migrations
 * 4. Verifying database connectivity
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/prepare-deploy.mjs
 *
 * For Render deployment, this runs as part of the build command.
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

function run(cmd) {
  console.log(`  $ ${cmd}`);
  try {
    execSync(cmd, { cwd: ROOT, stdio: "inherit" });
    return true;
  } catch (e) {
    console.error(`  ❌ Command failed: ${cmd}`);
    return false;
  }
}

console.log("");
console.log("🚀 MaaCash — Deployment Preparation");
console.log("");

// Step 1: Verify environment
const dbUrl = process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET;
const appEnv = process.env.APP_ENV || "PILOT";

if (!dbUrl) {
  console.error("❌ DATABASE_URL is not set");
  process.exit(1);
}

if (!jwtSecret) {
  console.error("❌ JWT_SECRET is not set");
  process.exit(1);
}

if (dbUrl.includes("dev.db")) {
  console.error("❌ DATABASE_URL points to SQLite dev.db — this is not a production database");
  process.exit(1);
}

const isPostgres = dbUrl.startsWith("postgresql://") || dbUrl.startsWith("postgres://");
console.log(`✅ Environment: ${appEnv}`);
console.log(`✅ Database: ${isPostgres ? "PostgreSQL" : "SQLite"} (connection configured)`);
console.log(`✅ JWT_SECRET: configured`);
console.log("");

// Determine correct schema for database type
const schemaFlag = isPostgres ? "--schema=prisma/schema-pg.prisma" : "";
const schemaLabel = isPostgres ? "prisma/schema-pg.prisma" : "prisma/schema.prisma";
console.log(`📋 Using schema: ${schemaLabel}`);

// Step 2: Generate Prisma client
console.log("📦 Generating Prisma client...");
if (!run(`npx prisma generate ${schemaFlag}`)) {
  process.exit(1);
}
console.log("");

// Step 3: Apply migrations
console.log("🔄 Applying database migrations...");
if (!run(`npx prisma migrate deploy ${schemaFlag}`)) {
  console.log("⚠️  migrate deploy failed, trying db push...");
  if (!run(`npx prisma db push ${schemaFlag}`)) {
    console.error("❌ Database migration failed");
    process.exit(1);
  }
}
console.log("");

// Step 4: Build Next.js
console.log("🔨 Building Next.js application...");
if (!run("npm run build")) {
  console.error("❌ Build failed");
  process.exit(1);
}
console.log("");

console.log("✅ Deployment preparation complete!");
console.log("");
console.log("Next steps:");
console.log("  1. Deploy to your hosting platform");
console.log("  2. Verify the PILOT badge is displayed");
console.log("  3. Test login with pilot credentials");
console.log("  4. Verify from an external device");
console.log("");
