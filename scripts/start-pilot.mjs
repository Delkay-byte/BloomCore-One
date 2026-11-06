/**
 * MaaCash - Pilot Startup Script
 *
 * This script loads the pilot environment configuration and starts the application.
 *
 * Usage:
 *   npm run pilot
 *
 * Prerequisites:
 *   1. Copy .env.pilot to .env.pilot.local
 *   2. Fill in the actual secrets in .env.pilot.local
 *   3. Ensure PostgreSQL bik_pilot is running (Docker: bik-prestige-pg on port 5433)
 *
 * The application will start on port 3456 and display the PILOT badge.
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PILOT_ENV = path.join(ROOT, ".env.pilot.local");
const LOCAL_ENV = path.join(ROOT, ".env.local");

// Check prerequisites
if (!fs.existsSync(PILOT_ENV)) {
  console.error("");
  console.error("❌ ERROR: .env.pilot.local not found");
  console.error("");
  console.error("   To set up the pilot environment:");
  console.error("   1. cp .env.pilot .env.pilot.local");
  console.error("   2. Edit .env.pilot.local and fill in actual secrets");
  console.error("   3. npm run pilot");
  console.error("");
  console.error("   NEVER commit .env.pilot.local to version control.");
  console.error("");
  process.exit(1);
}

// Copy .env.pilot.local to .env.local (Next.js picks up .env.local automatically)
fs.copyFileSync(PILOT_ENV, LOCAL_ENV);

// Read and validate the pilot config
const envContent = fs.readFileSync(PILOT_ENV, "utf8");
const dbUrl = envContent.match(/DATABASE_URL="([^"]+)"/)?.[1];
const jwtSecret = envContent.match(/JWT_SECRET="([^"]+)"/)?.[1];

// Safety checks
if (!dbUrl) {
  console.error("❌ ERROR: DATABASE_URL not found in .env.pilot.local");
  process.exit(1);
}

if (!jwtSecret || jwtSecret === "CHANGE_ME_GENERATE_NEW_SECRET") {
  console.error("❌ ERROR: JWT_SECRET not set in .env.pilot.local");
  console.error("   Generate one: openssl rand -base64 32");
  process.exit(1);
}

if (dbUrl.includes("dev.db")) {
  console.error("❌ ERROR: DATABASE_URL points to SQLite dev.db");
  console.error("   This is the DEVELOPMENT database, not PILOT.");
  console.error("   Update .env.pilot.local to point to PostgreSQL bik_pilot.");
  process.exit(1);
}

if (!dbUrl.includes("bik_pilot")) {
  console.error("⚠️  WARNING: DATABASE_URL does not contain 'bik_pilot'");
  console.error("   Current URL: " + dbUrl.replace(/\/\/[^:]+:[^@]+@/, "//<credentials>@"));
  console.error("   Expected to contain: bik_pilot");
  console.error("");
}

// Determine badge
let badge = "UNKNOWN";
if (dbUrl.includes("bik_pilot")) badge = "PILOT";
else if (dbUrl.includes("bik_prestige")) badge = "STAGING";
else if (dbUrl.includes("dev.db")) badge = "DEVELOPMENT";

console.log("");
console.log("🚀 MaaCash — PILOT Mode");
console.log("");
console.log("   Environment: " + badge);
console.log("   Database:    " + dbUrl.replace(/\/\/[^:]+:[^@]+@/, "//<credentials>@"));
console.log("   Port:        3456");
console.log("   URL:         http://localhost:3456");
console.log("");
console.log("   ⚠️  This is the PILOT environment with real data.");
console.log("   ⚠️  Do not use for development or testing.");
console.log("");

// Start Next.js on port 3456
const child = spawn("npx", ["next", "dev", "--webpack", "-p", "3456"], {
  cwd: ROOT,
  stdio: "inherit",
  shell: true,
});

child.on("close", (code) => {
  process.exit(code || 0);
});
