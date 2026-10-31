#!/usr/bin/env node
/**
 * ============================================================================
 * BIK TENANT ADMINISTRATOR — OPERATOR-RUN, IDEMPOTENT
 * ============================================================================
 *
 * Creates the first administrator User for a tenant (default BIK-HQ-001).
 * This is an ORDINARY TENANT IDENTITY: role "admin", tenantId set, no platform
 * privileges of any kind. It cannot reach /platform/* — that boundary belongs
 * to PlatformSuperAdmin (bootstrap-first-platform-super-admin.mjs).
 *
 * This script is NEVER wired into the build, the start command or prisma seed.
 *
 * USAGE — interactive (recommended; the password is hidden as you type):
 *
 *   DATABASE_URL="<Neon direct URL>" \
 *     node scripts/bootstrap-bik-tenant-admin.mjs \
 *     --email owner@example.com --name "Owner Name"
 *
 * USAGE — non-interactive (password supplied in the local shell only):
 *
 *   DATABASE_URL="<Neon direct URL>" \
 *   TENANT_ADMIN_PASSWORD="<12+ chars, 1 uppercase, 1 digit>" \
 *     node scripts/bootstrap-bik-tenant-admin.mjs \
 *     --email owner@example.com --name "Owner Name"
 *
 * Options:
 *   --tenant-code <code>     defaults to BIK-HQ-001
 *   --allow-additional       add another administrator to a tenant that already
 *                            has one (existing accounts are never modified)
 *
 * SAFETY
 *   * Idempotent: refuses when the email already exists (any tenant) or when
 *     the tenant already has an active administrator. It never resets a
 *     password and never modifies an existing row.
 *   * Refuses a missing/inactive tenant, so no orphaned administrator can be
 *     created.
 *   * Refuses an invalid email, an empty name, a password under 12 characters,
 *     or a password the application policy would reject at login (uppercase
 *     letter + digit).
 *   * Never prints, logs or stores the password in plain text (bcrypt cost 12,
 *     the same helper the application uses).
 *   * Creation, the primary-admin back-reference and both audit rows run in a
 *     single transaction.
 *   * Fails closed with a plain message if the database is unreachable.
 *
 * DO NOT set TENANT_ADMIN_PASSWORD on Render. Local, one-shot use only.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_TENANT_CODE = "BIK-HQ-001";

function parseArgs(argv) {
  const args = {
    email: null,
    name: null,
    phone: null,
    tenantCode: DEFAULT_TENANT_CODE,
    allowAdditional: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email") args.email = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a === "--phone") args.phone = argv[++i];
    else if (a === "--tenant-code") args.tenantCode = argv[++i];
    else if (a === "--allow-additional") args.allowAdditional = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function die(message) {
  console.error(`bootstrap-bik-tenant-admin: ${message}`);
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
    console.error("bootstrap-bik-tenant-admin: cannot reach the database.");
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
      "Usage: node scripts/bootstrap-bik-tenant-admin.mjs --email <email> --name <full name> " +
        "[--phone <phone>] [--tenant-code BIK-HQ-001] [--allow-additional]"
    );
    console.log(
      "Password: hidden interactive prompt, or TENANT_ADMIN_PASSWORD."
    );
    return;
  }

  if (!args.email || !args.name) {
    die("--email and --name are required. Use --help for usage.");
  }

  const email = args.email.trim().toLowerCase();
  const fullName = args.name.trim();
  const phone = args.phone?.trim() || null;
  const tenantCode = args.tenantCode.trim();

  if (!EMAIL_RE.test(email)) die("--email is not a valid email address.");
  if (!fullName) die("--name must not be empty.");
  if (!tenantCode) die("--tenant-code must not be empty.");

  if (!(await checkConnection())) process.exit(1);

  // --- Tenant must exist and be operable -----------------------------------
  const tenant = await prisma.businessTenant.findUnique({
    where: { code: tenantCode },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      momoEnabled: true,
      susuEnabled: true,
      primaryAdminUserId: true,
    },
  });
  if (!tenant) {
    die(
      `tenant ${tenantCode} does not exist. Run scripts/backfill-bik-tenant.mjs first. Nothing written.`
    );
  }
  if (tenant.status !== "ACTIVE") {
    die(
      `tenant ${tenantCode} is ${tenant.status}, not ACTIVE. Nothing written.`
    );
  }

  // --- Duplicate / replacement guards --------------------------------------
  const sameEmail = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, role: true, tenantId: true },
  });
  if (sameEmail) {
    die(
      `a user already exists for ${sameEmail.email} (role: ${sameEmail.role}). ` +
        "Nothing written. Passwords are never reset by this script — use the " +
        "in-app password reset instead."
    );
  }

  const adminCount = await prisma.user.count({
    where: { tenantId: tenant.id, role: "admin", status: "active" },
  });
  if (adminCount > 0 && !args.allowAdditional) {
    die(
      `${adminCount} active administrator(s) already exist for ${tenant.code}. ` +
        "Nothing written. Re-run with --allow-additional to add another " +
        "deliberately, or create staff inside the app."
    );
  }

  // --- Credential ----------------------------------------------------------
  let password = process.env.TENANT_ADMIN_PASSWORD || "";
  if (!password) {
    if (!process.stdin.isTTY) {
      die(
        "no interactive terminal. Set TENANT_ADMIN_PASSWORD in this shell only " +
          "(never on Render) and retry."
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
  let primaryAssigned = false;
  try {
    created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email,
          fullName,
          phone,
          role: "admin",
          status: "active",
          passwordHash,
          forcePasswordReset: false, // operator chose the password
          // Admin capability flags mirror the tenant's entitlement; the
          // canonical resolver grants an administrator the union of the
          // tenant's enabled modules regardless of these flags.
          momoEnabled: tenant.momoEnabled,
          susuEnabled: tenant.susuEnabled,
        },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          tenantId: true,
          createdAt: true,
        },
      });

      if (!tenant.primaryAdminUserId) {
        await tx.businessTenant.update({
          where: { id: tenant.id },
          data: { primaryAdminUserId: user.id },
        });
        primaryAssigned = true;
      }

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          action: "user.admin_created",
          entityType: "User",
          entityId: user.id,
          details: JSON.stringify({
            via: "bootstrap-bik-tenant-admin.mjs",
            tenantCode: tenant.code,
            credentialSource: process.env.TENANT_ADMIN_PASSWORD
              ? "env"
              : "interactive",
          }),
        },
      });

      await tx.platformAuditLog.create({
        data: {
          actorId: null,
          actorEmail: "bootstrap-script",
          action: "tenant.admin_created",
          tenantId: tenant.id,
          tenantCode: tenant.code,
          entityType: "User",
          entityId: user.id,
          details: JSON.stringify({ role: "admin" }),
        },
      });

      return user;
    });
  } catch (error) {
    console.error(
      `bootstrap-bik-tenant-admin: creation failed — ${String(error.message).split("\n")[0]}`
    );
    console.error("  Nothing was committed.");
    process.exit(1);
  }

  console.log("\nbootstrap-bik-tenant-admin: tenant administrator created.");
  console.log(`  id:        ${created.id}`);
  console.log(`  email:     ${created.email}`);
  console.log(`  name:      ${created.fullName}`);
  console.log(`  role:      ${created.role}`);
  console.log(`  tenant:    ${tenant.code} (${tenant.name})`);
  console.log(`  created:   ${created.createdAt.toISOString()}`);
  if (primaryAssigned) console.log("  tenant.primaryAdminUserId: set to this account");
  console.log("  password:  not displayed, not stored in plain text (bcrypt cost 12)");
  console.log("\nNext: sign in at /admin/login (tenant admin — not /platform/login).");
  console.log("Then remove TENANT_ADMIN_PASSWORD from this shell if you set it.");
}

main()
  .catch((error) => {
    console.error(
      `bootstrap-bik-tenant-admin failed: ${String(error.message).split("\n")[0]}`
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
