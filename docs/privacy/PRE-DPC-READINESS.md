# Pre-DPC examination readiness — Shared Agent Risk Intelligence

Owner: BloomCore Technologies. Prepared: 2026-11-25. Status: engineering controls implemented;
live disclosure remains gated by real-world participation and configuration.
This is not a DPC approval, certificate or inspection report.

## 1. Scope and operating position

The real MaaCash application and the existing database are used. No DPC
database, DPC mode, synthetic businesses, seeded network, reviewer account or
reset was created. The normal live cross-business disclosure path is enabled;
it returns an explicit threshold denial until enough real eligible businesses
participate. That is the intended safeguard, not a disabled feature.

## 2. Current live data facts

Read-only readiness output at preparation time:

| Fact | Value |
| --- | --- |
| Active businesses | 1 |
| Active share_signals consents | 0 |
| Executed/active participation agreements | 0 |
| Open signals | 0 |
| Verified notice attestations | 0 |
| Active privacy access grants | 0 |
| Global control row | none (falls back to configured availability) |

With fewer than 20 active eligible businesses, every query returns
`insufficient_network`. No successful disclosure can be manufactured and none
was manufactured. The application is functionally live but the network gate is
not satisfied.

## 3. Code and control evidence

- Thresholds: 20 active eligible businesses, 3 independent other contributors, 2 independent contributors per category; query-only businesses excluded.
- Contribution: closed source record, evidence reference, good-faith declaration, exact per-employee notice version and SHA-256, executed agreements, active consent, current policy, no suspension/expulsion.
- Query: tenant-scoped eligible set, banded output, five-line non-reliance explanation, no identities, notes or source references.
- Subject freeze across all supported key versions; 3-business-day acknowledgement (weekends and Ghana gazetted holidays excluded), 21-calendar-day resolution, one 14-day reasoned extension.
- Retention: 180-day active window, 90-day scrub, 24-month disclosure de-identification, 6-year agreement/authority records, scoped legal holds.
- Audit: immutable events for consent, agreement, notice, disclosure, freeze, rights, control and delivery.
- Tenant isolation: every business action resolves the tenant server-side. Privacy actions require either an explicit `RiskPrivacyAccess` grant or an authenticated platform-owner session; no DPO appointment exists.
- Operational surfaces: `/admin/risk-intelligence` is the live participation, consent, closed-record contribution and query page. `/admin/privacy-review` is the restricted privacy queue for rights adjudication and freeze settlement, subject/signal freezes, scoped holds, business suspension/expulsion, agreement countersignature and activation, key metadata, retention and optional privacy-access grants. `/worker/privacy-notice` is the employee/agent notice and self-service rights intake. `/platform/risk-access` is the platform owner's organisation-fact, optional-grant, countersignature and notice-publication console.

## 4. Onboarding checklist

1. Owner signs in as tenant administrator and completes the business legal profile.
2. Owner presents and accepts the Joint Controller Agreement and Participation Terms; the DPA is presented only when conditional.
3. BloomCore's authorised signatory countersigns. State becomes executed only then; the exact text and SHA-256 remain retrievable.
4. BloomCore's authorised signatory (platform owner or privacy lead) publishes the controlled Employee and Agent Privacy Notice with a version and effective date. The stored text is the controlled template, not a pre-filled copy.
5. Each agent receives the notice populated with the verified employer and employee facts. The acknowledgement stores the SHA-256 of that exact populated text. Owner delivery evidence is separate, and a failed delivery never counts.
6. Owner enables share_signals consent. Contribution remains blocked until every gate is satisfied.
7. The platform owner confirms the production salt, secret provider, scheduler and email domain. No DPO/DPS approval is part of onboarding.

## 5. Configuration evidence

The live database has no active `RiskPrivacyAccess` grant. That is not a blocker:
a platform owner can publish the controlled notice, countersign agreements and
run the retention sweep from `/platform/risk-access` without creating or
appointing a DPO. A grant is optional least-privilege delegation and can be
issued later to an existing active tenant administrator. Do not create an
account to work around the absence of a grant.

Required before production: `RISK_INTELLIGENCE_SALT` in a managed secret store;
`BLOOMCORE_AUTHORISED_SIGNATORY_NAME` and `_CAPACITY` (owner-confirmed as
Saviour Amegayie, Proprietor); `BLOOMCORE_REGISTERED_ADDRESS` from the owner's
exact registered record, without which controlled execution fails closed;
`BLOOMCORE_PRIVACY_EMAIL` (defaults to the owner-approved Gmail address);
`RISK_HOSTING_PROVIDERS` and `RISK_HOSTING_REGIONS`; `RESEND_API_KEY`;
`EMAIL_FROM`; `RISK_RETENTION_TOKEN`; the daily
`POST /api/internal/risk-intelligence/retention` schedule. No privacy grant or
DPO appointment is required. See `RISK-INTELLIGENCE-CONFIGURATION.md`.

Local development loads `.env.risk-intelligence.local` only when
`NODE_ENV !== production`. A production build deliberately does not read that
file. The local salt must never be reused in production.

## 6. Verification to run before the examination

```
npm run test:prepare
npx vitest run --fileParallelism=false tests/risk-governance.test.ts tests/risk-governance-actions.test.ts tests/risk-intelligence.test.ts tests/risk-intelligence-acceptance.test.ts tests/risk-notification-onboarding.test.ts tests/legal-instruments.test.ts
npx tsc --noEmit
npm run lint
npx prisma validate --schema=prisma/schema.prisma
npx prisma validate --schema=prisma/schema-pg.prisma
npm run build
```

Use the disposable `tests/test.db` for tests. Do not point the suite at the
application database.

Result after the live-operations pass: the six focused files passed 80/80
serially, `tsc` passed, ESLint reported 0 errors (119 pre-existing warnings),
both Prisma schemas validated, and the production build completed. The live
SQLite database has 14 risk tables, including the additive
`RiskOrganisationProfile`; readiness still reports one active business, zero
share consents, zero executed agreements, zero verified notices and zero privacy access
grants. The public `/privacy` page returned HTTP 200 with the addendum and
registration number, and without the TIN.

## 7. Known gaps and honest classifications

| Item | Classification |
| --- | --- |
| Live disclosure path enabled in code | IMPLEMENTED AND VERIFIED |
| Production salt and secret provider | IMPLEMENTED — CONFIGURATION PENDING |
| BloomCore authorised signatory | SUPPLIED BY OWNER (Saviour Amegayie, Proprietor) |
| BloomCore registered office | OWNER ACTION REQUIRED — execution fails closed until supplied |
| Employee notice publication | IMPLEMENTED — READY FOR CONTROLLED PUBLICATION (no DPO approval) |
| Owner agreement onboarding | IMPLEMENTED; waiting for real owner execution |
| 20-business network | EXTERNAL INFRASTRUCTURE PENDING (real participation; cannot be seeded) |
| Email delivery | IMPLEMENTED — provider delivery observed; production sender configuration still operator-controlled |
| Written DPC approval | NOT IMPLEMENTED / NOT CLAIMED (no written approval supplied) |
| Lawyer confirmation of instrument edits | OWNER/LAWYER CONFIRMATION REQUIRED |
| PostgreSQL migrations applied | NOT APPLIED HERE — no production database change was authorised or made |

## 8. What not to say

Do not say the DPC approved the module, that email delivery is proven without a
provider message id, that an agreement is executed before countersignature, or
that the network gate is satisfied. Do not describe the local salt as a
production secret. Do not purge records for the inspection.
