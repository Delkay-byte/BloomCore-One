> **Dated addendum — 25 November 2026.** Counsel/DPIA/DPO/DPS approval is not a MaaCash requirement, onboarding gate or release gate. Any below reference to it as outstanding is historical and superseded by `docs/privacy/COUNSEL_DPIA_DPO_DPS_REMOVAL_ADDENDUM.md`.

# Privacy, security and DPO/DPS audit — MaaCash Shared Agent Risk Intelligence

Owner and controller: **BLOOMCORE TECHNOLOGIES**, registration **BN428031125**.
Prepared: 25 November 2026. This is an engineering and governance audit, not legal
advice and not a Data Protection Commission (DPC) approval.

## 1. Executive position

BloomCore has decided, as owner, **not to appoint or pay for a Data Protection
Officer (DPO) or Data Protection Supervisor (DPS) at this stage**. No DPO/DPS
appointment, account, login, dashboard review, approval, countersignature or
environment/database dependency is required for business onboarding, agent
onboarding, agreement execution, notice publication or participation in the Shared
Agent Risk Intelligence register.

The decision removes a role, not the protections. Accountability remains with the
owner; access is restricted and audited; notices, agreements, rights requests,
freezes, legal holds and retention operate independently of any DPO account. The
residual independence gap is stated in §10 and is not papered over.

**Release position:** DPO/DPS dependency removal is complete. A full codebase
sweep found **zero** mandatory DPO/DPS gates. The owner confirmed the registered
office as `Hse # L7, Olive St., Akast Rd., Akatsi Volta Region, GHANA`; a fresh
production salt and retention token were generated and set through the Render
managed environment without printing their values. A Neon snapshot was verified
and all 30 pending additive migrations were applied once. Release is still
**blocked**: the owner rejected the paid daily cron job, the 1,000-user target
cannot be claimed on the free single-instance plan, counsel sign-off is open,
and browser E2E failures remain. See `docs/PRODUCTION_RELEASE_REPORT.md`.

## 2. Scope and sources

In scope: MaaCash tenant operations, the cross-business Shared Register, the
employee/agent privacy notice, participation agreements, subject-rights handling,
retention, legal holds, key management, governance notifications and the platform
privacy console.

Primary sources reviewed:

- `src/lib/risk-intelligence/` — policy, hashing, agreements, notices, retention,
  subject rights, legal instruments, organisation profile, secret provider.
- `src/lib/actions/risk-intelligence.actions.ts`,
  `risk-governance.actions.ts`, `risk-organisation.actions.ts`,
  `risk-source.actions.ts`, `onboarding-notice.actions.ts`.
- `prisma/schema.prisma` and `prisma/schema-pg.prisma`, plus the three additive
  risk-governance migrations.
- `docs/privacy/` — RoPA, governance review, controlled instruments, rights
  operations, retention/key rotation, pre-DPC readiness, incident runbook.
- The live read-only readiness output for the `.env`-selected database.

Historical statements in `SHARED-AGENT-RISK-INTELLIGENCE-PRIVACY-GOVERNANCE-REVIEW.md`
that predate the current controls are annotated there; they are not current facts.

## 3. Legal and regulatory frame

The working frame is Ghana law: the Data Protection Act, 2012 (Act 843), the
Electronic Transactions Act, 2008 (Act 772), the Labour Act, 2003 (Act 651) and the
Evidence Act, 1975 (NRCD 54). The specific provisions considered include Act 843
ss. 18(2), 20, 28, 30, 31, 33, 35, 39, 46–56 and 57(1); Act 772 ss. 5, 7, 8, 10–12
and 23; and the employment-law overlay in Act 651 ss. 62–64 and NRCD 54 s. 4.

These citations identify the questions. They are not conclusions that the
processing is lawful. The following remain for qualified Ghanaian counsel:

1. the lawful basis for warning other employers about a person (legitimate
   interest versus another basis, with a documented balancing test);
2. whether sharing an employment-collected signal with unrelated businesses is a
   compatible secondary purpose;
