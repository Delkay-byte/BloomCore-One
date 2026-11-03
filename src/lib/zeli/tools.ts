import { db } from "@/lib/db";
import type {
  ZeliContextBlock,
  ZeliIdentity,
  ZeliSource,
  ZeliToolOutcome,
} from "./types";

function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function money(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

interface ToolDefinition {
  name: string;
  purpose: string;
  permission: string[];
  tenantScoped: true;
  readOnly: true;
}

/**
 * Tool registry. Every tool is read-only for this release. No tool accepts a
 * tenant id from the model or the browser; the tenant is always the identity's
 * server-resolved tenant. Financial write actions remain in the normal UI.
 */
export const ZELI_TOOLS: ToolDefinition[] = [
  {
    name: "business_summary",
    purpose: "Counts, today's contributions and operational exceptions for the tenant",
    permission: ["admin"],
    tenantScoped: true,
    readOnly: true,
  },
  {
    name: "customer_lookup",
    purpose: "Search customers and accounts by name, customer id or phone",
    permission: ["admin", "collector", "worker"],
    tenantScoped: true,
    readOnly: true,
  },
  {
    name: "collector_summary",
    purpose: "Collector assignments, today's collections and cash handover status",
    permission: ["admin", "collector"],
    tenantScoped: true,
    readOnly: true,
  },
  {
    name: "daily_account_summary",
    purpose: "Daily account status for the worker or the tenant",
    permission: ["admin", "worker"],
    tenantScoped: true,
    readOnly: true,
  },
  {
    name: "customer_account_summary",
    purpose: "The signed-in customer's own accounts and cycles",
    permission: ["customer"],
    tenantScoped: true,
    readOnly: true,
  },
];

function canUse(identity: ZeliIdentity, tool: string): boolean {
  return ZELI_TOOLS.some(
    (definition) =>
      definition.name === tool && definition.permission.includes(identity.role)
  );
}

async function businessSummary(identity: ZeliIdentity): Promise<ZeliToolOutcome> {
  const started = Date.now();
  if (!identity.tenantId || !canUse(identity, "business_summary")) {
    return {
      tool: "business_summary",
      ok: false,
      summary: "Not permitted.",
      sources: [],
      durationMs: Date.now() - started,
    };
  }
  const tenantId = identity.tenantId;
  const today = startOfToday();
  const [customers, accounts, contributions, withdrawals, remittances, dailyAccounts] =
    await Promise.all([
      db.customer.count({ where: { tenantId, status: "active" } }),
      db.susuAccount.count({ where: { tenantId, status: "active" } }),
      db.contribution.aggregate({
        where: { tenantId, reversedAt: null, collectionDate: { gte: today } },
        _sum: { amount: true },
        _count: true,
      }),
      db.withdrawal.count({ where: { tenantId, status: "pending" } }),
      db.collectorRemittance.aggregate({
        where: { tenantId, reversedAt: null, createdAt: { gte: today } },
        _sum: { remittedAmount: true, variance: true },
      }),
      db.dailyAccount.findMany({
        where: { tenantId, businessDate: { gte: today } },
        select: { status: true },
      }),
    ]);

  const data = {
    activeCustomers: customers,
    activeSusuAccounts: accounts,
    todayContributions: money(contributions._sum.amount),
    todayContributionCount: contributions._count,
    pendingWithdrawals: withdrawals,
    todayRemitted: money(remittances._sum.remittedAmount),
    todayVariance: money(remittances._sum.variance),
    dailyAccountsToday: {
      draft: dailyAccounts.filter((row) => row.status === "draft").length,
      submitted: dailyAccounts.filter((row) => row.status === "submitted").length,
      reviewed: dailyAccounts.filter((row) => row.status === "reviewed").length,
    },
  };

  return {
    tool: "business_summary",
    ok: true,
    summary: JSON.stringify(data),
    sources: [
      { label: "Admin dashboard", href: "/admin/dashboard" },
      { label: "Susu overview", href: "/susu/admin" },
      { label: "MoMo history", href: "/admin/history" },
    ],
    durationMs: Date.now() - started,
  };
}

async function customerLookup(
  identity: ZeliIdentity,
  question: string
): Promise<ZeliToolOutcome | null> {
  if (!identity.tenantId || !canUse(identity, "customer_lookup")) return null;
  const terms = question
    .replace(/[^\p{L}\p{N}@+ -]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length >= 2)
    .slice(0, 6);
  if (terms.length === 0) return null;

  const rows = await db.customer.findMany({
    where: {
      tenantId: identity.tenantId,
      OR: terms.flatMap((term) => [
        { fullName: { contains: term } },
        { customerId: { contains: term } },
        { phone: { contains: term } },
      ]),
    },
    select: {
      customerId: true,
      fullName: true,
      accounts: {
        where: { tenantId: identity.tenantId },
        select: { accountId: true, dailyContribution: true, status: true },
        take: 3,
      },
    },
    take: 5,
  });
  if (rows.length === 0) return null;

  return {
    tool: "customer_lookup",
    ok: true,
    summary: JSON.stringify(
      rows.map((row) => ({
        customerId: row.customerId,
        fullName: row.fullName,
        accounts: row.accounts.map((account) => ({
          accountId: account.accountId,
          dailyContribution: money(account.dailyContribution),
          status: account.status,
        })),
      }))
    ),
    sources: rows.map((row) => ({
      label: `${row.fullName} (${row.customerId})`,
      href: `/susu/admin/customers`,
      detail: "Open Customers and search this id",
    })),
    durationMs: 0,
  };
}

async function collectorSummary(identity: ZeliIdentity): Promise<ZeliToolOutcome | null> {
  if (!identity.tenantId || !canUse(identity, "collector_summary")) return null;
  const today = startOfToday();
  const collector = await db.collector.findFirst({
    where:
      identity.role === "collector"
        ? { tenantId: identity.tenantId, userId: identity.userId, status: "active" }
        : { tenantId: identity.tenantId, status: "active" },
    select: { id: true, user: { select: { fullName: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (!collector) return null;

  const [assignments, contributions, remittances] = await Promise.all([
    db.collectorCustomerAssignment.count({
      where: { tenantId: identity.tenantId, collectorId: collector.id, active: true },
    }),
    db.contribution.aggregate({
      where: {
        tenantId: identity.tenantId,
        collectorId: collector.id,
        reversedAt: null,
        collectionDate: { gte: today },
      },
      _sum: { amount: true },
      _count: true,
    }),
    db.collectorRemittance.aggregate({
      where: {
        tenantId: identity.tenantId,
        collectorId: collector.id,
        reversedAt: null,
        createdAt: { gte: today },
      },
      _sum: { remittedAmount: true, variance: true },
    }),
  ]);

  return {
    tool: "collector_summary",
    ok: true,
    summary: JSON.stringify({
      collector: collector.user.fullName,
      assignedCustomers: assignments,
      todayCollected: money(contributions._sum.amount),
      todayCollectionCount: contributions._count,
      handedInToday: money(remittances._sum.remittedAmount),
      varianceToday: money(remittances._sum.variance),
    }),
    sources: [{ label: "Collector dashboard", href: "/collector/dashboard" }],
    durationMs: 0,
  };
}

async function dailyAccountSummary(identity: ZeliIdentity): Promise<ZeliToolOutcome | null> {
  if (!identity.tenantId || !canUse(identity, "daily_account_summary")) return null;
  const today = startOfToday();
  const rows = await db.dailyAccount.findMany({
    where: {
      tenantId: identity.tenantId,
      businessDate: { gte: today },
      ...(identity.role === "worker" ? { workerId: identity.userId } : {}),
    },
    select: {
      status: true,
      businessDate: true,
      calculatedMomoVariance: true,
      calculatedCashVariance: true,
      worker: { select: { fullName: true } },
      location: { select: { name: true } },
    },
    take: 10,
  });
  if (rows.length === 0) return null;
  return {
    tool: "daily_account_summary",
    ok: true,
    summary: JSON.stringify(
      rows.map((row) => ({
        worker: row.worker.fullName,
        location: row.location.name,
        date: row.businessDate.toISOString().slice(0, 10),
        status: row.status,
        momoVariance: money(row.calculatedMomoVariance),
        cashVariance: money(row.calculatedCashVariance),
      }))
    ),
    sources: [
      {
        label: identity.role === "worker" ? "Your daily account" : "MoMo history",
        href: identity.role === "worker" ? "/worker/dashboard" : "/admin/history",
      },
    ],
    durationMs: 0,
  };
}

async function customerAccountSummary(identity: ZeliIdentity): Promise<ZeliToolOutcome | null> {
  if (!canUse(identity, "customer_account_summary")) return null;
  const accounts = await db.susuAccount.findMany({
    where: {
      customerId: identity.userId,
      ...(identity.tenantId ? { tenantId: identity.tenantId } : {}),
    },
    select: {
      accountId: true,
      status: true,
      dailyContribution: true,
      cycles: {
        where: { status: "active" },
        select: {
          cycleNumber: true,
          startDate: true,
          endDate: true,
          contributions: {
            where: { reversedAt: null },
            select: { amount: true },
          },
          withdrawals: { where: { status: "completed" }, select: { netAmount: true } },
        },
        take: 1,
      },
    },
    take: 5,
  });
  if (accounts.length === 0) return null;

  return {
    tool: "customer_account_summary",
    ok: true,
    summary: JSON.stringify(
      accounts.map((account) => {
        const cycle = account.cycles[0];
        const contributed = (cycle?.contributions ?? []).reduce(
          (sum, row) => sum + money(row.amount),
          0
        );
        const withdrawn = (cycle?.withdrawals ?? []).reduce(
          (sum, row) => sum + money(row.netAmount),
          0
        );
        return {
          accountId: account.accountId,
          dailyContribution: money(account.dailyContribution),
          status: account.status,
          cycle: cycle
            ? {
                number: cycle.cycleNumber,
                start: cycle.startDate.toISOString().slice(0, 10),
                end: cycle.endDate.toISOString().slice(0, 10),
                contributed,
                withdrawn,
              }
            : null,
        };
      })
    ),
    sources: [{ label: "Your dashboard", href: "/customer/dashboard" }],
    durationMs: 0,
  };
}

/**
 * Build a small, authorized context for the current turn. Only the tools the
 * role may use run. Retrieved values are data, never instructions.
 */
export async function buildZeliContext(
  identity: ZeliIdentity,
  question: string
): Promise<{ blocks: ZeliContextBlock[]; tools: ZeliToolOutcome[] }> {
  const outcomes: ZeliToolOutcome[] = [];

  if (identity.role === "admin") {
    outcomes.push(await businessSummary(identity));
  }
  if (identity.role === "customer") {
    const summary = await customerAccountSummary(identity);
    if (summary) outcomes.push(summary);
  } else {
    const lookup = await customerLookup(identity, question);
    if (lookup) outcomes.push(lookup);
    const collector = await collectorSummary(identity);
    if (collector) outcomes.push(collector);
    const daily = await dailyAccountSummary(identity);
    if (daily) outcomes.push(daily);
  }

  return {
    blocks: outcomes
      .filter((outcome) => outcome.ok)
      .map((outcome) => ({ title: outcome.tool, data: outcome.summary })),
    tools: outcomes,
  };
}

export function sourcesFor(outcomes: ZeliToolOutcome[]): ZeliSource[] {
  const seen = new Set<string>();
  const sources: ZeliSource[] = [];
  for (const outcome of outcomes) {
    for (const source of outcome.sources) {
      const key = `${source.label}|${source.href ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(source);
    }
  }
  return sources;
}
