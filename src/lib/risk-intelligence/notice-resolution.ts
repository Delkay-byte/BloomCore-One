import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { RISK_INTELLIGENCE_POLICY_VERSION } from "./policy";
import {
  LEGAL_INSTRUMENT_EFFECTIVE_DATE,
  populateInstrumentTemplate,
} from "./legal-instruments";
import { getRiskOrganisationConfig } from "./organisation-profile";
import { getBusinessLegalProfile, getEmployeeNoticeSubject } from "./business-profile";
import {
  FALLBACK_EMPLOYEE_NOTICE_TEXT,
  FALLBACK_EMPLOYEE_NOTICE_VERSION,
} from "./notices";

const FALLBACK_HASH = createHash("sha256")
  .update(FALLBACK_EMPLOYEE_NOTICE_TEXT, "utf8")
  .digest("hex");

export interface EffectiveNotice {
  version: string;
  title: string;
  documentText: string;
  documentHash: string;
  policyVersion: string;
  provisional: boolean;
}

/**
 * Resolve the exact notice an agent must read. The stored text may be the
 * controlled Instrument 3 template; verified employer and employee facts are
 * inserted per employee. A generic stored notice is returned as-is. An
 * incomplete profile fails closed instead of displaying a placeholder.
 */
export async function resolveEffectiveNotice(
  tenantId?: string | null,
  userId?: string | null
): Promise<EffectiveNotice> {
  const stored = await db.employeePrivacyNotice.findFirst({
    orderBy: { effectiveDate: "desc" },
    select: {
      version: true,
      title: true,
      documentText: true,
      effectiveDate: true,
      policyVersion: true,
    },
  });
  if (!stored) {
    return {
      version: FALLBACK_EMPLOYEE_NOTICE_VERSION,
      title: "Employee Privacy Notice — provisional",
      documentText: FALLBACK_EMPLOYEE_NOTICE_TEXT,
      documentHash: FALLBACK_HASH,
      policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
      provisional: true,
    };
  }
  if (!stored.documentText.includes("{{")) {
    return {
      version: stored.version,
      title: stored.title,
      documentText: stored.documentText,
      documentHash: createHash("sha256").update(stored.documentText, "utf8").digest("hex"),
      policyVersion: stored.policyVersion,
      provisional: false,
    };
  }
  const tenant = tenantId ?? "";
  const [business, employee, organisation] = await Promise.all([
    tenant ? getBusinessLegalProfile(tenant) : Promise.resolve(null),
    tenant && userId ? getEmployeeNoticeSubject(tenant, userId) : Promise.resolve(null),
    getRiskOrganisationConfig(),
  ]);
  if (!business?.profile || !employee) {
    throw new Error(
      "Your employer must complete its business legal profile, and your employee record must include your name and phone number, before this notice can be issued."
    );
  }
  const documentText = populateInstrumentTemplate(stored.documentText, {
    business: business.profile,
    bloomcore: organisation.legal,
    employee,
    noticeVersion: stored.version,
    noticeEffectiveDate:
      stored.effectiveDate.toISOString().slice(0, 10) || LEGAL_INSTRUMENT_EFFECTIVE_DATE,
  });
  return {
    version: stored.version,
    title: stored.title,
    documentText,
    documentHash: createHash("sha256").update(documentText, "utf8").digest("hex"),
    policyVersion: stored.policyVersion,
    provisional: false,
  };
}
