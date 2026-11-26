/**
 * Reset and seed the disposable local-load SQLite database.
 *
 * Uses the EXISTING SQLite-generated Prisma client. It never runs
 * `prisma generate`, never touches E2E's test.db/e2e.db, and never contacts a
 * remote database. PostgreSQL 16 is available locally, but the hard task rule
 * forbids regenerating the client with schema-pg.prisma, and the generated
 * SQLite client rejects the pg driver adapter; that limitation is documented.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import {
  ARTIFACT_DIR,
  LOAD_DB_FILE,
  LOAD_DB_PROVIDER,
  LOAD_DB_URL,
  REPO_ROOT,
  assertLocalDatabaseUrl,
  assertLocalTarget,
  ensureArtifactDir,
} from "./env.mjs";

assertLocalTarget();
assertLocalDatabaseUrl(LOAD_DB_URL);
ensureArtifactDir();

const cliEnv = {
  ...process.env,
  DATABASE_URL: LOAD_DB_URL,
  PRISMA_CLI_DATABASE_URL: LOAD_DB_URL,
};
delete cliEnv.DIRECT_URL;

let prisma;
if (LOAD_DB_PROVIDER === "postgresql") {
  console.log("Applying current migrations to disposable loopback PostgreSQL");
  execFileSync("npx", ["prisma", "migrate", "deploy", "--config", "prisma.pg.config.ts"], {
    cwd: REPO_ROOT,
    env: cliEnv,
    stdio: "inherit",
    shell: true,
  });
  // Truncate business tables so every run starts from a clean synthetic state.
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: LOAD_DB_URL }) });
  const tables = await prisma.$queryRawUnsafe(
    "select tablename from pg_tables where schemaname='public' and tablename not like '_prisma%'"
  );
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
  );
} else {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    fs.rmSync(`${LOAD_DB_FILE}${suffix}`, { force: true });
  }
  console.log("Pushing SQLite schema to disposable local-load.db");
  execFileSync("npx", ["prisma", "db", "push", "--schema=prisma/schema.prisma"], {
    cwd: REPO_ROOT,
    env: cliEnv,
    stdio: "inherit",
    shell: true,
  });
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: LOAD_DB_URL.split("?")[0] }),
  });
}

const TENANTS = 10;
const passwordHash = bcrypt.hashSync("LocalLoadPass123!", 4);
const day = (offset) => {
  const d = new Date();
  d.setUTCHours(10, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offset);
  return d;
};
const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
const monthEnd = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0));

const fixtures = {
  generatedAt: new Date().toISOString(),
  database: LOAD_DB_FILE,
  tenants: [],
  users: { admin: [], worker: [], collector: [], customer: [], platform: [] },
  locations: [],
  accounts: [],
  collectors: [],
  deviceCandidates: [],
};

try {
  for (let t = 0; t < TENANTS; t += 1) {
    const code = `LL-T${String(t + 1).padStart(2, "0")}`;
    const tenantId = `ll-tenant-${t + 1}`;
    await prisma.businessTenant.create({
      data: {
        id: tenantId,
        code,
        name: `Local Load Synthetic Business ${t + 1}`,
        legalName: `Local Load Synthetic Business ${t + 1} Ltd`,
        status: "ACTIVE",
        onboardingStatus: "COMPLETED",
        momoEnabled: true,
        susuEnabled: true,
        activatedAt: day(120),
      },
    });

    const locations = [];
    for (let l = 0; l < 2; l += 1) {
      const locationId = `ll-location-${t + 1}-${l + 1}`;
      await prisma.location.create({
        data: {
          id: locationId,
          tenantId,
          code: `${code}-B${l + 1}`,
          name: `Local Load Branch ${t + 1}-${l + 1}`,
          status: "active",
        },
      });
      locations.push(locationId);
      fixtures.locations.push({ id: locationId, tenantId });
    }

    const adminId = `ll-admin-${t + 1}`;
    await prisma.user.create({
      data: {
        id: adminId,
        tenantId,
        email: `${code.toLowerCase()}@local-load.test`,
        fullName: `Local Load Admin ${t + 1}`,
        role: "admin",
        status: "active",
        passwordHash,
        momoEnabled: true,
        susuEnabled: true,
        emailVerified: true,
        locationId: locations[0],
      },
    });
    await prisma.businessTenant.update({
      where: { id: tenantId },
      data: { primaryAdminUserId: adminId },
    });
    fixtures.users.admin.push({ id: adminId, tenantId, module: "admin", locationId: locations[0] });

    const workerIds = [];
    for (let w = 0; w < 2; w += 1) {
      const id = `ll-worker-${t + 1}-${w + 1}`;
      await prisma.user.create({
        data: {
          id,
          tenantId,
          email: `worker-${t + 1}-${w + 1}@local-load.test`,
          fullName: `Local Load Worker ${t + 1}-${w + 1}`,
          role: "worker",
          status: "active",
          passwordHash,
          momoEnabled: true,
          susuEnabled: false,
          emailVerified: true,
          locationId: locations[w],
        },
      });
      workerIds.push({ id, tenantId, module: "momo", locationId: locations[w] });
      fixtures.users.worker.push(workerIds.at(-1));
    }

    const collectorIds = [];
    for (let c = 0; c < 2; c += 1) {
      const id = `ll-collector-user-${t + 1}-${c + 1}`;
      await prisma.user.create({
        data: {
          id,
          tenantId,
          email: `collector-${t + 1}-${c + 1}@local-load.test`,
          fullName: `Local Load Collector ${t + 1}-${c + 1}`,
          role: "collector",
          status: "active",
          passwordHash,
          momoEnabled: false,
          susuEnabled: true,
          emailVerified: true,
          locationId: locations[0],
        },
      });
      const collectorId = `ll-collector-${t + 1}-${c + 1}`;
      await prisma.collector.create({
        data: { id: collectorId, tenantId, userId: id, status: "active" },
      });
      collectorIds.push({ id: collectorId, userId: id, tenantId });
      fixtures.collectors.push(collectorIds.at(-1));
      fixtures.users.collector.push({ id, tenantId, module: "susu", locationId: locations[0], collectorId });
    }

    for (let cu = 0; cu < 5; cu += 1) {
      const customerId = `ll-customer-${t + 1}-${cu + 1}`;
      const customerCode = `LL-C-${String(t * 5 + cu + 1).padStart(4, "0")}`;
      await prisma.customer.create({
        data: {
          id: customerId,
          tenantId,
          customerId: customerCode,
          fullName: `Local Load Customer ${t + 1}-${cu + 1}`,
          phone: `+23320${String(1000000 + t * 5 + cu).padStart(7, "0")}`,
          email: `customer-${t + 1}-${cu + 1}@local-load.test`,
          status: "active",
          registeredAt: day(90),
          portalEnabled: true,
          portalPasswordHash: passwordHash,
        },
      });
      fixtures.users.customer.push({
        id: customerId,
        tenantId,
        module: "customer",
        customerCode,
      });

      const accountId = `ll-account-${t + 1}-${cu + 1}`;
      const accountCode = `LL-S-${String(t * 5 + cu + 1).padStart(4, "0")}`;
      await prisma.susuAccount.create({
        data: {
          id: accountId,
          tenantId,
          accountId: accountCode,
          customerId,
          dailyContribution: 10 + cu,
          status: "active",
        },
      });
      const cycleId = `ll-cycle-${t + 1}-${cu + 1}`;
      await prisma.susuCycle.create({
        data: {
          id: cycleId,
          tenantId,
          accountId,
          cycleNumber: 1,
          startDate: monthStart,
          endDate: monthEnd,
          dailyContribution: 10 + cu,
          status: "active",
        },
      });
      const collector = collectorIds[cu % collectorIds.length];
      await prisma.collectorCustomerAssignment.create({
        data: {
          id: `ll-assignment-${t + 1}-${cu + 1}`,
          tenantId,
          collectorId: collector.id,
          customerId,
          accountId,
          active: true,
        },
      });

      const contributions = [];
      for (let d = 1; d <= 12; d += 1) {
        contributions.push({
          tenantId,
          accountId,
          cycleId,
          amount: 10 + cu,
          collectionDate: day(d),
          channel: "collector",
          collectorId: collector.id,
          recordedById: collector.userId,
          referenceId: `LL-CON-${t + 1}-${cu + 1}-${d}`,
        });
      }
      await prisma.contribution.createMany({ data: contributions });
      await prisma.withdrawal.createMany({
        data: [
          {
            tenantId,
            accountId,
            cycleId,
            requestedAmount: 40,
            commissionAmount: 10 + cu,
            netAmount: 30 - cu,
            remainingBalance: 60,
            status: "completed",
            authorizedById: adminId,
            referenceId: `LL-WDR-${t + 1}-${cu + 1}-1`,
            createdAt: day(4),
          },
          {
            tenantId,
            accountId,
            cycleId,
            requestedAmount: 20,
            commissionAmount: 0,
            netAmount: 20,
            remainingBalance: 40,
            status: "pending",
            authorizedById: adminId,
            referenceId: `LL-WDR-${t + 1}-${cu + 1}-2`,
            createdAt: day(1),
          },
        ],
      });
      fixtures.accounts.push({
        id: accountId,
        tenantId,
        customerId,
        collectorId: collector.id,
        collectorUserId: collector.userId,
        dailyContribution: 10 + cu,
      });
    }

    // Readable MoMo history and daily accounts for worker/admin dashboards.
    for (let w = 0; w < workerIds.length; w += 1) {
      const worker = workerIds[w];
      for (let d = 1; d <= 20; d += 1) {
        const businessDate = day(d);
        await prisma.dailyAccount.create({
          data: {
            id: `ll-daily-${t + 1}-${w + 1}-${d}`,
            tenantId,
            locationId: worker.locationId,
            workerId: worker.id,
            businessDate,
            openingMomoFloat: 100,
            closingMomoFloat: 150 + d,
            totalCashIn: 50 + d,
            totalCashOut: 10,
            commission: 5,
            status: d % 3 === 0 ? "draft" : "submitted",
            submittedAt: d % 3 === 0 ? null : day(d - 1),
          },
        });
      }
      await prisma.momoTransaction.createMany({
        data: [1, 2, 3].map((n) => ({
          tenantId,
          locationId: worker.locationId,
          workerId: worker.id,
          type: n === 1 ? "cash_in" : "cash_out",
          network: n === 1 ? "mtn" : "telecel",
          direction: n === 1 ? "inflow" : "outflow",
          amount: 25 * n,
          businessDate: day(n + 2),
          occurredAt: day(n + 2),
          reference: `LL-MOMO-${t + 1}-${w + 1}-${n}`,
          externalReference: `LL-EXT-${t + 1}-${w + 1}-${n}`,
          status: "recorded",
          idempotencyKey: `ll-momo-key-${t + 1}-${w + 1}-${n}`,
          recordedById: worker.id,
        })),
      });
    }

    const auditRows = [];
    for (let i = 0; i < 120; i += 1) {
      auditRows.push({
        tenantId,
        userId: i % 4 === 0 ? adminId : collectorIds[i % collectorIds.length].userId,
        actorName: i % 4 === 0 ? `Local Load Admin ${t + 1}` : `Local Load Collector ${t + 1}`,
        actorRole: i % 4 === 0 ? "admin" : "collector",
        actorType: "user",
        action: i % 4 === 0 ? "risk_intelligence.joined" : "contribution.recorded",
        entityType: i % 4 === 0 ? "riskIntelligenceConsent" : "contribution",
        entityId: `LL-CON-${t + 1}-1-${(i % 12) + 1}`,
        details: JSON.stringify({ financialMutation: false, synthetic: true }),
        createdAt: day(i % 30),
      });
    }
    await prisma.auditLog.createMany({ data: auditRows });

    await prisma.zeliEntitlement.create({
      data: {
        tenantId,
        featureKey: "zeli_analytics",
        status: "active",
        source: "manual",
        reason: "Local load synthetic entitlement",
        grantedByType: "platform",
      },
    });

    fixtures.tenants.push({ id: tenantId, code, adminId, locations, workers: workerIds.map((w) => w.id), collectors: collectorIds.map((c) => c.id) });
  }

  await prisma.zeliAvailability.upsert({
    where: { id: "global" },
    create: { id: "global", enabled: true, reason: "Local load synthetic default" },
    update: { enabled: true, reason: "Local load synthetic default" },
  });
  await prisma.platformSuperAdmin.create({
    data: {
      id: "ll-platform-admin",
      email: "platform@local-load.test",
      fullName: "Local Load Platform Operator",
      passwordHash,
      status: "active",
    },
  });
  fixtures.users.platform.push({ id: "ll-platform-admin", module: "platform" });

  // One synthetic outbox row for the duplicate/out-of-order webhook scenario.
  await prisma.customerMessageOutbox.create({
    data: {
      id: "ll-outbox-webhook-target",
      eventKey: "receipt:contribution:ll-webhook-target:sms",
      tenantId: "ll-tenant-1",
      customerId: "ll-customer-1-1",
      channel: "sms",
      purpose: "receipt",
      reference: "LL-WEBHOOK-REF",
      recipientEncrypted: "synthetic-local-value",
      recipientMasked: "+23320******01",
      payload: JSON.stringify({ synthetic: true }),
      status: "pending",
      providerMessageId: "ll-provider-msg-1",
    },
  });

  fs.writeFileSync(path.join(ARTIFACT_DIR, "fixtures.json"), JSON.stringify(fixtures, null, 2));
  const counts = {
    tenants: await prisma.businessTenant.count(),
    users: await prisma.user.count(),
    customers: await prisma.customer.count(),
    locations: await prisma.location.count(),
    accounts: await prisma.susuAccount.count(),
    contributions: await prisma.contribution.count(),
    withdrawals: await prisma.withdrawal.count(),
    auditLogs: await prisma.auditLog.count(),
    dailyAccounts: await prisma.dailyAccount.count(),
    momoTransactions: await prisma.momoTransaction.count(),
  };
  console.log(JSON.stringify({ database: LOAD_DB_FILE, counts }, null, 2));
} finally {
  await prisma.$disconnect();
}
