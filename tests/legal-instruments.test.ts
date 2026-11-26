import { describe, expect, it } from "vitest";
import {
  BLOOMCORE_REGISTERED_NAME,
  BLOOMCORE_REGISTRATION_NUMBER,
  BLOOMCORE_TIN,
  LegalInstrumentConfigurationError,
  assertNoUnresolvedText,
  renderLegalInstrument,
  renderPublicPrivacyAddendum,
  type BloomCoreLegalProfile,
  type BusinessLegalProfile,
} from "@/lib/risk-intelligence/legal-instruments";

const business: BusinessLegalProfile = {
  tenantId: "tenant-1",
  legalName: "Example Susu Business",
  registrationNumber: "BN000000001",
  address: "Accra, Greater Accra Region",
  contactEmail: "owner@example.test",
  contactPhone: "+233200000000",
};

const configuredProfile: BloomCoreLegalProfile = {
  registeredName: BLOOMCORE_REGISTERED_NAME,
  registrationNumber: BLOOMCORE_REGISTRATION_NUMBER,
  registeredOffice: "Accra, Greater Accra Region",
  registeredOfficeConfirmed: true,
  contactEmail: "privacy@example.test",
  signatoryName: "Verified Signatory",
  signatoryCapacity: "Authorised Representative",
  signatoryConfigured: true,
};

describe("controlled legal instruments", () => {
  it("never renders the TIN or an unauthorised company name", () => {
    const addendum = renderPublicPrivacyAddendum(configuredProfile, {
      providers: "Example Hosting Ghana",
      regions: "Ghana",
      configured: true,
    });
    expect(addendum).toContain(BLOOMCORE_REGISTERED_NAME);
    expect(addendum).toContain(BLOOMCORE_REGISTRATION_NUMBER);
    expect(addendum).not.toContain(BLOOMCORE_TIN);
    expect(addendum).not.toMatch(/BloomCore Technologies Ltd|BloomCore Technologies Limited/i);
    expect(addendum).not.toContain("{{");
  });

  it("renders the employee notice with the organisation contact by default", () => {
    const notice = renderLegalInstrument("employee_notice", {
      business,
      employee: { userId: "worker-1", fullName: "Ama Example", phoneLastFour: "0000" },
      noticeVersion: "2026.11-notice-1",
      noticeEffectiveDate: "2026-11-25",
    });
    expect(notice).toContain("Ama Example");
    expect(notice).toContain("Example Susu Business");
    expect(notice).toContain(BLOOMCORE_REGISTERED_NAME);
    expect(notice).toContain("Privacy contact:");
    expect(notice).not.toContain(BLOOMCORE_TIN);
    expect(notice).not.toContain("{{");
  });

  it("fails closed when the BloomCore signatory is not configured", () => {
    expect(() =>
      renderLegalInstrument("joint_controller", {
        business,
        bloomcore: { ...configuredProfile, signatoryName: "", signatoryCapacity: "", signatoryConfigured: false },
        signatory: {
          userId: "admin-1",
          fullName: "Business Owner",
          capacity: "Owner",
          authorityBasis: "owner of the business",
          authenticationMethod: "password and MFA",
        },
      })
    ).toThrow(LegalInstrumentConfigurationError);
  });

  it("renders a complete agreement when every fact is verified", () => {
    const text = renderLegalInstrument("participation_terms", {
      business,
      bloomcore: configuredProfile,
      signatory: {
        userId: "admin-1",
        fullName: "Business Owner",
        capacity: "Owner",
        authorityBasis: "owner of the business",
        authenticationMethod: "password and MFA",
      },
    });
    expect(text).toContain("Business Owner");
    expect(text).toContain("Verified Signatory");
    expect(text).not.toContain("{{");
    expect(text).not.toContain(BLOOMCORE_TIN);
  });

  it("rejects a leaked TIN or an unauthorised legal name in any instrument", () => {
    expect(() => assertNoUnresolvedText("Tax " + BLOOMCORE_TIN)).toThrow();
    expect(() => assertNoUnresolvedText("BloomCore Technologies Limited")).toThrow();
  });
});