3. whether any category can imply a criminal allegation and therefore attract a
   stricter regime;
4. the controller/joint-controller allocation between BloomCore and participating
   businesses;
5. whether DPC registration or notification is required (no registration number is
   asserted anywhere);
6. cross-border transfer basis for hosting, backups, logs and email;
7. whether a DPIA is required and, if so, its sign-off. No completed DPIA for this
   module was found; the governance review is an input, not a DPIA.

## 4. Roles and accountability without a DPO

| Function | Who performs it | Is a DPO/DPS required? |
| --- | --- | --- |
| Controller accountability | Owner / proprietor | No |
| Public privacy contact | `bloomcoretechnologies@gmail.com` | No; it is a contact channel, not an appointment |
| Platform privacy governance | Authenticated platform administrator | No |
| Optional delegated privacy review | Existing active tenant administrator with a `RiskPrivacyAccess` grant (`privacy_admin` or `privacy_reviewer`) | No; optional least-privilege delegation |
| Business participation decision | That business's owner/administrator | No |
| Employee notice acknowledgement | The employee/agent | No; acknowledgement is not consent |
| Agreement acceptance | Business owner, then BloomCore's authorised signatory | No DPO countersignature |
| Subject-rights adjudication | Platform administrator, or a granted privacy reviewer in the same business | No |

There is no bootstrap, seed, default or fallback DPO account. A privacy grant is
made only to an existing active administrator, never by creating an identity. No
"last DPO" lock exists, so the platform owner can always restore access and the
business is never stranded.

## 5. What is processed and why

| Data | Purpose | Storage / disclosure |
| --- | --- | --- |
| Employee name and phone | Identify the subject to the employer and compute the pseudonymous key | Name/phone are not stored in the register; the key is HMAC-SHA256 |
| Pseudonymous subject key | Match independent signals across businesses | Stored; never disclosed to a business |
| Signal category, severity, incident period, expiry | Narrow factual prompt to check | Stored; category/severity band/month disclosed only when thresholds are met |
| Contributing business and source record | Provenance and tenant isolation | Stored; never disclosed to another business |
| Internal note | The contributing business's own context | Stored; never disclosed |
| Consent, agreement, notice attestation | Demonstrate the participation and transparency basis | Stored with actor, version, timestamp and hashes |
| Disclosure log | Accountability for every answer | Stored; contributor identities are not recorded |
| Rights case, freeze, hold, control event | Exercise and evidence data-subject rights and safeguards | Stored; access restricted and audited |

Never collected for the register: national ID, photograph, address, date of birth,
bank or MoMo number, customer data, evidence files, subject device identifiers or
subject location. The answer is a prompt to review, never a blacklist or automated
decision.

Businesses opt in explicitly. The employee's acknowledgement is transparency, not
consent, and does not waive rights. The business's consent is not the data
subject's consent and must not be described as such.

## 6. Safeguards that operate without a DPO

| Safeguard | Implementation and evidence |
| --- | --- |
| Explicit opt-in and versioned policy | `joinRiskIntelligence` requires the current `RISK_INTELLIGENCE_POLICY_VERSION`; stale consent blocks both contribution and query |
| Genuine disclosure thresholds | At least 20 active eligible businesses, at least 3 independent other contributors, at least 2 independent contributors per category; the caller's own signals never count. Constants in `policy.ts`; acceptance tests cover the denials |
| No manufactured success | With one active business and zero share consents, live queries return `insufficient_network`; no seed, mock, reset or synthetic participant exists in the application database |
| Tenant isolation | Every tenant action resolves the tenant from the session; governance reads/writes reject cross-tenant signals, holds, rights cases, agreements and verification. Added regression test covers a second tenant administrator |
| Least-privilege privacy access | Global controls, suspension/expulsion, subject freezes, key retirement, notice publication and the retention sweep are platform-only; a tenant privacy administrator cannot perform them |
| Attribution | Every state change writes an audit and/or `RiskControlEvent` with actor, scope, reason, timestamp and outcome. Financial mutation is marked false |
| Durable key-access audit | Node instrumentation installs a metadata-only `risk_intelligence.secret_access` sink at boot; no salt, key, input or hash output is recorded |
| Employee transparency | Controlled notice is resolved per employer and employee; first login fails closed until the current notice is acknowledged; the stored SHA-256 is of that exact populated text |
| Electronic agreements | Versioned server-rendered instruments, password re-authentication, exact accepted hash, business acceptance then BloomCore countersignature; execution only after countersignature |
| Subject rights | Self-service and administrator intake, identity verification, acknowledgement and resolution clocks, one reasoned extension, communication log, linked freeze |
| Freeze and challenge | A subject freeze blocks cross-business disclosure across supported key versions; a disputed signal is excluded; the linked freeze must be resolved before the rights case closes |
| Retention and legal holds | 180-day active signal, 90-day post-expiry/withdrawal scrub, 24-month disclosure/audit de-identification, scoped holds that block deletion and require review |
| Emergency stop | Platform global control disables all cross-business answers without deleting data |
| Incident handling | `docs/privacy/INCIDENT-RESPONSE-RUNBOOK.md` covers containment, salt exposure, breach notification target and recovery |

