import { createHash } from "node:crypto";

/**
 * Controlled legal instruments for Shared Agent Risk Intelligence.
 *
 * The operative wording comes from the privacy lawyer opinion of 25 November 2026.
 * This module only (a) inserts verified party, signatory, employee and
 * infrastructure facts, and (b) records document control metadata. It never
 * invents a clause. Two integration edits are flagged in
 * docs/privacy/LEGAL-SOURCE-DISCREPANCIES.md for lawyer confirmation:
 * the registered-name description in Instrument 1 and the added parties
 * preamble in Instrument 2.
 */

export const BLOOMCORE_REGISTERED_NAME = "BLOOMCORE TECHNOLOGIES";
export const BLOOMCORE_REGISTRATION_NUMBER = "BN428031125";
/** Tax identity. Server-only. It is never rendered into a public document. */
export const BLOOMCORE_TIN = "P0066415551";
/** Owner-approved public privacy contact. Never used as a sender identity. */
export const BLOOMCORE_PRIVACY_EMAIL = "bloomcoretechnologies@gmail.com";

/**
 * The address in the lawyer opinion is not treated as confirmed. It is used
 * only when the owner configures BLOOMCORE_REGISTERED_ADDRESS; otherwise the
 * instrument describes the registered office by reference to the Registrar of
 * Companies record, so an unconfirmed address never appears as a completed
 * value.
 */

export const LEGAL_INSTRUMENT_VERSION = "2026.11-legal-2";
export const LEGAL_INSTRUMENT_EFFECTIVE_DATE = "2026-11-25";
export const LEGAL_INSTRUMENT_SOURCE =
  "MaaCash Formal Ghana Law Opinion and Execution Instruments (25 November 2026), Part II";

export type LegalInstrumentType =
  | "joint_controller"
  | "participation_terms"
  | "processing_addendum"
  | "employee_notice";

export interface BloomCoreLegalProfile {
  registeredName: string;
  registrationNumber: string;
  registeredOffice: string;
  registeredOfficeConfirmed: boolean;
  contactEmail: string;
  signatoryName: string;
  signatoryCapacity: string;
  signatoryConfigured: boolean;
}

export interface BusinessLegalProfile {
  tenantId: string;
  legalName: string;
  registrationNumber: string;
  address: string;
  contactEmail: string;
  contactPhone: string;
}

export interface SignatoryProfile {
  userId: string;
  fullName: string;
  capacity: string;
  authorityBasis: string;
  authenticationMethod: string;
}

export interface EmployeeNoticeSubject {
  userId: string;
  fullName: string;
  phoneLastFour: string;
}

export interface InfrastructureStatement {
  providers: string;
  regions: string;
  configured: boolean;
}

export interface InstrumentRenderContext {
  business?: BusinessLegalProfile;
  bloomcore?: BloomCoreLegalProfile;
  signatory?: SignatoryProfile;
  employee?: EmployeeNoticeSubject;
  noticeVersion?: string;
  noticeEffectiveDate?: string;
  infrastructure?: InfrastructureStatement;
}

export interface InstrumentDefinition {
  type: LegalInstrumentType;
  title: string;
  version: string;
  effectiveDate: string;
  sourceDocument: string;
  audience: "business" | "employee" | "public";
  /** Which facts must be present before the text can be rendered. */
  requires: readonly ("business" | "bloomcore_signatory" | "employee")[];
}

