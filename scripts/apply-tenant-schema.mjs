#!/usr/bin/env node
/**
 * One-shot schema transformer: introduces the multi-tenant foundation into
 * prisma/schema.prisma, then regenerates prisma/schema-pg.prisma from it
 * (the two files are identical except for the datasource provider line).
 *
 * Idempotent: re-running against an already-transformed schema is a no-op.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const SQLITE = path.join(ROOT, "prisma", "schema.prisma");
const PG = path.join(ROOT, "prisma", "schema-pg.prisma");

/** Every tenant-owned model -> the back-relation field name on BusinessTenant. */
const TENANT_OWNED = {
  User: "users",
  Location: "locations",
  DailyAccount: "dailyAccounts",
  Expense: "expenses",
  AuditLog: "auditLogs",
  Customer: "customers",
  SusuAccount: "susuAccounts",
  SusuCycle: "susuCycles",
  Contribution: "contributions",
  ContributionAllocation: "contributionAllocations",
  Withdrawal: "withdrawals",
  Commission: "commissions",
  CardFee: "cardFees",
  Collector: "collectors",
  CollectorCustomerAssignment: "collectorCustomerAssignments",
  CollectorRemittance: "collectorRemittances",
  PasswordResetToken: "passwordResetTokens",
  DeviceEnrollment: "deviceEnrollments",
  OfflineTransaction: "offlineTransactions",
};

function transform(src) {
  if (src.includes("model BusinessTenant {")) {
    console.log("  · schema already contains BusinessTenant — skipping transform");
    return src;
  }

  const lines = src.split(/\r?\n/);
  const out = [];
  let current = null;
  let sawTenantId = false;

  for (const line of lines) {
    const modelStart = line.match(/^model\s+(\w+)\s*\{/);
    if (modelStart) {
      current = modelStart[1];
      sawTenantId = false;
      out.push(line);
      continue;
    }

    if (current && /^\}\s*$/.test(line)) {
      if (TENANT_OWNED[current]) {
        out.push("");
        out.push(
          "  tenant BusinessTenant? @relation(fields: [tenantId], references: [id])"
        );
        out.push("  @@index([tenantId])");
      }
      out.push(line);
      current = null;
      continue;
    }

    out.push(line);

    // Insert tenantId immediately after the primary key of each owned model.
    if (
      current &&
      TENANT_OWNED[current] &&
      !sawTenantId &&
      /^\s+id\s+String\s+@id\b/.test(line)
    ) {
      out.push("  tenantId String?");
      sawTenantId = true;
    }
  }

  let next = out.join("\n");

  // Location.code must be unique per tenant, not globally: two businesses
  // legitimately both have a branch called "ACC-001".
  next = next.replace(
    /(\n  name\s+String\n)  code\s+String\s+@unique\n/,
    "$1  code   String\n"
  );
  next = next.replace(
    /(@@index\(\[status\]\)\n  @@index\(\[code\]\)\n\})/,
    "@@unique([tenantId, code])\n  $1"
  );

  // ---- New platform-level models -------------------------------------------
  const backRelations = Object.entries(TENANT_OWNED)
    .map(([model, field]) => `  ${field} ${model}[]`)
    .join("\n");

  const newModels = `
// =====================
// PLATFORM / MULTI-TENANCY
// =====================

/// A single enrolled business on the platform. Every tenant-owned record
/// carries a tenantId pointing here; all tenant data access resolves this
/// record from the authenticated server session (never from browser input).
model BusinessTenant {
  id                 String    @id @default(cuid())
  code               String    @unique // server-generated, e.g. BIK-A1B2C3
  name               String
  legalName          String?
  contactPhone       String?
  contactEmail       String?
  address            String?
  momoEnabled        Boolean   @default(false)
  susuEnabled        Boolean   @default(false)
  status             String    @default("PROVISIONING") // PROVISIONING | ACTIVE | SUSPENDED | ARCHIVED
  onboardingStatus   String    @default("NOT_STARTED") // NOT_STARTED | IN_PROGRESS | COMPLETED
  primaryAdminUserId String?
  activatedAt        DateTime?
  suspendedAt        DateTime?
  suspensionReason   String?
  archivedAt         DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

${backRelations}

  @@index([status])
  @@index([onboardingStatus])
  @@index([momoEnabled])
  @@index([susuEnabled])
}

/// Platform operator identity (BloomCore). Completely separate from tenant
/// User accounts: own table, own cookie, own guard. Never a tenant admin.
model PlatformSuperAdmin {
  id                 String    @id @default(cuid())
  email              String    @unique
  fullName           String
  passwordHash       String
  status             String    @default("active") // active | inactive
  forcePasswordReset Boolean   @default(false)
  tokenVersion       Int       @default(0)
  lastLoginAt        DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  auditLogs PlatformAuditLog[]

  @@index([status])
}

/// Platform-level audit trail. Deliberately isolated from tenant AuditLog so
/// the two security boundaries never mix. tenantId is a plain string (not a
/// relation) so platform history survives tenant archival.
model PlatformAuditLog {
  id         String   @id @default(cuid())
  actorId    String?
  actorEmail String?
  action     String
  tenantId   String?
  tenantCode String?
  entityType String?
  entityId   String?
  details    String?
  reason     String?
  ipAddress  String?
  createdAt  DateTime @default(now())

  actor PlatformSuperAdmin? @relation(fields: [actorId], references: [id])

  @@index([actorId])
  @@index([action])
  @@index([tenantId])
  @@index([createdAt])
}
`;

  return next.trimEnd() + "\n" + newModels;
}

const sqliteSrc = fs.readFileSync(SQLITE, "utf8");
const transformed = transform(sqliteSrc);
fs.writeFileSync(SQLITE, transformed, "utf8");
console.log("  ✓ prisma/schema.prisma updated");

// schema-pg.prisma is byte-identical apart from the datasource provider.
const pgOut = transformed.replace(
  /provider = "sqlite"/,
  'provider = "postgresql"'
);
fs.writeFileSync(PG, pgOut, "utf8");
console.log("  ✓ prisma/schema-pg.prisma regenerated (postgresql provider)");

// Sanity: confirm the two files differ only by the provider line.
const a = fs.readFileSync(SQLITE, "utf8").split(/\r?\n/);
const b = fs.readFileSync(PG, "utf8").split(/\r?\n/);
const diffs = [];
const max = Math.max(a.length, b.length);
for (let i = 0; i < max; i++) if (a[i] !== b[i]) diffs.push(i + 1);
console.log(
  diffs.length === 1
    ? `  ✓ schemas differ on exactly 1 line (provider, line ${diffs[0]})`
    : `  ✗ schemas differ on ${diffs.length} lines: ${diffs.join(", ")}`
);
