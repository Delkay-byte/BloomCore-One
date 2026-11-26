/**
 * Wording constants for employee notices and shared disclosures.
 *
 * These are product statements, not legal drafting. The owner and the
 * privacy adviser review the final text; no DPC approval or certificate is
 * asserted. Any material change requires a new policy version and fresh
 * acceptance.
 */

export const NOTICE_ACKNOWLEDGEMENT_IS_NOT_CONSENT =
  "A privacy notice acknowledgement is not consent. It does not create participation consent and does not waive any statutory rights.";

/** Shown prominently with every shared-risk disclosure. */
export const DISCLOSURE_EXPLANATION = [
  "This information is an operational review prompt only.",
  "It is not proof of misconduct and it is not a blacklist.",
  "It must not be the sole basis for any employment decision.",
  "The receiving business must independently investigate before acting.",
  "The employee retains the applicable access, objection and challenge rights.",
] as const;

export const RISK_NOTICE_VERSION = "employee-privacy-notice-2026.12";

/** Delivery evidence required before a business may contribute a real signal. */
export const ACCEPTED_NOTICE_DELIVERY_METHODS = [
  "in_person_signed",
  "email_read_receipt",
  "portal_acknowledgement",
] as const;

export type NoticeDeliveryMethod = (typeof ACCEPTED_NOTICE_DELIVERY_METHODS)[number];

/**
 * Provisional employee notice used only when an owner has not published the
 * controlled Instrument 3 notice. It states the statutory position and the
 * acknowledgement-is-not-consent rule, but it deliberately does not pass the
 * contribution gate: tenantRiskState requires a published, hashed notice.
 */
export const FALLBACK_EMPLOYEE_NOTICE_VERSION = "employee-privacy-notice-fallback-2026.12-2";

export const FALLBACK_EMPLOYEE_NOTICE_TEXT = [
  "EMPLOYEE PRIVACY NOTICE — SHARED AGENT RISK INTELLIGENCE (PROVISIONAL)",
  "",
  "Your employer uses MaaCash. If your employer joins the Shared Agent Risk Intelligence programme, it may share a limited operational signal about a closed internal record. A signal is a prompt for another participating business to check its own records. It is not proof of misconduct and it is not a blacklist.",
  "",
  "What may be shared: the kind of problem (for example, a shortage or an unreconciled day), a severity band, and the period it covers. Your name, phone number, notes, evidence files and your employer identity are never disclosed to another business.",
  "",
  "What is never shared: a single business report is never shown to another business. A category is disclosed only when at least two independent businesses report it, and only when the network meets the legal minimum. Signals expire after 180 days.",
  "",
  "Your rights under the Data Protection Act, 2012 (Act 843): you may ask for access to your personal data, ask for correction, object to processing, and ask for erasure where the law allows. Your employer must acknowledge a request within three business days and resolve it within 21 calendar days, with one reasoned extension of up to 14 calendar days. While an objection or challenge is adjudicated, the related signal is frozen.",
  "",
  "Acknowledgement of this notice is not consent. It does not create participation consent and does not waive any statutory right. You will not be penalised for exercising a right.",
  "",
  "This provisional text is shown because your employer has not yet published its own controlled notice. Ask your employer for its current notice, or contact BloomCore Technologies at bloomcoretechnologies@gmail.com. You may also complain to the Data Protection Commission through its published channels.",
].join("\n");
