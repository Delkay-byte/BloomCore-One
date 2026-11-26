import Link from "next/link";
import { db } from "@/lib/db";
import { getAdminSession } from "@/lib/auth";
import PrivacyReviewClient from "@/components/PrivacyReviewClient";
import NoticePublisher from "@/components/NoticePublisher";
import { getRiskOrganisationConfig } from "@/lib/risk-intelligence/organisation-profile";

export const dynamic = "force-dynamic";

export default async function PrivacyReviewPage() {
  const session = await getAdminSession();
  const grant = session?.userId
    ? await db.riskPrivacyAccess.findFirst({
        where: { userId: session.userId, active: true },
        select: { role: true },
      })
    : null;

  if (!grant) {
    return (
      <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h1 className="text-base font-bold text-slate-900">Privacy review</h1>
        <p className="mt-2 text-sm text-slate-600">
          This area is restricted to an authorised privacy administrator or reviewer.
          Your account does not have that grant. A platform administrator can grant it
          from Platform → Risk access; no DPO appointment is required.
        </p>
        <Link className="btn btn-secondary btn-sm mt-4" href="/admin/anomalies">
          Return to workspace
        </Link>
      </section>
    );
  }

  const [
    cases,
    control,
    awaitingCountersignature,
    awaitingActivation,
    latestNotice,
    participants,
    freezes,
    frozenSignals,
    holds,
    keys,
    grants,
    organisation,
    adminCandidates,
  ] = await Promise.all([
    db.subjectRightsRequest.findMany({
      orderBy: { receivedAt: "desc" },
      take: 50,
      select: {
        caseRef: true,
        type: true,
        status: true,
        ackDeadline: true,
        resolutionDeadline: true,
        extendedDeadline: true,
        reviewerId: true,
        identityVerified: true,
        decision: true,
        receivedAt: true,
      },
    }),
    db.riskGlobalControl.findUnique({ where: { id: "global" }, select: { enabled: true, reason: true } }),
    db.participationAgreement.findMany({
      where: { state: "accepted" },
      orderBy: { acceptedAt: "asc" },
      take: 50,
      select: {
        id: true,
        type: true,
        version: true,
        documentSha256: true,
        acceptedAt: true,
        signatoryName: true,
        signatoryRole: true,
        tenantId: true,
      },
    }),
    db.participationAgreement.findMany({
      where: { state: "countersigned" },
      orderBy: { countersignedAt: "asc" },
      take: 50,
      select: {
        id: true,
        type: true,
        version: true,
        documentSha256: true,
        countersignedAt: true,
        tenantId: true,
      },
    }),
    db.employeePrivacyNotice.findFirst({
      orderBy: { effectiveDate: "desc" },
      select: { version: true, effectiveDate: true },
    }),
    db.riskIntelligenceConsent.findMany({
      where: { status: "active" },
      orderBy: { consentedAt: "desc" },
      take: 100,
      select: {
        tenantId: true,
        scope: true,
        suspendedAt: true,
        expelledAt: true,
        eligibilityVerified: true,
        controllerRegistrationChecked: true,
        tenant: { select: { name: true, legalName: true } },
      },
    }),
    db.riskSubjectFreeze.findMany({
      where: { status: "frozen" },
      orderBy: { frozenAt: "desc" },
      take: 50,
      select: { id: true, subjectKey: true, caseRef: true, reason: true, frozenAt: true },
    }),
    db.agentRiskSignal.findMany({
      where: { status: { in: ["frozen", "disputed_frozen"] } },
      orderBy: { frozenAt: "desc" },
      take: 50,
      select: { id: true, tenantId: true, category: true, status: true, frozenAt: true },
    }),
    db.riskLegalHold.findMany({
      where: { releasedAt: null },
      orderBy: { reviewDate: "asc" },
      take: 50,
      select: {
        id: true,
        scopeType: true,
        scopeId: true,
        reason: true,
        reviewDate: true,
        extensionUntil: true,
        tenantId: true,
      },
    }),
    db.riskKeyVersion.findMany({
      orderBy: { version: "desc" },
      select: { version: true, status: true, activatedAt: true, retiredAt: true },
    }),
    db.riskPrivacyAccess.findMany({
      where: { active: true },
      orderBy: { createdAt: "asc" },
      select: { userId: true, role: true, reason: true, createdAt: true },
    }),
    getRiskOrganisationConfig(),
    session?.tenantId
      ? db.user.findMany({
          where: { tenantId: session.tenantId, role: "admin", status: "active" },
          orderBy: { fullName: "asc" },
          select: { id: true, fullName: true, email: true },
        })
      : Promise.resolve([]),
  ]);

  const participantRows = participants.filter(
    (row): row is (typeof participants)[number] & { tenantId: string } => Boolean(row.tenantId)
  );
  const tenantIds = [
    ...new Set([
      ...awaitingCountersignature.map((row) => row.tenantId),
      ...awaitingActivation.map((row) => row.tenantId),
      ...participantRows.map((row) => row.tenantId),
      ...frozenSignals.map((row) => row.tenantId).filter((id): id is string => Boolean(id)),
    ]),
  ];
  const [tenants, grantUsers] = await Promise.all([
    tenantIds.length
      ? db.businessTenant.findMany({
          where: { id: { in: tenantIds } },
          select: { id: true, name: true, legalName: true },
        })
      : Promise.resolve([]),
    grants.length
      ? db.user.findMany({
          where: { id: { in: grants.map((row) => row.userId) } },
          select: { id: true, fullName: true, email: true },
        })
      : Promise.resolve([]),
  ]);
  const tenantNames = new Map(tenants.map((row) => [row.id, row.legalName ?? row.name]));
  const users = new Map(grantUsers.map((row) => [row.id, row]));
  const latestParticipants = new Map<string, (typeof participantRows)[number]>();
  for (const row of participantRows) {
    if (!latestParticipants.has(row.tenantId)) latestParticipants.set(row.tenantId, row);
  }

  return (
    <div className="space-y-4">
      <PrivacyReviewClient
        role={grant.role}
        currentUserId={session?.userId ?? null}
        globalEnabled={control?.enabled ?? null}
        globalReason={control?.reason ?? null}
        awaitingCountersignature={awaitingCountersignature.map((row) => ({
          id: row.id,
          businessName: tenantNames.get(row.tenantId) ?? "Business",
          type: row.type,
          version: row.version,
          documentSha256: row.documentSha256,
          acceptedAt: row.acceptedAt?.toISOString() ?? null,
          signatoryName: row.signatoryName,
          signatoryRole: row.signatoryRole,
        }))}
        awaitingActivation={awaitingActivation.map((row) => ({
          id: row.id,
          businessName: tenantNames.get(row.tenantId) ?? "Business",
          type: row.type,
          version: row.version,
          countersignedAt: row.countersignedAt?.toISOString() ?? null,
        }))}
        cases={cases.map((row) => ({
          caseRef: row.caseRef,
          type: row.type,
          status: row.status,
          ackDeadline: row.ackDeadline.toISOString(),
          resolutionDeadline: row.resolutionDeadline.toISOString(),
          effectiveDeadline: (row.extendedDeadline ?? row.resolutionDeadline).toISOString(),
          reviewerId: row.reviewerId,
          identityVerified: row.identityVerified,
          decision: row.decision,
          receivedAt: row.receivedAt.toISOString(),
        }))}
        reviewerOptions={grants.map((row) => ({
          userId: row.userId,
          fullName: users.get(row.userId)?.fullName ?? row.userId,
          email: users.get(row.userId)?.email ?? "",
          role: row.role,
        }))}
        adminCandidates={adminCandidates.map((row) => ({
          userId: row.id,
          fullName: row.fullName,
          email: row.email,
        }))}
        grants={grants.map((row) => ({
          userId: row.userId,
          fullName: users.get(row.userId)?.fullName ?? row.userId,
          email: users.get(row.userId)?.email ?? "",
          role: row.role,
          reason: row.reason,
          createdAt: row.createdAt.toISOString(),
        }))}
        participants={Array.from(latestParticipants.values()).map((row) => ({
          tenantId: row.tenantId,
          businessName: row.tenant?.legalName || row.tenant?.name || tenantNames.get(row.tenantId) || "Business",
          scope: row.scope,
          suspendedAt: row.suspendedAt?.toISOString() ?? null,
          expelledAt: row.expelledAt?.toISOString() ?? null,
          eligibilityVerified: row.eligibilityVerified,
          controllerRegistrationChecked: row.controllerRegistrationChecked,
        }))}
        freezes={freezes.map((row) => ({
          id: row.id,
          subjectKey: row.subjectKey,
          caseRef: row.caseRef,
          reason: row.reason,
          frozenAt: row.frozenAt.toISOString(),
        }))}
        frozenSignals={frozenSignals.map((row) => ({
          id: row.id,
          businessName: row.tenantId ? tenantNames.get(row.tenantId) ?? row.tenantId : "Unknown business",
          category: row.category,
          status: row.status,
          frozenAt: row.frozenAt?.toISOString() ?? null,
        }))}
        holds={holds.map((row) => ({
          id: row.id,
          scopeType: row.scopeType,
          scopeId: row.scopeId,
          businessName: row.tenantId ? tenantNames.get(row.tenantId) ?? row.tenantId : "Global",
          reason: row.reason,
          reviewDate: row.reviewDate.toISOString(),
          extensionUntil: row.extensionUntil?.toISOString() ?? null,
        }))}
        keys={keys.map((row) => ({
          version: row.version,
          status: row.status,
          activatedAt: row.activatedAt.toISOString(),
          retiredAt: row.retiredAt?.toISOString() ?? null,
        }))}
        organisationSettings={organisation.settings}
      />
      <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-base font-bold text-slate-900">Employee privacy notice</h2>
        <NoticePublisher
          currentVersion={latestNotice?.version ?? null}
          currentEffectiveDate={latestNotice?.effectiveDate.toISOString().slice(0, 10) ?? null}
        />
      </div>
    </div>
  );
}
