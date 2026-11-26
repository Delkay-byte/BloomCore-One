# Counsel / DPIA / DPO / DPS position removed — dated addendum

Date: 25 November 2026. **Owner decision, final and not open for review.**

The external counsel / DPIA / DPO / DPS approval position is not a MaaCash
product concept, onboarding prerequisite, activation gate, account-creation
condition, normal-use condition or release gate. It must not be presented as
any of those in current documentation, owner-action lists or release
checklists. Historical reports are preserved as evidence; where they describe
counsel/DPIA/DPO/DPS sign-off as outstanding, that statement is historical and
superseded by this addendum. It is not an owner action.

## Verified implementation state (`Verified in code`)

- No counsel/DPIA/DPO/DPS appointment, account, login, dashboard, signature,
  countersignature, review screen, pending status, feature flag or environment
  variable gates onboarding or use.
- No middleware, provisioning, activation, first-login, MoMo, Susu, customer
  portal or API check requires that position.
- The retired `dpo` alias no longer authorises privacy operations:
  `isPrivacyAdministrator()` accepts only `privacy_admin`; UI counters no
  longer count `dpo` grants as active administrators; grant APIs accept only
  `privacy_admin` and `privacy_reviewer`. Regression guard:
  `tests/retired-dpo-role.test.ts`.
- `dpoReference` on legal holds is an immutable historical label, not a role
  or approval. It is retained to preserve audit integrity and grants no
  authority.
- Genuine operational controls are retained: authentication, authorisation,
  tenant isolation, audit logging, security-event retention, rights requests,
  objections/challenges, subject freezes, data minimisation, privacy notices,
  lawful retention/deletion, business-owner consent, employee notice and
  attestation, and the optional Shared Agent Risk Intelligence gates.
  Ordinary onboarding and MoMo/Susu use remain available without Shared Agent
  Risk Intelligence participation.

## Verification tests

`tests/retired-dpo-role.test.ts` plus the existing onboarding, role-workflow,
tenant-isolation and risk-intelligence suites. Full onboarding-without-counsel
coverage is reported in `docs/PRODUCTION_RELEASE_READINESS_FINAL_ADDENDUM.md`.

## Documentation supersession

The following documents retain historical wording but are superseded by this
addendum wherever they list counsel, DPIA, DPO or DPS approval as a current
requirement or release gate:

- `docs/security/PRIORITISED_FINDINGS_AND_REMEDIATION_PLAN.md`
- `docs/SECURITY_AND_TEST_REPORT.md`
- `docs/PRODUCTION_RELEASE_REPORT.md`
- `docs/OWNER_ACTIONS_REQUIRED.md`
- `docs/PRIVACY_SECURITY_AND_DPO_DPS_AUDIT.md`
- `docs/security/OWNER_MANUAL_SECURITY_ACTIONS.md`
- `docs/security/DEPLOYMENT_DDOS_WAF_BOT_AND_COOKIE_AUDIT.md`
- `docs/zeli/ZELI-RELEASE-READINESS.md`
- `docs/zeli/ZELI-PRODUCTION-RELEASE-DOSSIER.md`
- `docs/zeli/ZELI-CONVERSATIONAL-PRIVACY-DECISION-PACK.md`
- `docs/private/MAACASH_PRODUCT_AND_OPERATIONS_COMPENDIUM.md`

No new approval dependency was introduced.
