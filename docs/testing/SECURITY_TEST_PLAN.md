# MaaCash security test plan

**Status:** read-only audit. No scan, test, deploy or credential change was performed. This plan
records existing evidence and the tests still owed. It is not a certification or an independent
penetration test.

Evidence base: `docs/SECURITY_AND_TEST_REPORT.md`, `docs/security/**`,
`.github/workflows/ci.yml`, `tests/security*.test.ts`, `tests/tenant-isolation.test.ts`,
`tests/platform-auth.test.ts`, `tests/paystack-*.test.ts`, `scripts/pg-safety.mjs`,
`scripts/e2e-env.cjs`.

---

## 1. Trust boundaries and invariants

| Boundary | Rule to test | Source |
| --- | --- | --- |
| Anonymous → tenant | No protected route or data without a session | `tests/middleware-boundaries.test.ts`, role matrix §32–37 |
| Tenant A → Tenant B | Session-derived tenant id; every lookup tenant-scoped; foreign ids 404 | `tests/tenant-isolation.test.ts`, role matrix §34–36 |
| Branch → branch | Offline capture and daily accounts restricted to caller's assignment | `tests/offline-momo-drafts.test.ts:296,484` |
| Role → role | Admin / worker / collector / customer / platform / privacy grant checked server-side; hidden UI is not authorisation | role matrix §3, §52–54 |
| Browser → server | Server-authoritative money, validation and rate limits; browser input untrusted | `docs/security/FINANCIAL-OPERATION-SECURITY.md` §2 |
| App → external provider | Raw-body HMAC, timing-safe comparison, single-use tokens, synthetic-only in tests | `docs/SECURITY_AND_TEST_REPORT.md` §3, §5; `scripts/e2e-env.cjs` |
| User → privacy data | Active `RiskPrivacyAccess` grant or platform owner; hash-only recipient in delivery records | `docs/privacy/SUBJECT-RIGHTS-OPERATIONS.md:11`, schema `GovernanceDocumentDelivery` |
| CI → database | Destructive PG targets must be loopback, explicitly confirmed and `maacash_test*` | `scripts/pg-safety.mjs:31–77` |

Business invariants to assert after any mutation test:

- no double-post, no overdraw, no negative balance, no cross-tenant write;
- idempotency key posts once; changed body under same key returns 409;
- reversals are compensating rows; original rows survive; `reversalOfId` unique;
- `provider_confirmed` is never produced by this build;
- no PIN, OTP, password, token or customer phone number in stored captures, logs or reports.

---

## 2. Commands that produce security evidence (exact)

```
npm run test:security
npm test
npm run test:pg
npm run test:e2e
npm run typecheck
npm run lint
npm run build
npm audit --audit-level=critical
node scripts/verify-release.mjs --skip-e2e
node scripts/check-accessibility.mjs http://localhost:3111
```

CI runs `npm audit --audit-level=critical`, Gitleaks full history with `--redact`, and CodeQL
init/autobuild/analyze with SARIF uploaded as an artifact. Code scanning is not enabled on the
repository; a green CodeQL job is not proof of zero findings.

`test:security` expands to the named subset in `package.json:23` and does **not** include every
security test (for example `security-retention-dual-control.test.ts` and `security-sec04-06-14.test.ts`
are outside that list). Use `npm test` for full coverage.

---

## 3. Existing security test coverage (observed)

| Area | Tests | Status |
| --- | --- | --- |
| Session lifecycle, timing, token version, reset/verification tokens | `tests/security.test.ts`, `security-release-fixes.test.ts`, `mfa-enforcement.test.ts`, `mfa-replay.test.ts`, `pg-mfa-replay.test.ts` | VERIFIED historical: full suite passed 1828/1828 (`docs/SECURITY_AND_TEST_REPORT.md` §1) |
| Rate limiting and failed-login cooldown | `tests/security-hardening.test.ts`, `turnstile-action-mapping.test.ts`, `enquiry-turnstile.test.ts` | Covered at unit/integration level; browser rate-limit journey GAP |
| Step-up / re-auth | `tests/reauth.test.ts`, `security-sec04-06-14.test.ts`, `pg-step-up.test.ts`; `e2e/role-workflows.spec.ts:139` | Units pass; E2E case **fails** — known gap |
| Tab-session isolation and fail-closed offline | `tests/tab-proof.test.ts`, `cross-tab-session.test.ts`, `tab-session-isolation.test.ts`; `e2e/tab-sessions.spec.ts`, `tab-session-failures.spec.ts`, `maacash-auth-security.spec.ts` | Covered; defect found and fixed during acceptance (acceptance report §4.1) |
| Tenant isolation / IDOR / BOLA | `tests/tenant-isolation.test.ts`, `tenant-status-access.test.ts`, `zeli-tenant-access.test.ts`, `zeli-analytics-access.test.ts`, `platform-auth.test.ts`, `financial-security.test.ts` | Covered for several objects; no exhaustive route-by-route matrix |
| Cross-tenant admin recovery | `tests/admin-recovery.test.ts`; second-tenant regression noted in `docs/SECURITY_AND_TEST_REPORT.md` §5 | Covered at unit level |
| Money integrity and concurrency | `tests/financial-security.test.ts`, `financial-audit-atomicity.test.ts`, `financial-corrections.test.ts`, `pg-withdrawal-concurrency.test.ts`, `pg-financial-corrections.test.ts`, `pg-dual-control.test.ts` | Covered; PG suite not run in latest security report |
| Offline device security | `tests/offline-isolation.test.ts`, `offline-unlock-hardening.test.ts`, `offline-deletion-coordination.test.ts`, `offline-momo-drafts.test.ts`, `pg-offline-idempotency.test.ts` | Covered; device compromise residual risk documented (`docs/security/FINANCIAL-OPERATION-SECURITY.md` §7.5) |
| Webhooks and provider responses | `tests/paystack-momo.test.ts`, `paystack-ping.test.ts`, `paystack-otp-and-platform-notification.test.ts`, `sms-status-webhook.test.ts`, `zeli-billing.test.ts`, `zeli-provider-resilience.test.ts`, `zeli-privacy-gateway.test.ts` | HMAC/resilience covered; no duplicate/out-of-order callback sequence test |
| Injection / XSS / CSP / uploads | `tests/csp.test.ts`, `csv-export.test.ts`, `evidence-provenance.test.ts` (path-traversal checks), `docs/security/dast/ZAP-*.md` | Static and passive checks; no active authenticated scan |
| Secrets / supply chain | CI Gitleaks + ignore assertions; `npm audit --audit-level=critical`; `docs/security/DEPENDENCY-AND-SECRET-REVIEW.md`, `docs/security/CLOSEOUT-2026-11.md` | Pipeline present; high CLI-only advisories noted in closeout; SARIF unreviewed here |
| Privacy / governance | `tests/risk-*.test.ts`, `legal-instruments.test.ts`, `risk-notification-onboarding.test.ts` | Strong at action level; legal basis and dispute route remain owner/legal decisions |