export const INSTRUMENT_DEFINITIONS: readonly InstrumentDefinition[] = [
  {
    type: "joint_controller",
    title: "Joint Controller Agreement (Shared Agent Risk Intelligence)",
    version: LEGAL_INSTRUMENT_VERSION,
    effectiveDate: LEGAL_INSTRUMENT_EFFECTIVE_DATE,
    sourceDocument: LEGAL_INSTRUMENT_SOURCE + ", Instrument 1",
    audience: "business",
    requires: ["business", "bloomcore_signatory"],
  },
  {
    type: "participation_terms",
    title: "Business Participation and Data-Sharing Terms",
    version: LEGAL_INSTRUMENT_VERSION,
    effectiveDate: LEGAL_INSTRUMENT_EFFECTIVE_DATE,
    sourceDocument: LEGAL_INSTRUMENT_SOURCE + ", Instrument 2",
    audience: "business",
    requires: ["business", "bloomcore_signatory"],
  },
  {
    type: "processing_addendum",
    title: "Single-Tenant Data Processing Addendum",
    version: LEGAL_INSTRUMENT_VERSION,
    effectiveDate: LEGAL_INSTRUMENT_EFFECTIVE_DATE,
    sourceDocument: LEGAL_INSTRUMENT_SOURCE + ", Instrument 1 (single-tenant DPA reference)",
    audience: "business",
    requires: ["business", "bloomcore_signatory"],
  },
  {
    type: "employee_notice",
    title: "Employee and Agent Privacy Notice",
    version: LEGAL_INSTRUMENT_VERSION,
    effectiveDate: LEGAL_INSTRUMENT_EFFECTIVE_DATE,
    sourceDocument: LEGAL_INSTRUMENT_SOURCE + ", Instrument 3",
    audience: "employee",
    requires: ["business", "employee"],
  },
];

export class LegalInstrumentConfigurationError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super("Legal instrument is not configured: " + missing.join(", "));
    this.name = "LegalInstrumentConfigurationError";
    this.missing = missing;
  }
}

export function bloomCoreLegalProfile(): BloomCoreLegalProfile {
  const envAddress = process.env.BLOOMCORE_REGISTERED_ADDRESS?.trim() || "";
  const confirmed = Boolean(envAddress);
  const signatoryName = process.env.BLOOMCORE_AUTHORISED_SIGNATORY_NAME?.trim() || "";
  const signatoryCapacity = process.env.BLOOMCORE_AUTHORISED_SIGNATORY_CAPACITY?.trim() || "";
  return {
    registeredName: BLOOMCORE_REGISTERED_NAME,
    registrationNumber: BLOOMCORE_REGISTRATION_NUMBER,
    registeredOffice: confirmed
      ? envAddress
      : "the registered office address on record with the Office of the Registrar of Companies, Ghana",
    registeredOfficeConfirmed: confirmed,
    // Do not publish an address the owner has not configured. The addendum
    // then points to the public privacy policy's contact channel instead.
    contactEmail:
      process.env.BLOOMCORE_PRIVACY_EMAIL?.trim() || BLOOMCORE_PRIVACY_EMAIL,
    signatoryName,
    signatoryCapacity,
    signatoryConfigured: Boolean(signatoryName && signatoryCapacity),
  };
}

export function infrastructureStatement(): InfrastructureStatement {
  const providers = process.env.RISK_HOSTING_PROVIDERS?.trim() || "";
  const regions = process.env.RISK_HOSTING_REGIONS?.trim() || "";
  return { providers, regions, configured: Boolean(providers && regions) };
}

export function legalInstrumentMetadata<T extends LegalInstrumentType>(
  type: T
): InstrumentDefinition & { type: T } {
  const definition = INSTRUMENT_DEFINITIONS.find((entry) => entry.type === type);
  if (!definition) throw new Error("Unknown legal instrument: " + type);
  return definition as InstrumentDefinition & { type: T };
}

export function instrumentSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const TOKEN = /\{\{([a-zA-Z0-9_.]+)\}\}/g;

