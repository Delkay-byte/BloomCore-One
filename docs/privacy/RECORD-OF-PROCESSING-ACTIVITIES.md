# Record of Processing Activities — Shared Agent Risk Intelligence

Controller: BLOOMCORE TECHNOLOGIES, Business Registration Number BN428031125.
Document owner: privacy function. Version: 2026.11-ropa-1.
Status: internal operational record. It is not a claim of DPC registration or approval.

## 1. Scope

This record covers the Shared Agent Risk Intelligence module in MaaCash and the
related employee-notice, agreement, rights and audit processing. It does not
replace the separate record for single-tenant accounting, Mobile Money, Susu,
payroll or customer records.

## 2. Roles

| Processing | Controller | Processor |
| --- | --- | --- |
| Single-tenant accounting, staff and transaction records | The participating business | BLOOMCORE TECHNOLOGIES |
| Shared Register signals, matching, banding and disclosure | BLOOMCORE TECHNOLOGIES and the participating business as joint controllers | Infrastructure and email sub-processors |
| Employee notice and acknowledgement | The employing business; BloomCore supports the workflow | BLOOMCORE TECHNOLOGIES |

The Joint Controller Agreement allocates enrolment, closed-record verification,
signal submission and employment decisions to the business; architecture,
HMAC-SHA256 pseudonymisation, thresholds, banding and 180-day decay to BloomCore.

## 3. Data subjects and categories

| Data subject | Personal data | Source |
| --- | --- | --- |
| Agents and employees of participating businesses | Normalised name and phone number, converted on submission to an HMAC-SHA256 subject key; employee name and phone suffix in the notice workflow | Business user records and the employing business |
| Business signatories and administrators | Name, role, authority basis, authentication method, timestamps, IP/session evidence | The signatory and the authentication system |
| Data subjects exercising rights | Name/contact details, case reference, request type, identity-verification evidence, communications | The data subject and the business |
| privacy lead and reviewers | User id, access role, grant/revocation metadata | Internal access control |

The Shared Register does not receive Ghana Card numbers, bank or mobile-money
numbers, free-text identity documents or another business's internal notes.
Signals carry a category, severity, coarse band, month-level dates and a
tenant-scoped source reference that is never disclosed.

## 4. Purposes and lawful basis

| Purpose | Basis (Act 843) |
| --- | --- |
| Prevent recurrent reconciliation losses and prompt verification of closed operational records | s. 20(1)(e) legitimate interests, supported by a documented balancing assessment |
| Operate thresholds, freezes, disputes and subject rights | ss. 20(2)-(3), 33, 35, 39, 43 |
| Execute participation and joint-controller agreements | s. 20 and Act 772 ss. 5, 7, 8, 10-12, 23 |
| Security, audit and breach response | ss. 28-31 |
| Retention and lawful deletion | s. 18; NRCD 54 s. 4; Act 772 s. 8 |

Consent is used for participation in the share_signals scope, not as the
lawful basis for the underlying legitimate-interest processing. Withdrawal of
participation stops future inclusion without rewriting prior lawful disclosures.

## 5. Recipients and disclosures

Recipients are limited to authenticated participating businesses that query the
register and satisfy every gate: at least 20 active eligible share_signals
businesses, at least 3 independent other contributors, at least 2 independent
contributors for the category, current consent and policy, executed agreements,
verified employee notice evidence, and no suspension, expulsion, withdrawal,
freeze or expiry. Disclosures are banded and carry the mandatory five-line
non-reliance explanation. A query-only business never counts toward the network.

Sub-processors: the application hosting provider, the managed PostgreSQL
provider where used, the managed secret store and the transactional email
provider. The current providers and regions must be recorded in the privacy lead
infrastructure schedule and reflected in `RISK_HOSTING_PROVIDERS` and
`RISK_HOSTING_REGIONS` before the public addendum asserts them.

## 6. Retention

| Record | Retention |
| --- | --- |
| Active signal | 180 days from the end of the observation period; excluded on day 181 |
| Expired, withdrawn or finally resolved disputed signal | Subject key, internal note and source id irreversibly scrubbed 90 days after expiry, withdrawal or final resolution |
| Disclosure audit | 24 months, then de-identified |
| Executed agreement, authority and consent record | Relationship duration plus 6 years |
| Subject-rights case | Resolution plus 6 years, subject to a scoped legal hold |
| Security and access audit | Per the security retention schedule; not shortened by this module |
| Legal hold | Until release, with a 14-day review and one documented extension |

Financial records and statutory audit retention are outside this module and are
not shortened, altered or deleted by risk retention sweeps.

## 7. International transfers

Where the hosting, database, secret store or email provider stores or accesses
data outside Ghana, BloomCore relies on an adequacy finding or appropriate
safeguards under Act 843 ss. 18(2), 28 and 30, with written processor terms.
The specific provider/region schedule is maintained by the privacy lead. The public
addendum does not name a provider or region until both environment values are
configured.

## 8. Security measures

Tenant-scoped queries and server-side authorisation; HMAC-SHA256 subject keys
with versioned keys and dual-key matching during rotation; the salt isolated in
a managed secret store separate from database credentials; encrypted transport;
role-restricted privacy access through `RiskPrivacyAccess`; immutable audit events;
idempotent notification evidence; no cross-business identity or note in any
disclosure or email.

## 9. Data subject rights

Access, correction, objection, challenge, human review and complaint are handled
through `SubjectRightsRequest`. Acknowledgement is due within 3 business days,
excluding weekends and gazetted Ghana public holidays; resolution within 21
calendar days; one reasoned extension of up to 14 calendar days notified before
the deadline. A challenge freezes the subject across all key versions while the
case is open. The holiday-calendar version is stored with each request.

## 10. Agreements and notices

Four controlled instruments are used: Joint Controller Agreement, Business
Participation and Data-Sharing Terms, Single-Tenant Data Processing Addendum
(conditional where a business already has equivalent terms), and the Employee
and Agent Privacy Notice. The public MaaCash Privacy Policy carries Instrument 4
as an addendum. Execution is electronic under Act 772 with SHA-256 evidence,
password re-authentication, a BloomCore countersignature and an execution
certificate. See `CONTROLLED-LEGAL-INSTRUMENTS.md`.

## 11. Open items

- privacy lead to confirm the lawful-balancing assessment and the final joint-controller allocation.
- Lawyer to confirm the electronic-authentication method and the integration edits in `LEGAL-SOURCE-DISCREPANCIES.md`.
- Owner to configure the authorised BloomCore signatory, registered address, hosting providers/regions and production salt.
- privacy lead to record the actual sub-processor names, regions and contract references.
- DPC registration/notification position to be confirmed; this record asserts none.
