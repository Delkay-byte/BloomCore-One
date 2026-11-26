import Link from "next/link";
import { requireTenantAdminMomo } from "@/lib/tenant";
import { db } from "@/lib/db";
import RiskIntelligencePanel from "@/components/RiskIntelligencePanel";

export const dynamic = "force-dynamic";

export const metadata = { title: "Shared Risk Intelligence" };

export default async function RiskIntelligencePage() {
  const ctx = await requireTenantAdminMomo();
  const [staff, consent, agreements, notices, openSignals, openCases] = await Promise.all([
    db.user.findMany({
      where: { tenantId: ctx.tenantId, status: "active" },
      orderBy: { fullName: "asc" },
      select: { id: true, fullName: true, role: true },
    }),
    db.riskIntelligenceConsent.findFirst({
      where: { tenantId: ctx.tenantId },
      orderBy: { consentedAt: "desc" },
      select: { status: true, scope: true, policyVersion: true },
    }),
    db.participationAgreement.groupBy({
      by: ["state"],
      where: { tenantId: ctx.tenantId },
      _count: { _all: true },
    }),
    db.employeeNoticeAttestation.count({
      where: { tenantId: ctx.tenantId, verified: true },
    }),
    db.agentRiskSignal.count({
      where: { tenantId: ctx.tenantId, status: "open" },
    }),
    db.subjectRightsRequest.count({
      where: { tenantId: ctx.tenantId, status: { notIn: ["resolved", "closed"] } },
    }),
  ]);
  const executed = agreements
    .filter((row) => row.state === "executed" || row.state === "countersigned")
    .reduce((total, row) => total + row._count._all, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink-deep">Shared Agent Risk Intelligence</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-muted">
            Live participation, consent, closed-record signal sharing and employee queries. Cross-business
            disclosures only occur when every legal threshold is met; an unanswered query is not a clean
            report.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href="/admin/agreements" className="rounded-lg border border-line bg-white px-3 py-2 font-medium text-ink hover:border-brand-300">
            Agreements and notices
          </Link>
          <Link href="/admin/privacy-review" className="rounded-lg border border-line bg-white px-3 py-2 font-medium text-ink hover:border-brand-300">
            Privacy Review
          </Link>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-line bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Participation</p>
          <p className="mt-1 text-sm font-semibold text-ink-deep">
            {consent?.status === "active"
              ? consent.scope === "share_signals"
                ? "Sharing and querying"
                : "Query only"
              : "Not joined"}
          </p>
          <p className="mt-1 text-xs text-ink-muted">Policy {consent?.policyVersion ?? "—"}</p>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Executed agreements</p>
          <p className="mt-1 text-sm font-semibold text-ink-deep">{executed}</p>
          <p className="mt-1 text-xs text-ink-muted">Countersignature and activation are recorded separately.</p>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Verified employee notices</p>
          <p className="mt-1 text-sm font-semibold text-ink-deep">{notices}</p>
          <p className="mt-1 text-xs text-ink-muted">Delivery or acknowledgement evidence must be verified.</p>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Open signals / rights cases</p>
          <p className="mt-1 text-sm font-semibold text-ink-deep">{openSignals} / {openCases}</p>
          <p className="mt-1 text-xs text-ink-muted">Rights cases freeze matching signals while open.</p>
        </div>
      </div>

      <RiskIntelligencePanel
        staff={staff.map((row) => ({ id: row.id, fullName: row.fullName, role: row.role }))}
      />

      <p className="text-xs text-ink-muted">
        This page is the live operational surface. It does not create sample businesses, invoke a
        demonstration mode, or bypass the minimum-contributor thresholds. If the network has not yet
        reached those thresholds, the query action explains why no disclosure can be made.
      </p>
    </div>
  );
}
