import { describe, expect, it } from "vitest";
import {
  mapCustomerDashboard,
  type RawCustomerDashboard,
} from "@/lib/customer-dashboard";

function raw(): RawCustomerDashboard {
  return {
    id: "cust-1",
    fullName: "Ama Synthetic",
    customerId: "MAACASH-ACC-STG-A",
    phone: "+233200000001",
    email: "ama@example.test",
    address: null,
    portalEnabled: true,
    status: "active",
    accounts: [
      {
        id: "acc-1",
        accountId: "MAACASH-ACC-STG-A-S1",
        dailyContribution: 10,
        status: "active",
        cardCustody: "customer",
        cycles: [
          {
            id: "cycle-1",
            cycleNumber: 1,
            startDate: new Date("2026-11-01T00:00:00.000Z"),
            endDate: new Date("2026-11-30T00:00:00.000Z"),
            dailyContribution: 10,
            status: "active",
            commissionCharged: false,
            contributions: [],
            withdrawals: [],
            commissions: [],
          },
        ],
      },
    ],
    assignments: [
      {
        collector: { user: { fullName: "Synthetic Collector" } },
      },
    ],
  };
}

describe("customer dashboard mapping", () => {
  it("flattens the nested account, cycle and collector", () => {
    const mapped = mapCustomerDashboard(raw());

    expect(mapped).not.toBeNull();
    expect(mapped?.customer.fullName).toBe("Ama Synthetic");
    expect(mapped?.customer.dailyContribution).toBe(10);
    expect(mapped?.account.accountId).toBe("MAACASH-ACC-STG-A-S1");
    expect(mapped?.currentCycle?.cycleNumber).toBe(1);
    expect(mapped?.collector?.fullName).toBe("Synthetic Collector");
  });

  it("returns null when the customer has no active account", () => {
    const value = raw();
    value.accounts = [];
    expect(mapCustomerDashboard(value)).toBeNull();
  });

  it("returns null for a missing customer", () => {
    expect(mapCustomerDashboard(null)).toBeNull();
  });
});
