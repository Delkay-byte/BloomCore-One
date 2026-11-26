import { config as loadEnv } from "dotenv";
import { db } from "../src/lib/db";

// The tsx runner does not load Next.js env files automatically. Load only the
// local development files; never print a value and never override a managed
// deployment variable that is already present.
loadEnv({ path: ".env" });
if (process.env.NODE_ENV !== "production") {
  loadEnv({ path: ".env.risk-intelligence.local", override: false });
}

/**
 * Read-only deployment readiness check. It prints counts and configuration
 * presence, never secret values and never personal data.
 */
async function main() {
  const tables = await db.$queryRawUnsafe<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  );
  const names = new Set(tables.map((row) => row.name));
  const required = [
    "RiskIntelligenceConsent",
    "AgentRiskSignal",
    "RiskIntelligenceDisclosure",
    "RiskGlobalControl",
    "RiskControlEvent",
    "RiskKeyVersion",
    "RiskLegalHold",
    "SubjectRightsRequest",
    "EmployeePrivacyNotice",
    "EmployeeNoticeAttestation",
    "ParticipationAgreement",
    "RiskPrivacyAccess",
    "GovernanceDocumentDelivery",
    "RiskOrganisationProfile",
  ];
  const present = required.filter((name) => names.has(name));
  const missing = required.filter((name) => !names.has(name));

  const count = async (model: string, where = "") => {
    try {
      const rows = await db.$queryRawUnsafe<{ n: number }[]>(
        "SELECT COUNT(*) AS n FROM \"" + model + "\"" + (where ? " WHERE " + where : "")
      );
      return Number(rows[0]?.n ?? 0);
    } catch {
      return null;
    }
  };

  const control = names.has("RiskGlobalControl")
    ? await db.riskGlobalControl.findUnique({ where: { id: "global" } })
    : null;

  console.log(JSON.stringify({
    tables: { present, missing },
    counts: {
      activeTenants: await count("BusinessTenant", "status = 'ACTIVE'"),
      activeShareConsents: await count(
        "RiskIntelligenceConsent",
        "status = 'active' AND scope = 'share_signals'"
      ),
      exercisedAgreements: names.has("ParticipationAgreement")
        ? await count("ParticipationAgreement", "state IN ('executed','active')")
        : null,
      liveOpenSignals: names.has("AgentRiskSignal")
        ? await count("AgentRiskSignal", "status = 'open'")
        : null,
      verifiedNoticeAttestations: names.has("EmployeeNoticeAttestation")
        ? await count("EmployeeNoticeAttestation", "verified = 1")
        : null,
      activePrivacyGrants: names.has("RiskPrivacyAccess")
        ? await count("RiskPrivacyAccess", "active = 1 AND revokedAt IS NULL")
        : null,
    },
    globalControl: control
      ? { enabled: control.enabled, reason: control.reason }
      : null,
    configuration: {
      saltPresent: Boolean(process.env.RISK_INTELLIGENCE_SALT),
      bloomcoreSignatoryPresent: Boolean(
        process.env.BLOOMCORE_AUTHORISED_SIGNATORY_NAME &&
          process.env.BLOOMCORE_AUTHORISED_SIGNATORY_CAPACITY
      ),
      bloomcoreAddressPresent: Boolean(process.env.BLOOMCORE_REGISTERED_ADDRESS),
      resendPresent: Boolean(process.env.RESEND_API_KEY),
      resendFromPresent: Boolean(process.env.EMAIL_FROM || process.env.EMAIL_FROM_SECURITY),
      retentionTokenPresent: Boolean(process.env.RISK_RETENTION_TOKEN),
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Readiness check failed.");
  process.exitCode = 1;
});