function valueAt(context: InstrumentRenderContext, path: string): string {
  switch (path) {
    case "document.version": return LEGAL_INSTRUMENT_VERSION;
    case "document.effectiveDate": return LEGAL_INSTRUMENT_EFFECTIVE_DATE;
    case "bloomcore.name": return context.bloomcore?.registeredName ?? BLOOMCORE_REGISTERED_NAME;
    case "bloomcore.registrationNumber": return context.bloomcore?.registrationNumber ?? BLOOMCORE_REGISTRATION_NUMBER;
    case "bloomcore.office": return context.bloomcore?.registeredOffice ?? "";
    case "bloomcore.contactEmail": return context.bloomcore?.contactEmail ?? "";
    case "bloomcore.signatoryName": return context.bloomcore?.signatoryName ?? "";
    case "bloomcore.signatoryCapacity": return context.bloomcore?.signatoryCapacity ?? "";
    case "business.legalName": return context.business?.legalName ?? "";
    case "business.registrationNumber": return context.business?.registrationNumber ?? "";
    case "business.address": return context.business?.address ?? "";
    case "business.contactEmail": return context.business?.contactEmail ?? "";
    case "business.contactPhone": return context.business?.contactPhone ?? "";
    case "signatory.name": return context.signatory?.fullName ?? "";
    case "signatory.capacity": return context.signatory?.capacity ?? "";
    case "signatory.authorityBasis": return context.signatory?.authorityBasis ?? "";
    case "signatory.authenticationMethod": return context.signatory?.authenticationMethod ?? "";
    case "employee.fullName": return context.employee?.fullName ?? "";
    case "employee.phoneLastFour": return context.employee?.phoneLastFour ?? "";
    case "notice.version": return context.noticeVersion ?? "";
    case "notice.effectiveDate": return context.noticeEffectiveDate ?? "";
    case "infrastructure.providers": return context.infrastructure?.providers ?? "";
    case "infrastructure.regions": return context.infrastructure?.regions ?? "";
    default: return "";
  }
}

/** Replace tokens and fail closed if any required fact is absent. */
export function renderLegalInstrument(
  type: LegalInstrumentType,
  context: InstrumentRenderContext
): string {
  const definition = legalInstrumentMetadata(type);
  // Always fill verified organisation facts from the deployment profile when
  // the caller did not supply them. In particular, the employee notice needs
  // the public privacy contact even though it does not require a signatory.
  context = {
    ...context,
    bloomcore: context.bloomcore ?? bloomCoreLegalProfile(),
    infrastructure: context.infrastructure ?? infrastructureStatement(),
  };
  if (definition.requires.includes("business") && !context.business) {
    throw new LegalInstrumentConfigurationError(["business profile"]);
  }
  if (definition.requires.includes("bloomcore_signatory")) {
    const profile = context.bloomcore ?? bloomCoreLegalProfile();
    context = { ...context, bloomcore: profile };
    if (!profile.signatoryConfigured) {
      throw new LegalInstrumentConfigurationError([
        "BLOOMCORE_AUTHORISED_SIGNATORY_NAME",
        "BLOOMCORE_AUTHORISED_SIGNATORY_CAPACITY",
      ]);
    }
    if (!context.signatory) {
      throw new LegalInstrumentConfigurationError(["business signatory details"]);
    }
  }
  if (definition.requires.includes("employee") && !context.employee) {
    throw new LegalInstrumentConfigurationError(["employee notice subject"]);
  }
  return populateInstrumentTemplate(TEMPLATES[type], context);
}

/**
 * Populate an already-controlled template. Used for the published employee
 * notice, whose text is stored once and personalised only with verified facts
 * at the point the employee reads or acknowledges it.
 */
export function populateInstrumentTemplate(
  template: string,
  context: InstrumentRenderContext
): string {
  const missing: string[] = [];
  const text = template.replace(TOKEN, (_match, path: string) => {
    const value = valueAt(context, path);
    if (!value.trim()) {
      missing.push(path);
      return "";
    }
    return value;
  });
  if (missing.length > 0) {
    throw new LegalInstrumentConfigurationError(Array.from(new Set(missing)));
  }
  assertNoUnresolvedText(text);
  return text;
}

/** Raw controlled Instrument 3 text, with tokens resolved only per employee. */
export function employeeNoticeTemplate(): string {
  return TEMPLATES.employee_notice;
}

