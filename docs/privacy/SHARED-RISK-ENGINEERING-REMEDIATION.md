# Shared Risk Intelligence — engineering remediation

Status: implemented in code; owner-authorised deployment, production
configuration and DPC/lawyer confirmation remain outstanding. This document
records what the application does, not what is legally approved.
Where a statutory citation appears, it is to Ghana's Data Protection Act, 2012
(**Act 843**). Some supplied source documents cite "Act 896"; that citation is
incorrect. The Final Privacy Determinations package confirms sections 20(1)(e),
20(2), 20(3) and 39 (basis and objection), 33 and 35 (access/correction), 31
(breach notice), 46–56 (registration), 57(1) (assessable processing) and 18(2),
28, 30 (cross-border safeguards). Older section numbers are not carried into
this implementation.

## Implemented code

| Requirement | Implementation | Server-side enforcement |
| --- | --- | --- |
| ENG-01 network | `src/lib/risk-intelligence/policy.ts` (`RISK_INTELLIGENCE_MIN_NETWORK = 20`), `governance-state.ts` (`eligibleNetworkSize`) | `querySharedRiskSignals` counts active, share-signals, current-policy, unsuspended consents at query time. Below 20 the answer is `insufficient_network`; never an empty "clean" result. Query-only, withdrawn, suspended and expired/disputed/frozen signals are excluded. Three distinct other contributors, two per disclosed category. |
| ENG-02 frozen subjects | `RiskSubjectFreeze`, `freezeRiskSubject`, `resolveRiskSubjectFreeze`, `freezeRiskSignal` | Objection/challenge freezes every supported HMAC key version and its source signals. Upheld: withdraw + 90-day purge. Rejected: documented restoration subject to original expiry. Open: stays frozen. Ordinary admins have no override. |
| ENG-03 rights | `SubjectRightsRequest`, `RightsRequestCommunication`, `subject-rights.actions` | Access, correction, objection, challenge, complaint/review. 3 business days to acknowledge, 21 calendar days to resolve, one 14-day extension with written privacy lead notice before the deadline. Case references, reviewer, classification, evidence metadata, communications, immutable audit events. Corrections never rewrite financial records. |
| ENG-04 retention | `retention.ts`, `runRiskRetentionSweep`, `RiskLegalHold` | 180-day active window; 90 days after expiry/withdrawal/final resolution; 24-month disclosure audit. Day-181 exclusion happens in the query itself. Scrubbing removes `subjectKey`, `internalNote`, `sourceId`; non-identifying audit metadata stays. Scoped holds, 14-day review, one extension. |
| ENG-05 salt | `secret-provider.ts`, `hasher.ts`, `RiskKeyVersion` | Provider interface (secrets never in DB/source/log), metadata-only access audit, versioned keys, active + previous candidate matching, explicit retirement. `.env.risk-intelligence.local` stays local and is never printed or reused in production. |
| ENG-06 notices | `EmployeePrivacyNotice`, `EmployeeNoticeAttestation`, `notices.ts` | Versioned notice text + SHA-256, delivery evidence required before contribution, annual/policy-version re-attestation supported. Acknowledgement is not consent. Every disclosure carries the five-line explanation. |
| ENG-07 emergency controls | `RiskGlobalControl`, `RiskControlEvent`, business suspension fields | Global disable returns explicit unavailable; business suspension is independent of consent; signal and subject freezes. Every control records actor, time, action, scope, reason, outcome and history. Controls work without the secret provider. |
| ENG-08 agreements | `ParticipationAgreement`, `agreements.ts`, agreement actions | View/download stored text, title/version/effective date, exact SHA-256, business identity, signatory identity/role/authority, authentication method, timestamp, countersignature, state machine, historical versions. Contribution requires eligibility, controller-registration check, executed agreements, notice evidence, active consent, current policy, no suspension and global availability. |

Business-facing workflows live in `RiskIntelligencePanel` and the dedicated
`/admin/risk-intelligence` page: consent, join/withdraw, closed-record source
selection, signal contribution, query and withdrawal. Employees and agents can
read their personalised notice and submit their own access, correction,
objection, challenge or complaint request at `/worker/privacy-notice`; the
subject identity is taken from the server session, not client input. The restricted privacy queue
lives at `/admin/privacy-review` and is gated by an explicit
`RiskPrivacyAccess` grant. It covers rights acknowledgement, assignment,
identity evidence, communications, the one extension, decision and linked-freeze
settlement; subject and signal freezes; scoped legal holds; business
suspension/expulsion and reinstatement; agreement countersignature and
activation; key metadata and retirement; retention; and privacy-access grants.
`/platform/risk-access` lets an existing platform owner grant optional privacy access
grant, change organisation facts and view readiness without creating an account.

## Schema changes

Additive only (`prisma/schema.prisma`, `prisma/schema-pg.prisma`, migrations
`20261222_risk_intelligence_governance_safeguards`,
`20261223_risk_intelligence_legal_execution` and
`20261224_risk_organisation_profile`). Existing tables were not reset,
truncated or cleaned. No second database was created. Financial audit retention
was not touched. The local SQLite database received the same additive changes
through `scripts/apply-risk-sqlite.ts`; PostgreSQL was reviewed statically and
not applied (see `POSTGRESQL-MIGRATION-REVIEW.md`).

