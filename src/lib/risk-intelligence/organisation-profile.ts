import { db } from "@/lib/db";
import {
  BLOOMCORE_PRIVACY_EMAIL,
  bloomCoreLegalProfile,
  infrastructureStatement,
  type BloomCoreLegalProfile,
  type InfrastructureStatement,
} from "./legal-instruments";

export interface RiskOrganisationSettings {
  registeredOffice: string;
  registeredOfficeConfirmed: boolean;
  privacyEmail: string;
  signatoryName: string;
  signatoryCapacity: string;
  hostingProviders: string;
  hostingRegions: string;
  configuredInDatabase: boolean;
  updatedAt: string | null;
}

export interface RiskOrganisationConfig {
  legal: BloomCoreLegalProfile;
  infrastructure: InfrastructureStatement;
  settings: RiskOrganisationSettings;
}

/**
 * Owner-confirmed facts override deployment fallbacks. The registered name,
 * company number and TIN are constants in legal-instruments.ts and are not
 * editable through this profile.
 */
export async function getRiskOrganisationConfig(): Promise<RiskOrganisationConfig> {
  const fallbackLegal = bloomCoreLegalProfile();
  const fallbackInfrastructure = infrastructureStatement();
  let row: {
    registeredOffice: string | null;
    registeredOfficeConfirmed: boolean;
    privacyEmail: string | null;
    signatoryName: string | null;
    signatoryCapacity: string | null;
    hostingProviders: string | null;
    hostingRegions: string | null;
    updatedAt: Date;
  } | null = null;
  try {
    row = await db.riskOrganisationProfile.findUnique({
      where: { id: "bloomcore" },
      select: {
        registeredOffice: true,
        registeredOfficeConfirmed: true,
        privacyEmail: true,
        signatoryName: true,
        signatoryCapacity: true,
        hostingProviders: true,
        hostingRegions: true,
        updatedAt: true,
      },
    });
  } catch {
    // Before the additive migration is applied, deployment configuration is
    // still authoritative and the public page must not fail.
    row = null;
  }

  const office = row?.registeredOfficeConfirmed ? row.registeredOffice?.trim() ?? "" : "";
  // The owner-approved privacy contact is canonical. A stale database row or a
  // generic support address must never replace it.
  const email = BLOOMCORE_PRIVACY_EMAIL;
  const signatoryName = row?.signatoryName?.trim() || fallbackLegal.signatoryName;
  const signatoryCapacity = row?.signatoryCapacity?.trim() || fallbackLegal.signatoryCapacity;
  const providers = row?.hostingProviders?.trim() || fallbackInfrastructure.providers;
  const regions = row?.hostingRegions?.trim() || fallbackInfrastructure.regions;

  return {
    legal: {
      ...fallbackLegal,
      registeredOffice: office || fallbackLegal.registeredOffice,
      registeredOfficeConfirmed: Boolean(office),
      contactEmail: email,
      signatoryName,
      signatoryCapacity,
      signatoryConfigured: Boolean(signatoryName && signatoryCapacity),
    },
    infrastructure: {
      providers,
      regions,
      configured: Boolean(providers && regions),
    },
    settings: {
      registeredOffice: row?.registeredOffice ?? "",
      registeredOfficeConfirmed: row?.registeredOfficeConfirmed ?? false,
      privacyEmail: email,
      signatoryName: row?.signatoryName ?? "",
      signatoryCapacity: row?.signatoryCapacity ?? "",
      hostingProviders: row?.hostingProviders ?? "",
      hostingRegions: row?.hostingRegions ?? "",
      configuredInDatabase: Boolean(row),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    },
  };
}