export function assertNoUnresolvedText(text: string): void {
  if (/\{\{|\[INSERT|\[SIGNATORY|\[DOCUMENT|\[EFFECTIVE|\[BLOOMCORE/i.test(text)) {
    throw new Error("Legal instrument still contains an unresolved placeholder.");
  }
  if (/BloomCore Technologies Limited|BloomCore Technologies Ltd|\bLtd\b/i.test(text)) {
    throw new Error("Legal instrument contains an unauthorised BloomCore legal name.");
  }
  if (text.includes(BLOOMCORE_TIN)) {
    throw new Error("A public or executed instrument must not contain the TIN.");
  }
}

const COMMON_PARTIES = [
  "BLOOMCORE TECHNOLOGIES, a business duly registered under the laws of the Republic of Ghana",
  "with Business Registration Number {{bloomcore.registrationNumber}}, whose registered office is",
  "{{bloomcore.office}} (the “Platform Operator” or “BloomCore”); and",
  "",
  "{{business.legalName}}, a business registered under the laws of Ghana with Business",
  "Registration Number {{business.registrationNumber}}, whose principal place of business is",
  "{{business.address}} (the “Participating Controller”).",
].join("\n");

const TEMPLATES: Record<LegalInstrumentType, string> = {
  joint_controller: [
    "JOINT CONTROLLER AGREEMENT (SHARED AGENT RISK INTELLIGENCE)",
    "Document version {{document.version}} | Effective {{document.effectiveDate}}",
    "",
    "THIS JOINT CONTROLLER AGREEMENT (the “Agreement”) is entered into electronically on the date recorded in the execution certificate between:",
    "",
    COMMON_PARTIES,
    "",
    "1. Scope and Role Allocation (Act 843): For single-tenant accounting and staff records in MaaCash, the Participating Controller is the sole Data Controller, and BloomCore is the Data Processor under the Single-Tenant Data Processing Addendum. For the Shared Agent Risk Intelligence module (the “Shared Register”), BloomCore and the Participating Controller act as Joint Controllers under the Data Protection Act, 2012 (Act 843): the Participating Controller determines enrolment, closed-record verification, signal submission and employment decisions; BloomCore determines platform architecture, HMAC-SHA256 pseudonymisation, the 20-business active share_signals network threshold, the 3-business cohort gate, the 2-business category floor, banding and 180-day decay.",
    "",
    "2. Lawful Basis and Transparency (Act 843, ss. 19-22): Both parties process Shared Register data under section 20(1)(e) (legitimate interests in preventing recurrent reconciliation losses). The Participating Controller shall deliver the approved Employee and Agent Privacy Notice (Instrument 3) to each agent or employee before contributing any signal and record verifiable delivery evidence (EmployeeNoticeAttestation). BloomCore shall publish the MaaCash Privacy Notice Addendum (Instrument 4) and display the mandatory five-line non-reliance notices on all disclosures.",
    "",
    "3. Data Subject Rights and Adjudication (Act 843, ss. 20(2)-(3), 33, 35, 39 and 43): Data subjects may submit access, correction, objection or challenge requests to either party. BloomCore shall place contested signals into a fail-closed RiskSubjectFreeze across all key versions within 24 hours, acknowledge within 3 business days (excluding weekends and gazetted Ghana public holidays), and resolve within 21 calendar days, subject to one reasoned extension of up to 14 calendar days notified in writing before Day 21. The Participating Controller shall provide closed-record verification within 5 business days of a BloomCore privacy request without disclosing third-party confidential data.",
    "",
    "4. Security, Key Custody and Breach Notification (Act 843, ss. 28-31): BloomCore shall isolate RISK_INTELLIGENCE_SALT in a managed secret store separate from primary database credentials, enforce tenant isolation and maintain immutable audit logs. Each party shall notify the other within 12 hours of discovering any actual or suspected security compromise affecting Shared Register data and cooperate on statutory notification to the Data Protection Commission and affected individuals under section 31, with an internal operational target of 72 hours from confirmation.",
    "",
    "5. Retention and Deletion (Act 843, s. 18; Act 772, s. 8; NRCD 54, s. 4): Active signals expire 180 days from observedTo, excluded on Day 181. Expired, withdrawn and resolved disputed signals have subjectKey, internalNote and sourceId irreversibly scrubbed 90 days after expiry, withdrawal or final resolution unless a scoped Legal Hold applies. Disclosure logs are de-identified at Month 24. Executed agreements, authority records and consent records are retained for the duration of the relationship plus 6 years.",
    "",
    "6. Liability, Indemnities and Governing Law: Each party is liable for damage or distress caused by its breach of Act 843 or this Agreement. The Participating Controller shall indemnify and hold harmless BloomCore against all claims, regulatory penalties, defamation actions and legal costs arising from: (a) false, unverified, malicious or retaliatory signal submissions; (b) failure to deliver Employee Privacy Notices; or (c) adverse employment decisions taken in breach of the non-reliance covenant. Subject to statutory liabilities that cannot be excluded under Ghanaian law and excluding fraud, wilful misconduct, gross negligence and the foregoing indemnity, the aggregate liability of BloomCore under this Agreement shall not exceed the total fees paid by the Participating Controller in the 12 months preceding the claim. This Agreement is governed by the laws of the Republic of Ghana.",
    "",
    "ELECTRONIC EXECUTION BLOCK (ACT 772): Executed by {{signatory.name}}, {{signatory.capacity}}, for the Participating Controller, acting on the authority basis {{signatory.authorityBasis}}, through verified account authentication ({{signatory.authenticationMethod}}), and countersigned by {{bloomcore.signatoryName}}, {{bloomcore.signatoryCapacity}}, for BLOOMCORE TECHNOLOGIES. The SHA-256 digest of this operative text, the identities, the authority basis and the execution timestamps are recorded in the execution certificate held with the executed copy.",
  ].join("\n"),
  participation_terms: [
    "BUSINESS PARTICIPATION AND DATA-SHARING TERMS",
    "Document version {{document.version}} | Effective {{document.effectiveDate}}",
    "",
    "These Terms are entered into electronically between:",
    "",
    COMMON_PARTIES,
    "",
    "1. Eligibility and Enrolment Scopes: Only verified Tenant Administrators (role = admin) of active Ghanaian Mobile Money or Susu businesses with a valid business registration and an executed Joint Controller Agreement and Single-Tenant Data Processing Addendum may enrol under share_signals (contribute and query) or query_only (query only). Only active, unsuspended share_signals businesses count toward the mandatory 20-business network gate.",
    "",
    "2. Strict Contribution Standards: The Participating Business may submit at most one signal per closed internal investigation or anomaly record, strictly within the six permitted operational categories (shortage, repeated_shortage, unreconciled_day, evidence_gap, unconfirmed_handover, policy_breach), accompanied by a factual internal note of at least 10 characters, a reference to the supporting evidence in the closed record, a good-faith declaration and a verified Employee Privacy Notice attestation. Speculative, retaliatory or unverified reports are strictly prohibited.",
    "",
    "3. Non-Reliance and Fair Process Covenant: Outputs from Shared Agent Risk Intelligence are strictly prompts to verify internal records, never proof of theft, fraud or misconduct, and never a blacklist. The Participating Business shall not dismiss, suspend or refuse engagement to any individual solely on the basis of a MaaCash disclosure band, and shall afford the individual a fair opportunity to respond to any internal audit findings before any adverse employment decision.",
    "",
    "4. Withdrawal, Suspension and Expulsion: The Participating Business may withdraw at any time with a recorded reason; withdrawal immediately excludes all its open signals from future queries without altering prior lawful disclosures. BloomCore may immediately freeze signals, suspend participation or permanently expel any business suspected of bad-faith reporting, query abuse or breach of these Terms. An expelled business may participate again only after a documented BloomCore reinstatement decision made under the published participation terms.",
    "",
    "5. Electronic Execution (Act 772): This document is accepted electronically by {{signatory.name}}, {{signatory.capacity}}, for the Participating Business on the authority basis {{signatory.authorityBasis}}, through verified account authentication ({{signatory.authenticationMethod}}). It becomes operative only when countersigned by {{bloomcore.signatoryName}}, {{bloomcore.signatoryCapacity}}, for BLOOMCORE TECHNOLOGIES and activated in the register. The execution certificate records the SHA-256 digest of this text.",
  ].join("\n"),
  processing_addendum: [
    "SINGLE-TENANT DATA PROCESSING ADDENDUM",
    "Document version {{document.version}} | Effective {{document.effectiveDate}}",
    "",
    "This Addendum is entered into electronically between:",
    "",
    COMMON_PARTIES,
    "",
    "1. Roles: For the single-tenant accounting, staff, Mobile Money and Susu records that the Participating Controller keeps in MaaCash, the Participating Controller is the Data Controller and BLOOMCORE TECHNOLOGIES is the Data Processor. For the Shared Register, the parties act as Joint Controllers under the Joint Controller Agreement.",
    "",
    "2. Processor Obligations (Act 843, ss. 18(2), 28 and 30): BloomCore shall process personal data only on documented instructions from the Participating Controller, implement appropriate technical and organisational security measures, restrict access to authorised personnel, assist with data subject requests and breach notification, and impose equivalent obligations on sub-processors. BloomCore shall not use single-tenant records for any other purpose.",
    "",
    "3. Security and Breach Notification (Act 843, s. 31): BloomCore shall notify the Participating Controller without undue delay, and within 12 hours of confirmation, of any actual or suspected security compromise affecting single-tenant data, and shall cooperate on notification to the Data Protection Commission and affected data subjects within the statutory period.",
    "",
    "4. Retention and Return (Act 843, s. 18; NRCD 54, s. 4): Single-tenant records are retained for the duration of the subscription and the period required by Ghanaian financial, tax and contractual law, including the 6-year contractual limitation period. On termination, BloomCore shall return or delete personal data subject to those legal retention duties and shall certify deletion of what is not retained.",
    "",
    "5. Electronic Execution (Act 772): Accepted electronically by {{signatory.name}}, {{signatory.capacity}}, for the Participating Controller on the authority basis {{signatory.authorityBasis}}, through verified account authentication ({{signatory.authenticationMethod}}), and countersigned by {{bloomcore.signatoryName}}, {{bloomcore.signatoryCapacity}}, for BLOOMCORE TECHNOLOGIES. The execution certificate records the SHA-256 digest of this text.",
  ].join("\n"),
  employee_notice: [
    "EMPLOYEE AND AGENT PRIVACY NOTICE",
    "OPERATIONAL ACCOUNTABILITY AND SHARED RISK INTELLIGENCE",
    "",
    "Employer / Operator: {{business.legalName}} | Contact: {{business.contactEmail}} or {{business.contactPhone}}",
    "Platform Operator: BLOOMCORE TECHNOLOGIES (MaaCash) | Privacy contact: {{bloomcore.contactEmail}}",
    "Employee: {{employee.fullName}} | Employee reference ending: {{employee.phoneLastFour}}",
    "Notice version: {{notice.version}} | Effective date: {{notice.effectiveDate}}",
    "",
    "1. Purpose and Lawful Basis: {{business.legalName}} uses MaaCash to manage daily cash and mobile-money or Susu reconciliations under section 20(1)(e) of the Data Protection Act, 2012 (Act 843), relying on legitimate business interests in preventing reconciliation losses. Your employer has carried out and documented a balancing assessment, and this notice explains the processing before it begins.",
    "",
    "2. Pseudonymous Operational Signals: Where a closed internal review confirms a factual operational discrepancy, limited strictly to cash shortage, repeated shortage, unreconciled day, evidence gap, unconfirmed handover or policy breach, your employer may contribute a pseudonymous signal generated through a one-way cryptographic code (HMAC-SHA256) from your normalised name and phone number. Your name, phone number, Ghana Card or other identity number, bank or mobile-money number, and internal notes are never disclosed to other businesses. The signal carries only a broad category, a severity level, a coarse business band and month-level dates.",
    "",
    "3. Thresholds and 180-Day Expiry: No information is ever disclosed unless at least 20 active contributing businesses participate in the network, at least 3 independent other businesses have recorded signals, and at least 2 independent businesses report the same category. Disclosures show only broad categories, severity levels, coarse business bands (3 to 5, 6 to 9, or 10 or more businesses) and month-level dates as a prompt to verify records, never as proof of wrongdoing. Active signals expire automatically 180 days after the end of the observation period.",
    "",
    "4. Your Statutory Rights Under Act 843: You have the right to request access to records about you (s. 35), to request correction, blocking or erasure of inaccurate data (s. 33), to object to processing on reasonable grounds (ss. 20(2) and 39), to challenge any signal, and to complain to the Data Protection Commission of Ghana (s. 43). You may also request human review of any decision. Exercising your rights will never trigger automatic termination or disciplinary action. Requests are acknowledged within 3 business days, excluding weekends and gazetted Ghana public holidays, and resolved within 21 calendar days, with at most one reasoned extension of up to 14 calendar days notified before the original deadline. Challenged signals are frozen across all key versions while the case is open.",
    "",
    "5. Retention, Recipients and Safeguards: Active signals expire after 180 days. Expired, withdrawn and resolved disputed signals are irreversibly scrubbed of the pseudonymous key, internal note and source reference after 90 days unless a scoped legal hold applies. Disclosure logs are de-identified after 24 months. Recipients are limited to participating businesses that query the register, and no recipient receives your identity or another business notes. The platform uses tenant isolation, access controls, immutable audit logging and a managed secret store for the pseudonymisation key. A security compromise is notified to the Data Protection Commission and affected individuals as required by section 31.",
    "",
    "6. Acknowledgement of Receipt (not consent): I confirm that I have received and read this notice, that its purpose and my rights have been explained to me, and that I understand that acknowledging receipt is not consent, does not waive any right, and does not authorise my employer to take any employment decision on the basis of a disclosure band. I may withdraw this acknowledgement at any time without any adverse consequence, although the employer must still be able to evidence that notice was given.",
    "",
    "Employee acknowledgement: ______________________________   Date: ________________",
    "Recorded in MaaCash as an EmployeeNoticeAttestation bound to the SHA-256 of this exact notice text.",
  ].join("\n"),
};

/** Public addendum (Instrument 4) rendered without any unverified hosting claim. */
export function renderPublicPrivacyAddendum(
  bloomcore: BloomCoreLegalProfile = bloomCoreLegalProfile(),
  infrastructure: InfrastructureStatement = infrastructureStatement()
): string {
  const hosting = infrastructure.configured
    ? "Infrastructure is hosted by " + infrastructure.providers + " in " + infrastructure.regions + " under written processor safeguards compliant with Act 843 sections 18(2), 28 and 30, with RISK_INTELLIGENCE_SALT isolated in a separate secret manager."
    : "The current hosting providers and regions, and the written processor safeguards that apply to them, are recorded in the Record of Processing Activities of BloomCore and are provided to the Data Protection Commission on request. Where personal data is stored or backed up outside Ghana, BloomCore relies on an adequacy finding or appropriate safeguards under Act 843 sections 18(2), 28 and 30. RISK_INTELLIGENCE_SALT is isolated in a separate secret manager.";
  const lines = [
    "MAACASH PLATFORM PRIVACY NOTICE ADDENDUM",
    "SHARED AGENT RISK INTELLIGENCE",
    "Effective date: " + LEGAL_INSTRUMENT_EFFECTIVE_DATE + " | Document version: " + LEGAL_INSTRUMENT_VERSION,
    "",
    "Joint Controller: " + bloomcore.registeredName + ", Business Registration Number " + bloomcore.registrationNumber + ", registered office: " + bloomcore.registeredOffice + ". Privacy contact: " + bloomcore.contactEmail + ".",
    "",
    "1. Scope and Role: This Addendum supplements the MaaCash Privacy Policy and explains how BloomCore operates Shared Agent Risk Intelligence as a Joint Controller with participating Ghanaian mobile-money and Susu businesses under the Data Protection Act, 2012 (Act 843). For single-tenant accounting and staff records, each participating business is the Data Controller and BloomCore is the Data Processor.",
    "",
    "2. Categories of Data and Sub-Processors: MaaCash processes pseudonymous subjectKey digests, enumerated operational categories, severity levels, observation periods, 180-day expiry dates, tenant-scoped source references, audit trails and disclosure logs. " + hosting,
    "",
    "3. Lawful Basis and Thresholds: Processing relies on section 20(1)(e) legitimate interests in preventing recurrent reconciliation losses, supported by a documented balancing assessment. No disclosure is made unless at least 20 active eligible businesses participate, at least 3 independent other businesses have recorded live signals, and at least 2 independent businesses report the same category. A query-only business never counts toward the network threshold.",
    "",
    "4. Retention and Deletion: Active signals expire at 180 days. Expired, withdrawn and resolved disputed signals are scrubbed of subjectKey, internalNote and sourceId after 90 days unless a scoped legal hold applies. Disclosure logs are de-identified after 24 months. Executed agreements, authority records and consent records are retained for the relationship duration plus 6 years as contractual records under NRCD 54 and Act 772 section 8.",
    "",
    "5. Your Rights and How to Exercise Them: You may request access (s. 35), correction, blocking or erasure (s. 33), object (ss. 20(2) and 39), challenge a signal, request human review, or complain to the Data Protection Commission (s. 43) through your employer or through BloomCore " + (bloomcore.contactEmail.includes("@") ? "at " + bloomcore.contactEmail : "using the contact channel published on the MaaCash contact page") + ". We acknowledge within 3 business days, excluding weekends and gazetted Ghana public holidays, and resolve within 21 calendar days, with at most one reasoned extension of up to 14 calendar days notified before the original deadline. Challenged signals are frozen across all key versions while the case is open. Exercising a right never automatically affects employment.",
    "",
    "6. Security and Breach Notification: Access is restricted by role and tenant, actions are written to an immutable audit log, and the pseudonymisation key is held in a managed secret store separate from database credentials. A confirmed security compromise is notified to the Data Protection Commission and affected individuals under section 31, with an internal operational target of 72 hours from confirmation.",
    "",
    "7. Automated Decisions and Non-Reliance: The register does not make, and must not be used to make, an automated employment decision. A disclosure band is a prompt to verify internal records. It is not proof of theft, fraud or misconduct and must not be the sole basis for dismissal, suspension or refusal of engagement. Any internal audit finding must be put to the individual with particulars and a fair opportunity to respond.",
    "",
    "8. Contact and Complaints: BloomCore privacy contact: " + bloomcore.contactEmail + ". Data Protection Commission of Ghana: complaints may be submitted through the published channels of the Commission. This Addendum does not assert that any registration, approval or certification has been granted.",
  ];
  const text = lines.join("\n");
  assertNoUnresolvedText(text);
  return text;
}

export function publicPrivacyAddendumSha256(
  bloomcore?: BloomCoreLegalProfile,
  infrastructure?: InfrastructureStatement
): string {
  return instrumentSha256(renderPublicPrivacyAddendum(bloomcore, infrastructure));
}