## 7. Subject rights operation

The rights workflow implements:

- acknowledgement within **3 business days**, excluding weekends and Ghana gazetted
  public holidays;
- resolution within **21 calendar days**;
- **one** reasoned extension of up to **14 calendar days**, recorded in writing;
- identity verification before disclosure or correction;
- a freeze on the subject's cross-business signals throughout adjudication;
- a communication log and a reasoned outcome;
- a linked cross-business freeze that only a platform administrator can resolve
  before the case closes.

Requests can be submitted by an administrator for an employee in the same
business, or by the worker/agent for themselves. The subject identity for a
self-service request comes from the authenticated session, never from client input.
Another business's employee identifier returns the same "not found" response as a
nonexistent one.

Open operational dependency: the daily retention sweep and the rights-clock
escalation are not backed by a scheduler. Deadlines are computed correctly, but an
unattended overdue case will not email anyone. Operators must review the privacy
queue. This is a release blocker for an unattended production service.

## 8. Retention, deletion and legal holds

| Record | Retention rule |
| --- | --- |
| Active signal | Expires 180 days after the observation period ends |
| Expired signal | Deleted/scrubbed 90 days after expiry |
| Withdrawn signal | Deleted/scrubbed 90 days after withdrawal |
| Disputed signal | 90 days after actual resolution; no clock while unresolved |
| Disclosure and risk audit | 24 months, then de-identified |
| Agreement and authority evidence | 6 years under the controlled instrument schedule |
| Legal hold | Blocks deletion; review 14 days after case closure; extension is the only authorised deferral |

The sweep removes/scrubs subject key, internal note and source pointer from signal
rows and de-identifies disclosure/audit rows under the approved schedule. It skips
legal holds and never touches financial ledger records. Expiry is also enforced at
query time, so a missed sweep cannot make an expired signal disclosable.

## 9. Security controls relevant to privacy

- Platform and tenant sessions are separate; platform actions use
  `requirePlatformAdmin()` and tenant actions use `requireTenantAdminMomo()`.
- MFA is enforced for production administrators; TOTP secrets are encrypted at rest.
- Rate limiting uses a dedicated HMAC key; password recovery is generic to prevent
  account enumeration and is rate-limited per IP and identifier.
- Password reset tokens are stored only as SHA-256, expire in 30 minutes, are
  single-use and are consumed transactionally; all sessions are revoked on reset.
- Turnstile is enabled in production and boot fails closed if keys are missing.
- Security headers include a nonce CSP; the E2E suite verifies login and an
  authenticated dashboard have no CSP violations.
- Tenant isolation is exercised by unit and browser tests, including cross-tenant
  draft, analytics and agreement access.
- No application-level encryption of signal notes or disclosure rows exists. The
  managed PostgreSQL provider's at-rest encryption and access control carry that
  risk; database operators can read notes and, with the salt, re-identify subjects.
  This is a residual high-risk organisational dependency, not solved by software.

