import { beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanDatabase, createTestAdmin, createTestCustomer } from "./pg-setup";

describe("PostgreSQL — Susu branch foundation", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("creates branch columns, membership table and indexes", async () => {
    const columns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'branchId'
        AND table_name IN ('Collector','Contribution','CollectorRemittance','Withdrawal','CustomerWithdrawalRequest','OfflineTransaction','OfflineActionRequest','AuditLog')
    `;
    expect(columns.map((row) => row.table_name).sort()).toEqual([
      "AuditLog",
      "Collector",
      "CollectorRemittance",
      "Contribution",
      "CustomerWithdrawalRequest",
      "OfflineActionRequest",
      "OfflineTransaction",
      "Withdrawal",
    ]);

    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
        'BranchMembership_tenantId_userId_status_idx',
        'BranchMembership_tenantId_userId_locationId_role_key',
        'Contribution_branchId_idx'
      )
    `;
    expect(indexes.map((row) => row.indexname).sort()).toEqual([
      "BranchMembership_tenantId_userId_locationId_role_key",
      "BranchMembership_tenantId_userId_status_idx",
      "Contribution_branchId_idx",
    ]);
  });

  it("stores branch responsibility without rewriting legacy null rows", async () => {
    const admin = await createTestAdmin();
    const tenant = await prisma.businessTenant.create({
      data: { code: "PG-BRANCH", name: "PG Branch Tenant", status: "ACTIVE" },
    });
    await prisma.user.update({ where: { id: admin.id }, data: { tenantId: tenant.id } });
    const branch = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Main", code: "MAIN" },
    });
    const customer = await createTestCustomer(admin.id, 10, "pgbranch");
    const attributed = await prisma.contribution.create({
      data: {
        tenantId: tenant.id,
        branchId: branch.id,
        accountId: customer.account.id,
        cycleId: customer.cycle.id,
        recordedById: admin.id,
        amount: 10,
        collectionDate: new Date(),
        channel: "direct_office",
        referenceId: `CON-pgbranch-${admin.id}`,
      },
    });
    const legacy = await prisma.contribution.create({
      data: {
        tenantId: tenant.id,
        accountId: customer.account.id,
        cycleId: customer.cycle.id,
        recordedById: admin.id,
        amount: 10,
        collectionDate: new Date(),
        channel: "direct_office",
        referenceId: `CON-pglegacy-${admin.id}`,
      },
    });
    expect(attributed.branchId).toBe(branch.id);
    expect(legacy.branchId).toBeNull();

    await prisma.location.update({
      where: { id: branch.id },
      data: { status: "inactive" },
    });
    const after = await prisma.contribution.findUniqueOrThrow({ where: { id: attributed.id } });
    expect(after.branchId).toBe(branch.id);
  });
});
