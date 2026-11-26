/**
 * Durable actor attribution for Activity History.
 *
 * Audit rows snapshot the actor name/role/type when the action happens. A later
 * rename or deletion must not rewrite the historical record.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  cleanDatabase,
  createTestAdmin,
  createTestCustomer,
  createTestTenant,
} from "./setup";
import { createAuditLog } from "@/lib/audit";

beforeEach(async () => {
  await cleanDatabase();
});

describe("audit actor attribution", () => {
  it("keeps the actor name and role used at the time of the action", async () => {
    const tenant = await createTestTenant({ susu: true, momo: false });
    const admin = await createTestAdmin({
      tenantId: tenant.id,
      susu: true,
      momo: false,
    });

    await createAuditLog({
      userId: admin.id,
      tenantId: tenant.id,
      action: "test.actor_snapshot",
      entityType: "dailyAccount",
      entityId: "snapshot-1",
    });

    await prisma.user.update({
      where: { id: admin.id },
      data: { fullName: "Renamed Administrator", role: "collector" },
    });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: tenant.id, action: "test.actor_snapshot" },
    });
    expect(row.userId).toBe(admin.id);
    expect(row.actorName).toBe("Test Admin");
    expect(row.actorRole).toBe("admin");
    expect(row.actorType).toBe("user");
  });

  it("keeps evidence after the actor account is removed", async () => {
    const tenant = await createTestTenant({ susu: false, momo: true });
    const location = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Attribution Branch", code: "ATT-1" },
    });
    const worker = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "attribution-worker@test.invalid",
        fullName: "Original Worker",
        role: "worker",
        passwordHash: "not-used",
        momoEnabled: true,
        locationId: location.id,
      },
    });

    await createAuditLog({
      userId: worker.id,
      tenantId: tenant.id,
      action: "test.removed_actor",
      entityType: "dailyAccount",
      entityId: "snapshot-2",
    });
    await prisma.user.delete({ where: { id: worker.id } });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: tenant.id, action: "test.removed_actor" },
    });
    expect(row.actorName).toBe("Original Worker");
    expect(row.actorRole).toBe("worker");
    expect(row.actorType).toBe("user");
  });

  it("attributes customer portal actions to the customer, not a staff role", async () => {
    const tenant = await createTestTenant({ susu: true, momo: false });
    const admin = await createTestAdmin({
      tenantId: tenant.id,
      susu: true,
      momo: false,
    });
    const { customer } = await createTestCustomer(admin.id, 10, "ATT-CUS");

    await createAuditLog({
      userId: customer.id,
      tenantId: tenant.id,
      action: "customer_dispute.opened",
      entityType: "customerDispute",
      entityId: "snapshot-3",
    });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId: tenant.id, action: "customer_dispute.opened" },
    });
    expect(row.actorName).toBe(customer.fullName);
    expect(row.actorRole).toBe("customer");
    expect(row.actorType).toBe("customer");
  });
});