## 10. Effect of having no DPO/DPS — honest assessment

**What is not weakened.** No control in §6 depends on a DPO login, signature,
approval or database record. Onboarding, notice publication, countersignature,
rights handling, freezes, holds, retention and emergency stop all have an
alternative authorised actor. Removing the role removed a single point of failure
and a fake "privacy approval" step.

**What is weaker.** There is no independent internal privacy officer whose only
duty is to challenge the owner. The owner combines commercial pressure and
privacy accountability, and a small team has less capacity to notice drift. A
software audit trail records what happened; it does not supply independent
judgement. External counsel and, where required, an external privacy adviser are
therefore more important, not less.

**What must not be claimed.** That the DPC approved the module; that the absence of
a DPO proves compliance; that an employee acknowledgement is consent; that the
register is anonymous; that a disclosure is a finding of wrongdoing; or that a
network of one business satisfies the thresholds.

## 11. Findings and residual gaps

| Finding | Classification | Consequence |
| --- | --- | --- |
| No DPO/DPS appointment or dependency | IMPLEMENTED AS OWNER DIRECTED | Onboarding and governance continue without the role |
| Tenant-scoped privacy actions | IMPLEMENTED AND TESTED | Cross-tenant controls rejected |
| Genuine 20/3/2 thresholds | IMPLEMENTED AND TESTED | Live network still unsatisfied; no disclosure manufactured |
| Employee notice and first-login gate | IMPLEMENTED | Fails closed if employer/employee facts are incomplete |
| Rights workflow with 3/21/14 SLAs | IMPLEMENTED | No scheduler-driven escalation; manual review needed |
| Retention/deletion and legal holds | IMPLEMENTED | Paid daily scheduler rejected; owner runs sweep and rights-deadline review weekly on Monday |
| Mandatory DPO/DPS dependency | **REMOVED — VERIFIED BY SWEEP** | No appointment, account, login, review, signature or approval gate remains |
| Registered office | **CONFIRMED BY OWNER** | Configured in the Render environment and effective for agreement execution |
| Production salt and retention token | **CONFIGURED — FORMAT VERIFIED** | Each is 64 hex chars from 32 random bytes; values never printed |
| DPIA and counsel sign-off | **OUTSTANDING** | Legal-basis and DPIA conclusions are not established |
| DPC registration position | **UNRESOLVED / NOT CLAIMED** | No registration number is asserted |
| Hosting/sub-processor schedule | **INCOMPLETE** | Public addendum does not name providers/regions |
| Independent privacy oversight | **RESIDUAL GAP** | Owner accountability without a dedicated officer |
| Application-level encryption of notes | **NOT IMPLEMENTED** | Database/backup access remains high risk |
| 1,000-user production capacity | **FAILED** | See performance report; do not release as production capacity |

## 12. Required owner decisions and actions

1. Registered office: supplied and confirmed; no further action unless the
   company record changes.
2. Production salt and retention token: generated and configured through Render;
   rotation remains an owner-controlled operation.
3. Daily scheduler: USD 1/month charge rejected. Owner runs retention and
   rights-deadline review weekly on Monday.
   Database snapshot and migrations are now verified; recheck only if infrastructure changes.
4. Obtain Ghanaian counsel's written position on lawful basis, controller role,
   DPIA and DPC registration before claiming legal readiness.
5. Confirm the hosting providers and regions for the public addendum.
6. Approve a production capacity plan (paid instance and a retest) before any
   claim that the service supports 1,000 concurrent users.

## 13. Conclusion

The absence of a DPO/DPS does not, by itself, weaken the application's technical
protection. The technical and procedural safeguards are real, tested and
tenant-scoped, and they do not depend on a fictitious privacy officer. The
remaining weaknesses are the unverified database backup and migration state, no
unattended retention/rights scheduler, no DPIA/counsel sign-off, no independent
privacy oversight, and capacity that has not met its target. The registered office
and production secrets are now configured. The database, scheduler and capacity
items remain release blockers, not documentation gaps.
