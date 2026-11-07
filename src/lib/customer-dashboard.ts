/**
 * Shape mapping for the customer portal dashboard.
 *
 * `getCustomerAccount` returns a Customer row with its active account, current
 * cycle and collector assignment nested. The dashboard renders a flattened
 * view, so the mapping lives here where it can be unit-tested without a DOM.
 */

export interface RawCustomerDashboard {
  id: string;
  fullName: string;
  customerId: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  portalEnabled: boolean;
  status: string;
  accounts: Array<{
    id: string;
    accountId: string;
    dailyContribution: number;
    status: string;
    cardCustody: string;
    cycles: Array<{
      id: string;
      cycleNumber: number;
      startDate: Date;
      endDate: Date;
      dailyContribution: number;
      status: string;
      commissionCharged: boolean;
      contributions: Array<{
        id: string;
        amount: number;
        collectionDate: Date;
        channel: string;
        receivedBy?: { fullName: string } | null;
        collector?: { user?: { fullName: string } } | null;
        allocations: Array<{ cycleDay: number }>;
      }>;
      withdrawals: Array<{
        id: string;
        requestedAmount: number;
        commissionAmount: number;
        netAmount: number;
        remainingBalance: number;
        createdAt: Date;
        notes?: string | null;
      }>;
      commissions: Array<{ id: string; amount: number; createdAt: Date }>;
    }>;
  }>;
  assignments?: Array<{
    collector?: { user?: { fullName: string } | null } | null;
  }>;
}

export interface CustomerDashboardData {
  customer: {
    id: string;
    fullName: string;
    customerId: string;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    dailyContribution: number;
    portalEnabled: boolean;
    status: string;
  };
  account: {
    id: string;
    accountId: string;
    dailyContribution: number;
    status: string;
    cardCustody: string;
  };
  currentCycle: RawCustomerDashboard["accounts"][number]["cycles"][number] | null;
  collector: { fullName: string } | null;
}

export function mapCustomerDashboard(
  raw: RawCustomerDashboard | null | undefined
): CustomerDashboardData | null {
  const account = raw?.accounts?.[0] ?? null;
  if (!raw || !account) return null;

  const collectorName = raw.assignments?.[0]?.collector?.user?.fullName ?? null;

  return {
    customer: {
      id: raw.id,
      fullName: raw.fullName,
      customerId: raw.customerId,
      phone: raw.phone,
      email: raw.email,
      address: raw.address,
      dailyContribution: account.dailyContribution,
      portalEnabled: raw.portalEnabled,
      status: raw.status,
    },
    account: {
      id: account.id,
      accountId: account.accountId,
      dailyContribution: account.dailyContribution,
      status: account.status,
      cardCustody: account.cardCustody,
    },
    currentCycle: account.cycles?.[0] ?? null,
    collector: collectorName ? { fullName: collectorName } : null,
  };
}