### 3.1 Fixes recorded during the last security work

From `docs/SECURITY_AND_TEST_REPORT.md` §3 (all already applied; no secret values reproduced):

| Component | Severity | Fix |
| --- | --- | --- |
| `src/lib/security/tab-proof.ts` | medium | Nonce strictly single-use at DB key |
| Risk retention internal route | medium | Hashed-token rate limit and in-process overlap guard with 409 |
| Anomaly scan internal route | medium | Fixed error message with error class only |
| Auth selection route | low | `Cache-Control: no-store` |
| Offline / revocation routes | low | Log error name and Prisma code only |
| Temporary reset scripts | low | Removed before release staging |

No critical or high-severity finding remained open in that report. The report also states that
application-level encryption of risk signal notes is **not** implemented and the managed
database's at-rest controls carry that risk.

---

## 4. DAST and SAST/SCA posture

| Activity | Evidence | Limitation |
| --- | --- | --- |
| Unauthenticated ZAP baseline | `docs/security/dast/ZAP-BASELINE-2026-11.md`: 0 FAIL / 7 WARN / 61 PASS, local production build, 1-minute spider, 2-minute passive limit | Public surface only; not authenticated, not financial, not high-volume |
| Authenticated ZAP passive baseline | `docs/security/dast/ZAP-AUTH-2026-11.md`: 0 FAIL / 8 WARN / 60 PASS, injected server-minted admin session | Active scanning deliberately not run: it submits forms that could create customers, post contributions or trigger reversals |
| External pentest handover | `docs/security/external-pentest/**` role matrix, attack-surface inventory, scope and rules; handover doc present in tree | No independent human pentest result in this repository; `docs/security/PENTEST-READINESS.md:118` says no external tester assessed the branch at that time |
| CodeQL | CI job, SARIF artifact | Code scanning disabled; artifact contents not reviewed in this audit |
| `npm audit` | CI critical-only; `docs/security/CLOSEOUT-2026-11.md` notes 3 high in CLI-only `deepmerge-ts` | Critical-only gate; high/medium not gating |
| Gitleaks | CI full-history, redacted | Results of the latest run not present in this audit |

**Rule:** active authenticated scanning and any volumetric scan require a disposable staging
copy, written scope and owner approval. Never point ZAP, k6 or a load harness at production.

---

## 5. Tests still owed (prioritised)

1. **Re-run the full suite on a clean tree.** Historical evidence is not current-tree evidence;
   the working tree was dirty at audit time.
2. **Re-run `npm run test:pg`** with a confirmed disposable loopback database; the latest
   security report records it as not run.
3. **Fix the five E2E failures deliberately** (see `TEST_STRATEGY.md` §3.1), especially the
   withdrawal step-up case: an E2E gap in a financial authorisation control is higher risk than
   a label mismatch.
4. **Exhaustive IDOR/BOLA matrix** across every documented `[id]` route for all seven roles,
   asserting 404 and no leaked fields.
5. **Duplicate and out-of-order webhook sequences** for Paystack, SMS status and messaging
   callbacks, with synthetic event ids and a persisted event log.
6. **Role-scoped export test** verifying a worker, collector, admin and customer see only their
   permitted rows.
7. **Authenticated accessibility scan** over dashboards, dialogs and tables using a locally
   pinned axe-core copy; the current script covers seven public pages only.
8. **Review the CodeQL SARIF** and record disposition; treat "job ran" as insufficient.
9. **Backup/restore rehearsal** on a disposable copy; no verified restore point exists today.
10. **Owner manual items** from `docs/testing/FINAL-REMAINING-DEPENDENCIES.md` §5 — physical
    device PWA steps, SIM/network behaviour, production-host checks.

---

## 6. Reporting rules

For each finding, record: severity, affected component, evidence path, realistic scenario,
impact, recommended fix, owner action, regression test and verification result. Label each item
`verified`, `likely`, `unverified` or `false positive`. Never copy secret values, tokens, real
customer data or raw provider responses into a report.

A green suite, a passive ZAP run and a passing lint job together do not prove the product is
secure. Remaining risks in `docs/SECURITY_AND_TEST_REPORT.md` §7 and
`docs/testing/LOCAL-FINAL-ACCEPTANCE-REPORT.md` §8 must stay visible until an owner closes them.

No push, merge, production setting change, credential rotation or deployment was approved or
performed in this audit.
