#!/usr/bin/env node
/**
 * ============================================================================
 * FIRST PLATFORM SUPER ADMIN — OPERATOR-RUN, ONE TIME
 * ============================================================================
 *
 * Creates the first PlatformSuperAdmin for the BIK Prestige Enterprise SaaS
 * platform. This identity is NOT a tenant user: it lives in its own table,
 * authenticates against its own cookie (bik-platform-session) and can never be
 * a tenant administrator. The tenant bootstrap script
 * (bootstrap-bik-tenant-admin.mjs) is a different, non-privileged operation.
 *
 * This script is NEVER wired into the build, the start command or prisma seed.
 * A deployment must never mint a privileged account on its own.
 *
 * USAGE — interactive (recommended; the password is hidden as you type):
 *
 *   DATABASE_URL="<Neon direct URL>" \
 *     node scripts/bootstrap-first-platform-super-admin.mjs \
 *     --email owner@example.com --name "Owner Name"
 *
 * USAGE — non-interactive (password supplied in the local shell only):
 *
 *   DATABASE_URL="<Neon direct URL>" \
 *   PLATFORM_SUPER_ADMIN_PASSWORD="<12+ chars, 1 uppercase, 1 digit>" \
 *     node scripts/bootstrap-first-platform-super-admin.mjs \
 *     --email owner@example.com --name "Owner Name"
 *
 * SAFETY
 *   * Refuses when a Platform Super Admin already exists — it never replaces,
 *     overwrites or resets an existing account. Pass --allow-additional to add
 *     a second operator deliberately (existing rows are still never modified).
 *   * Refuses a duplicate email address.
 *   * Refuses an invalid email, an empty name, a password under 12 characters,
 *     or a password that the application's own policy would reject at login
 *     (must contain an uppercase letter and a digit).
 *   * Never prints, logs or stores the password in plain text.
 *   * Creation and both audit rows run in a single transaction.
 *   * Fails closed with a plain message if the database is unreachable.
 *
 * DO NOT set PLATFORM_SUPER_ADMIN_PASSWORD on Render. It is a local, one-shot
 * variable for this command only.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const BCRYPT_COST = 12; // must match hashPassword() in src/lib/auth.ts
const MIN_PASSWORD_LENGTH = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseArgs(argv) {
  const args = { email: null, name: null, allowAdditional: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email") args.email = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a === "--allow-additional") args.allowAdditional = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function die(message) {
  console.error(`bootstrap-first-platform-super-admin: ${message}`);
  process.exit(1);
}

/** Read a line without echoing it. Requires a TTY. */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= " ") value += ch;
      }
    };

    stdin.on("data", onData);
  });
}

/** Mirrors validatePasswordPolicy() in src/lib/platform-auth.ts. */
function passwordPolicyError(password) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (!/[A-Z]/.test(password)) return "password must contain an uppercase letter";
  if (!/[0-9]/.test(password)) return "password must contain a digit";
  return null;
}

async function checkConnection() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.error(
      "bootstrap-first-platform-super-admin: cannot reach the database."
    );
    console.error(`  reason: ${String(error.message).split("\n")[0]}`);
    console.error(
      "  Nothing was written. Check DATABASE_URL (use the direct Neon host) and retry."
    );
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      "Usage: node scripts/bootstrap-first-platform-super-admin.mjs --email <email> --name <full name> [--allow-additional]"
    );
    console.log(
      "Password: hidden interactive prompt, or PLATFORM_SUPER_ADMIN_PASSWORD."
    );
    return;
  }

  if (!args.email || !args.name) {
    die("--email and --name are required. Use --help for usage.");
  }

  const email = args.email.trim().toLowerCase();
  const fullName = args.name.trim();

  if (!EMAIL_RE.test(email)) die("--email is not a valid email address.");
  if (!fullName) die("--name must not be empty.");

  if (!(await checkConnection())) process.exit(1);

  // --- Duplicate / replacement guards --------------------------------------
  const sameEmail = await prisma.platformSuperAdmin.findUnique({
    where: { email },
    select: { id: true, email: true, status: true },
  });
  if (sameEmail) {
    die(
      `a Platform Super Admin already exists for ${sameEmail.email} ` +
        `(status: ${sameEmail.status}). Nothing written. ` +
        "Use the platform settings page to change that account's password."
    );
  }

  const total = await prisma.platformSuperAdmin.count();
  if (total > 0 && !args.allowAdditional) {
    die(
      `${total} Platform Super Admin account(s) already exist. Nothing written. ` +
        "Re-run with --allow-additional to add another operator deliberately, " +
        "or use the platform settings page."
    );
  }

  // --- Credential ----------------------------------------------------------
  let password = process.env.PLATFORM_SUPER_ADMIN_PASSWORD || "";
  if (!password) {
    if (!process.stdin.isTTY) {
      die(
        "no interactive terminal. Set PLATFORM_SUPER_ADMIN_PASSWORD in this " +
          "shell only (never on Render) and retry."
      );
    }
    password = await promptHidden(`Password for ${email} (hidden): `);
    const confirm = await promptHidden("Confirm password (hidden): ");
    if (password !== confirm) die("passwords do not match. Nothing written.");
  }

  const policyError = passwordPolicyError(password);
  if (policyError) die(`${policyError}. Nothing written.`);

  // --- Create (single transaction) -----------------------------------------
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  password = "";

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const existing = await tx.platformSuperAdmin.count();
      if (existing > 0 && !args.allowAdditional) {
        throw new Error(
          "a Platform Super Admin appeared while this script was running"
        );
      }

      const admin = await tx.platformSuperAdmin.create({
        data: {
          email,
          fullName,
          passwordHash,
          status: "active",
          // The operator chose this password; no forced change on first login.
          forcePasswordReset: false,
          tokenVersion: 0,
        },
        select: {
          id: true,
          email: true,
          fullName: true,
          status: true,
          createdAt: true,
        },
      });

      await tx.platformAuditLog.create({
        data: {
          actorId: admin.id,
          actorEmail: admin.email,
          action: "platform.bootstrap",
          entityType: "platform_super_admin",
          entityId: admin.id,
          details: JSON.stringify({
            via: "bootstrap-first-platform-super-admin.mjs",
            credentialSource: process.env.PLATFORM_SUPER_ADMIN_PASSWORD
              ? "env"
              : "interactive",
          }),
        },
      });

      return admin;
    });
  } catch (error) {
    console.error(
      `bootstrap-first-platform-super-admin: creation failed — ${String(
        error.message
      ).split("\n")[0]}`
    );
    console.error("  Nothing was committed.");
    process.exit(1);
  }

  console.log("\nbootstrap-first-platform-super-admin: Platform Super Admin created.");
  console.log(`  id:        ${created.id}`);
  console.log(`  email:     ${created.email}`);
  console.log(`  name:      ${created.fullName}`);
  console.log(`  status:    ${created.status}`);
  console.log(`  createdAt: ${created.createdAt.toISOString()}`);
  console.log("  password:  not displayed, not stored in plain text (bcrypt cost 12)");
  console.log("\nNext: sign in at /platform/login.");
  console.log(
    "Then remove PLATFORM_SUPER_ADMIN_PASSWORD from this shell if you set it."
  );
}

main()
  .catch((error) => {
    console.error(
      `bootstrap-first-platform-super-admin failed: ${String(error.message).split("\n")[0]}`
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