## Configuration required by infrastructure

- Register the managed secret provider with `registerRiskSecretProvider()` and
  install a durable metadata-only sink with `setRiskSecretAccessSink()`.
- Schedule `runRiskRetentionSweep()` on the existing daily job path under a
  shared service account.
- Optionally grant `RiskPrivacyAccess` to a named privacy lead and reviewers; revoke on exit. No DPO/DPS appointment is required.
  The first grant is made by an existing platform owner at
  `/platform/risk-access`; no account is created for it.
- Owner must configure the authorised BloomCore signatory and, if confirmed,
  the registered address. Use `/platform/risk-access` or the privacy lead console, which
  persist the verified facts in `RiskOrganisationProfile`. Do not invent a
  name, title or address.
- BloomCore's authorised signatory publishes the controlled Employee and Agent Privacy Notice and confirms
  its version/effective date.
- Do not treat the legacy `RISK_AGREEMENT_HASHES` value as approval of the
  controlled instruments. Approval is tied to `LEGAL_INSTRUMENT_VERSION`; each
  executed document retains its own SHA-256 evidence.

## Professional/legal matters awaiting approval

- Lawful basis and joint-controller allocation under Act 843.
- Electronic authentication method and formalities (lawyer confirmation).
- Final wording of notices and the disclosure explanation.
- DPC registration/notification and any cross-border transfer basis.
- Association endorsement and defamation review.

No synthetic businesses, employees, incidents, disclosures, accounts or
fixture scripts were added to the application database. Test rows exist only
in the disposable `tests/test.db`.

## Gap closure (final pass)

Outbound notifications now use the existing Resend transactional email path in
`src/lib/email/resend.ts`. `src/lib/risk-intelligence/notifications.ts` records
`GovernanceDocumentDelivery` evidence: event type, recipient reference hash,
case/signal reference, template version, status, attempts, provider message id,
generic failure status and append-only retry history. Idempotency is a unique
key on (event type, scope id, recipient hash). Failed delivery keeps the audit
event; it never marks the event delivered. No message contains an employee
identity, subject key, source id or another business's report. Links point to
session-authenticated MaaCash workflows.

Agent notice acknowledgement is enforced in `changePassword` on first login.
The exact version and SHA-256 are persisted in `EmployeeNoticeAttestation`.
Agents read the notice at `/worker/privacy-notice`. Agreement execution emails
and exact document retrieval are in `/admin/agreements`.

PostgreSQL migration folder was renamed to
`20261222_risk_intelligence_governance_safeguards` so it sorts after the
`20261221_shared_risk_intelligence` table-creation migration. It is validated
but not applied to any PostgreSQL database in this assignment.

## Controlled legal execution and onboarding (final integration)

- `src/lib/risk-intelligence/legal-instruments.ts` renders Instruments 1-4 from
  the versioned lawyer text, inserts only verified facts and rejects unresolved
  placeholders, unauthorised legal names and the TIN.
- `/admin/agreements` now collects the business legal profile, presents the
  server-rendered text, requires password re-authentication for controlled
  acceptance, and keeps the exact document and SHA-256 retrievable.
- BloomCore's authorised signatory countersigns at `/platform/risk-access` or `/admin/privacy-review`; execution is not complete
  before countersignature. An execution certificate is stored.
- The platform owner or a delegated privacy lead publishes the controlled employee notice from the same restricted
  page. The agent-facing notice is personalised with the employer and employee's
  verified facts, and the attestation hash covers that exact text.
- `/admin/agreements` also records employee notice delivery evidence. Failure
  or return remains unverified and does not satisfy the contribution gate.
- Agreement execution and notice delivery use the existing Resend path with
  durable, idempotent delivery evidence. No delivery is claimed without a
  provider message id.
- Ghana public holidays are excluded from the 3-business-day acknowledgement
  deadline; the holiday-calendar version is stored with each rights request.
- `next.config.ts` loads `.env.risk-intelligence.local` in development only, so
  the real local application can run without copying the salt into `.env`.
  Production injection and a managed secret provider remain required.
- Public Privacy Policy now carries the Instrument 4 addendum and the verified
  registration number; the TIN is not rendered.

## Verification snapshot

Focused tests cover governance, acceptance, notices, agreements, notifications,
rights, retention, key rotation, closed-source listing and linked-freeze
settlement, self-service rights intake, controlled-instrument rendering and
fail-closed identity tests (80/80 serially). TypeScript and ESLint pass. Prisma
validation passes
for both schemas. The live readiness check shows 14 risk tables, including
`RiskOrganisationProfile`, but only one active business, no active share consent,
no executed agreement, no verified notice and no privacy access grant, so the 20-business
network gate correctly denies disclosure. No synthetic network was created. See
`PRE-DPC-READINESS.md` and `LEGAL-SOURCE-DISCREPANCIES.md`.
