import { requirePlatformAdmin } from "@/lib/platform-auth";
import { db } from "@/lib/db";
import { getRiskOrganisationConfig } from "@/lib/risk-intelligence/organisation-profile";
import PlatformCountersignPanel from "@/components/PlatformCountersignPanel";
import NoticePublisher from "@/components/NoticePublisher";
import PrivacyAccessPanel, {
  type ActivePrivacyGrant,
  type PrivacyCandidate,
} from "@/components/PrivacyAccessPanel";
import RiskOrganisationSettingsForm from "@/components/RiskOrganisationSettingsForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "Risk access · Platform" };

export default async function PlatformRiskAccessPage() {
  const session = await requirePlatformAdmin();
  const [config, grants, pendingAgreements, currentNotice] = await Promise.all([
    getRiskOrganisationConfig(),
    db.riskPrivacyAccess.findMany({
      where: { active: true },
      orderBy: { createdAt: "asc" },
      select: { userId: true, role: true, reason: true, grantedById: true, createdAt: true },
    }),
    db.participationAgreement.findMany({
      where: { state: "accepted" },
      orderBy: { acceptedAt: "asc" },
      select: {
        id: true,
        type: true,
        version: true,
        signatoryName: true,
        acceptedAt: true,
        tenantId: true,
      },
    }),
    db.employeePrivacyNotice.findFirst({
      orderBy: { effectiveDate: "desc" },
      select: { version: true, effectiveDate: true },
    }),
  ]);
  const userIds = grants.map((grant) => grant.userId);
  const users = userIds.length
    ? await db.user.findMany({
        where: { id: { in: userIds } },
        select: {
          id: true,
          fullName: true,
          email: true,
          status: true,
          tenant: { select: { name: true, legalName: true } },
        },
      })
    : [];
  const userById = new Map(users.map((user) => [user.id, user]));
  const agreementTenantIds = [...new Set(pendingAgreements.map((agreement) => agreement.tenantId))];
  const agreementTenants = agreementTenantIds.length
    ? await db.businessTenant.findMany({
        where: { id: { in: agreementTenantIds } },
        select: { id: true, name: true, legalName: true },
      })
    : [];
  const tenantNameById = new Map(
    agreementTenants.map((tenant) => [tenant.id, tenant.legalName || tenant.name])
  );
  const grantedIds = new Set(userIds);
  const adminUsers = await db.user.findMany({
    where: { role: "admin", status: "active", tenantId: { not: null } },
    orderBy: { fullName: "asc" },
    select: {
      id: true,
      fullName: true,
      email: true,
      tenant: { select: { name: true, legalName: true } },
    },
  });
  const candidates: PrivacyCandidate[] = adminUsers
    .filter((user) => !grantedIds.has(user.id))
    .map((user) => ({
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      tenantName: user.tenant?.legalName || user.tenant?.name || "Business",
    }));
  const activeGrants: ActivePrivacyGrant[] = grants.map((grant) => {
    const user = userById.get(grant.userId);
    return {
      userId: grant.userId,
      fullName: user?.fullName ?? "Unknown user",
      email: user?.email ?? grant.userId,
      role: grant.role,
      reason: grant.reason,
    };
  });
  // Retired dpo grants are historical audit labels, not active administrators.
  const privacyAdministrators = grants.filter(
    (grant) => grant.role === "privacy_admin"
  ).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink-deep">Risk intelligence access</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-muted">
          Platform owners maintain the public legal facts and may grant optional least-privilege privacy
          access to an existing business administrator. No DPO or DPS appointment is required, and no
          business, agent or risk-intelligence onboarding step waits for this grant. Signed in as
          {" "}{session.fullName}.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-line bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Privacy administrators</p>
          <p className="mt-1 text-2xl font-semibold text-ink-deep">{privacyAdministrators}</p>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Privacy reviewers</p>
          <p className="mt-1 text-2xl font-semibold text-ink-deep">{grants.filter((g) => g.role === "privacy_reviewer").length}</p>
        </div>
        <div className="rounded-xl border border-line bg-white p-4">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Controlled execution ready</p>
          <p className="mt-1 text-sm font-medium text-ink-deep">
            {config.legal.signatoryConfigured && config.settings.registeredOfficeConfirmed
              ? "Signatory and office recorded"
              : "Signatory or office missing"}
          </p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <PrivacyAccessPanel candidates={candidates} grants={activeGrants} />
        <RiskOrganisationSettingsForm settings={config.settings} canEdit />
      </div>

      <PlatformCountersignPanel
        agreements={pendingAgreements.map((agreement) => ({
          id: agreement.id,
          tenantName: tenantNameById.get(agreement.tenantId) ?? "Business",
          type: agreement.type,
          version: agreement.version,
          signatoryName: agreement.signatoryName,
          acceptedAt: agreement.acceptedAt?.toISOString() ?? null,
        }))}
      />

      <section className="rounded-xl border border-line bg-white p-5">
        <h2 className="text-base font-semibold text-ink-deep">Employee privacy notice</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Publish the controlled Instrument 3 notice. This is a document-control action, not a DPO
          approval, and it does not create a DPO account.
        </p>
        <NoticePublisher
          currentVersion={currentNotice?.version ?? null}
          currentEffectiveDate={currentNotice?.effectiveDate.toISOString().slice(0, 10) ?? null}
        />
      </section>

      <p className="text-xs text-ink-muted">
        This screen does not create businesses, employees or reviewer accounts, and it does not enable a
        demonstration mode. Grants apply to the live application and are audited.
      </p>
    </div>
  );
}
