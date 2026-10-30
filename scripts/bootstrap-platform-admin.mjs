#!/usr/bin/env node
/**
 * ============================================================================
 * Platform Super Admin bootstrap — OPERATOR-RUN, IDEMPOTENT
 * ============================================================================
 *
 * Creates the first Platform Super Admin. This is an intentional operator
 * action and is NEVER wired into the build, the start command, or the seed:
 * a deployment must never mint a privileged account on its own.
 *
 * Usage:
 *
 *   node scripts/bootstrap-platform-admin.mjs --email ops@bloomcore.dev \
 *        --name "BloomCore Ops"
 *
 *   # Non-interactive / CI-free provisioning with a supplied password:
 *   PLATFORM_ADMIN_PASSWORD='...' node scripts/bootstrap-platform-admin.mjs \
 *        --email ops@bloomcore.dev --name "BloomCore Ops"
 *
 * Behaviour:
 *   * Idempotent — re-running with an existing email reports and exits 0
 *     without changing the stored credential.
 *   * Never logs the password or its hash.
 *   * If no password is supplied, a cryptographically random one is generated,
 *     printed ONCE to the operator, and only its bcrypt hash is stored.
 *   * forcePasswordReset is set when a generated credential is used, so the
 *     first login must change it.
 *   * Refuses to run when the platform already has an active Super Admin,
 *     unless --force is passed (account replacement / recovery).
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import readline from "node:readline";

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = { email: null, name: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email") args.email = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a === "--force") args.force = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

/** Strong random password: 24 chars, mixed classes, no ambiguous glyphs. */
function generatePassword() {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_+=";
  const bytes = crypto.randomBytes(24);
  let out = "";
  for (let i = 0; i < 24; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function confirm(prompt) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      "Usage: node scripts/bootstrap-platform-admin.mjs --email <email> --name <full name> [--force]"
    );
    return;
  }

  if (!args.email || !args.name) {
    console.error("✗ --email and --name are required. Use --help for usage.");
    process.exit(1);
  }

  const email = args.email.trim().toLowerCase();

  // --- Idempotency ---------------------------------------------------------
  const existing = await prisma.platformSuperAdmin.findUnique({
    where: { email },
  });
  if (existing) {
    console.log(
      `· Platform Super Admin already exists for ${email} (status: ${existing.status}). No change made.`
    );
    console.log(
      "  To rotate this account's password, use the platform settings page or --force."
    );
    return;
  }

  const activeCount = await prisma.platformSuperAdmin.count({
    where: { status: "active" },
  });
  if (activeCount > 0 && !args.force) {
    console.error(
      `✗ ${activeCount} active Platform Super Admin(s) already exist. ` +
        "Re-run with --force to add another, or use the platform settings page."
    );
    process.exit(1);
  }

  // --- Credential ----------------------------------------------------------
  let password = process.env.PLATFORM_ADMIN_PASSWORD || null;
  let generated = false;
  if (!password) {
    password = generatePassword();
    generated = true;
  }
  if (password.length < 12) {
    console.error("✗ Supplied password must be at least 12 characters.");
    process.exit(1);
  }

  if (activeCount > 0 && args.force) {
    const ok = await confirm(
      `A platform administrator already exists. Create another for ${email}? (yes/no) `
    );
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await prisma.platformSuperAdmin.create({
    data: {
      email,
      fullName: args.name.trim(),
      passwordHash,
      status: "active",
      // A generated credential is one-time: force a change at first login.
      forcePasswordReset: generated,
      tokenVersion: 0,
    },
  });

  // Audit the provisioning itself, without any credential material.
  await prisma.platformAuditLog.create({
    data: {
      actorId: admin.id,
      actorEmail: admin.email,
      action: "platform.bootstrap",
      entityType: "platform_super_admin",
      entityId: admin.id,
      details: JSON.stringify({ generatedCredential: generated }),
    },
  });

  console.log(`\n✓ Platform Super Admin created: ${admin.email}`);
  console.log(`  id: ${admin.id}`);
  console.log(`  forcePasswordReset: ${admin.forcePasswordReset}`);

  if (generated) {
    console.log(
      "\n  ┌──────────────────────────────────────────────────────────────┐"
    );
    console.log(
      "  │ ONE-TIME PASSWORD — shown once, store it in your password     │"
    );
    console.log(
      "  │ manager now. Only its hash is stored. It cannot be recovered. │"
    );
    console.log(
      "  └──────────────────────────────────────────────────────────────┘"
    );
    console.log(`\n      ${password}\n`);
    console.log("  Sign in at /platform/login and change it immediately.\n");
  } else {
    console.log("  (Password supplied via environment; not displayed.)\n");
  }
}

main()
  .catch((e) => {
    console.error("bootstrap-platform-admin failed:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
