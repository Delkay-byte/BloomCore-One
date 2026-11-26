import { db } from "@/lib/db";
import { requireTenantAdminMomo } from "@/lib/tenant";
import AgreementsClient from "@/components/AgreementsClient";
import { getAgreementOnboardingState } from "@/lib/actions/risk-governance.actions";
import NoticeOnboardingClient from "@/components/NoticeOnboardingClient";

export const dynamic = "force-dynamic";

/** Owner-accessible copy of every agreement presented or executed by the business. */
export default async function AgreementsPage() {
  const ctx = await requireTenantAdminMomo();
  const onboarding = await getAgreementOnboardingState();
  if (!onboarding.success || !onboarding.data) {
    return (
      <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h1 className="text-base font-bold text-slate-900">Business agreements</h1>
        <p className="mt-2 text-sm text-slate-600">
          {onboarding.error ?? "Agreement onboarding could not be loaded."}
        </p>
      </section>
    );
  }

  const notice = await db.employeePrivacyNotice.findFirst({
    orderBy: { effectiveDate: "desc" },
    select: { version: true },
  });
  const [rows, employees, attestations] = await Promise.all([
    db.participationAgreement.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        type: true,
        title: true,
        version: true,
        state: true,
        documentSha256: true,
        executedAt: true,
      },
    }),
    db.user.findMany({
      where: { tenantId: ctx.tenantId, role: { in: ["worker", "collector"] }, status: "active" },
      orderBy: { fullName: "asc" },
      select: { id: true, fullName: true, role: true },
    }),
    notice
      ? db.employeeNoticeAttestation.findMany({
          where: { tenantId: ctx.tenantId, noticeVersion: notice.version },
          select: {
            userId: true,
            acknowledgementState: true,
            deliveryMethod: true,
            deliveryEvidence: true,
            verified: true,
            acknowledgedAt: true,
            failureReason: true,
          },
        })
      : Promise.resolve([]),
  ]);
  const byUser = new Map(attestations.map((row) => [row.userId, row]));

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h1 className="text-base font-bold text-slate-900">Business agreements</h1>
        <p className="mt-1 text-xs text-slate-600">
          Every version presented or executed by this business. Execution evidence stays with
          the document; an email receipt is not proof of legal execution.
        </p>
      </div>
      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <AgreementsClient
          onboarding={onboarding.data}
          rows={rows.map((row) => ({
            ...row,
            executedAt: row.executedAt?.toISOString() ?? null,
          }))}
        />
      </div>
      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-base font-bold text-slate-900">Employee privacy notice onboarding</h2>
        <p className="mt-1 text-xs text-slate-600">
          Notice version: {notice?.version ?? "not published"}. A verified acknowledgement is
          required before this business can contribute a signal.
        </p>
        <div className="mt-3">
          <NoticeOnboardingClient
            noticeVersion={notice?.version ?? null}
            employees={employees.map((employee) => {
              const record = byUser.get(employee.id);
              return {
                userId: employee.id,
                fullName: employee.fullName,
                role: employee.role,
                state: record?.acknowledgementState ?? null,
                deliveryMethod: record?.deliveryMethod ?? null,
                evidence: record?.deliveryEvidence ?? null,
                verified: record?.verified ?? false,
                acknowledgedAt: record?.acknowledgedAt?.toISOString() ?? null,
                failureReason: record?.failureReason ?? null,
              };
            })}
          />
        </div>
      </div>
    </section>
  );
}
