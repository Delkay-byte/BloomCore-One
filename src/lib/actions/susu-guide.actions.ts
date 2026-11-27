/**
 * Phase 8 — tenant operational guidance.
 *
 * The checklist is computed from the tenant's real records rather than written
 * as static marketing copy, so an administrator can see what is genuinely
 * configured. It never asserts readiness that the data does not support.
 */

"use server";

import { db } from "@/lib/db";
import { requireTenantAdminSusu } from "@/lib/tenant";
import { isCompanyWideAdmin, resolveBranchScope } from "@/lib/branch";

export interface SetupGuideItem {
  key: string;
  title: string;
  status: "done" | "todo";
  detail: string;
  why: string;
  href: string;
  /** Who can act: "administrator", "platform" or "everyone". */
  owner: "administrator" | "platform" | "everyone";
}

export interface SetupGuide {
  items: SetupGuideItem[];
  completed: number;
  total: number;
  companyWide: boolean;
  scopeLabel: string;
}

export async function getSusuSetupGuide(): Promise<SetupGuide> {
  const ctx = await requireTenantAdminSusu();
  const companyWide = await isCompanyWideAdmin(ctx);
  const scope = await resolveBranchScope(ctx);

  const branchWhere =
    scope.kind === "all"
      ? { tenantId: ctx.tenantId }
      : { tenantId: ctx.tenantId, id: { in: scope.branchIds } };

  const [
    branches,
    activeBranches,
    staff,
    collectors,
    policy,
    reconciliations,
    remittances,
    supportRequests,
    activeAdmins,
  ] = await Promise.all([
    db.location.count({ where: branchWhere }),
    db.location.count({ where: { ...branchWhere, status: "active" } }),
    db.user.count({
      where: { tenantId: ctx.tenantId, role: { in: ["worker", "collector"] }, status: "active" },
    }),
    db.collector.count({ where: { tenantId: ctx.tenantId, status: "active" } }),
    db.withdrawalPolicy.findFirst({ where: { tenantId: ctx.tenantId, active: true } }),
    db.susuReconciliation.count({ where: { tenantId: ctx.tenantId } }),
    db.collectorRemittance.count({ where: { tenantId: ctx.tenantId } }),
    db.supportRequest.count({ where: { tenantId: ctx.tenantId } }),
    db.user.count({ where: { tenantId: ctx.tenantId, role: "admin", status: "active" } }),
  ]);

  const items: SetupGuideItem[] = [
    {
      key: "branches",
      title: "Create at least one branch",
      status: branches > 0 ? "done" : "todo",
      detail:
        branches > 0
          ? activeBranches + " active of " + branches + " branch(es)."
          : "No branch exists yet. Susu collections are recorded against a branch.",
      why: "Branches own collection responsibility and decide which administrator sees which staff and records.",
      href: "/susu/admin/branches",
      owner: "administrator",
    },
    {
      key: "team",
      title: "Add the team who will collect and reconcile",
      status: staff > 0 ? "done" : "todo",
      detail: staff > 0 ? staff + " active office or collector account(s)." : "Only administrators exist so far.",
      why: "Collectors record collections; office staff reconcile and approve. Administrator accounts are provisioned by platform support.",
      href: "/admin/staff",
      owner: "administrator",
    },
    {
      key: "collector",
      title: "Assign at least one active collector",
      status: collectors > 0 ? "done" : "todo",
      detail:
        collectors > 0
          ? collectors + " active collector(s)."
          : "No active collector. Register a collector and assign customers before collecting.",
      why: "A collection must name the collector who received the cash, so the ledger stays attributable.",
      href: "/susu/admin/collectors",
      owner: "administrator",
    },
    {
      key: "withdrawal-policy",
      title: "Confirm the withdrawal policy",
      status: policy ? "done" : "todo",
      detail: policy
        ? "A policy is active" +
          (policy.highValueRequiresApproval
            ? " and high-value withdrawals need " + policy.requiredApprovals + " approval(s)."
            : ".")
        : "No withdrawal policy is configured. The platform defaults apply until one is saved.",
      why: "The policy decides limits, evidence and whether a second administrator must approve a payout.",
      href: "/susu/admin/withdrawal-controls",
      owner: "administrator",
    },
    {
      key: "remittance",
      title: "Record money handed in",
      status: remittances > 0 ? "done" : "todo",
      detail:
        remittances > 0
          ? remittances + " hand-in record(s)."
          : "No hand-in has been recorded. Collections stay outstanding against the collector until handed in.",
      why: "Cash is only reconciled when the collector's collections are matched against what was handed to the office.",
      href: "/susu/admin/remittances",
      owner: "administrator",
    },
    {
      key: "reconciliation",
      title: "Run a reconciliation",
      status: reconciliations > 0 ? "done" : "todo",
      detail:
        reconciliations > 0
          ? reconciliations + " reconciliation session(s) recorded."
          : "No reconciliation has been run. Differences will not be detected until they are.",
      why: "Reconciliation compares what was collected, handed in and paid out, and raises exceptions for review.",
      href: "/susu/admin/reconciliation",
      owner: "administrator",
    },
    {
      key: "support",
      title: "Know how to reach support",
      status: supportRequests > 0 ? "done" : "todo",
      detail:
        supportRequests > 0
          ? supportRequests + " support request(s) opened by this business."
          : "Open a request when something is unclear or looks wrong; support replies inside the request.",
      why: "Support requests keep the conversation with the business record, so a colleague can pick it up later.",
      href: "/susu/support",
      owner: "everyone",
    },
    {
      key: "second-admin",
      title: "Have a second administrator",
      status: activeAdmins >= 2 ? "done" : "todo",
      detail:
        activeAdmins >= 2
          ? activeAdmins + " active administrators."
          : "Only one active administrator. If that person is unavailable, approvals and staff changes stop.",
      why: "Maker-checker approvals and staff recovery need a second administrator. Tenant administrators cannot create administrators; ask platform support.",
      href: "/susu/support",
      owner: "platform",
    },
  ];

  const completed = items.filter((item) => item.status === "done").length;
  const scopeLabel =
    scope.kind === "all"
      ? "All branches"
      : branches === 0
        ? "No branch assigned"
        : "Your assigned branches";

  return { items, completed, total: items.length, companyWide, scopeLabel };
}
