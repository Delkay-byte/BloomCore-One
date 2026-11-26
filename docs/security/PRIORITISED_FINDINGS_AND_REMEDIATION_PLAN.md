> **Dated addendum — 25 November 2026.** Counsel/DPIA/DPO/DPS approval is not a MaaCash requirement, onboarding gate or release gate. Any below reference to it as outstanding is historical and superseded by `docs/privacy/COUNSEL_DPIA_DPO_DPS_REMOVAL_ADDENDUM.md`.

# MaaCash — prioritised findings and remediation plan

**Date:** 2026-11-25. **Standard:** BloomCore v1.0 (`BC-SEC-STD-001`).
**Status:** PROPOSAL ONLY. No remediation was implemented in this audit.

Findings are consolidated from `docs/security/SECURITY_PROFILE.md` (F-IDs),
`API_AND_TENANT_SECURITY_AUDIT.md`, `DEPLOYMENT_DDOS_WAF_BOT_AND_COOKIE_AUDIT.md`,
`GITHUB_AND_SUPPLY_CHAIN_AUDIT.md`,
`REVERSE_ENGINEERING_AND_INFORMATION_EXPOSURE_AUDIT.md` and the testing documents.
No Critical or High code-level vulnerability was demonstrated. "Medium" launch
items below are process/evidence gaps with realistic business impact.

## 1. Immediate launch blockers / incident risks

| ID | Sev | Finding and evidence | Impact | Required action | Owner only? | Verification | Status |
|---|---|---|---|---|---|---|---|
| API-08 / F-01 | Medium | Clean E2E run: 111 passed, 5 failed, 11 skipped; failures at `maacash-policy:24`, `maacash-reconciliation:45/84/129`, `role-workflows:139`. `Verified in code` (log artifact). | BloomCore §11.1 requires E2E smoke pass. One step-up withdrawal journey failed in browser. | Triage five failures; fix UI/test drift or accept risk in writing with expiry. Do not change test assertions without evidence. | No | Fresh `npm run test:e2e`, 0 failures, from release candidate | `verified` |
| DEP-02 / API-01 | Medium | Blueprint keeps `maacash.onrender.com` reachable; `TRUSTED_PROXY_HEADERS=true`; rate-limit IP can be client-chosen on direct origin path. `Verified in config`; live reachability `unverified`. | Edge WAF/bot rules bypassable; per-IP limits rotatable. | Confirm in Render/Cloudflare whether direct access is blocked; cut over legacy devices and close the hostname. | Yes | Authorised direct-origin check from outside CDN with forged `CF-Connecting-IP` | `likely` |
| GH-03 | Medium | `gh api .../branches` reports `main` `protected: false`; rulesets API 403; Render `autoDeploy: true`. `Verified` for classic flag, ruleset `unverified`. | One push can deploy unreviewed code. | Owner confirms/enables ruleset with required checks before any further push. | Yes | Direct push by non-admin rejected | `unverified` for ruleset |

## 2. Essential fixes before the next production release

| ID | Sev | Finding | Action | Owner only? | Verification |
|---|---|---|---|---|---|
| DEP-01 | Medium | Cloudflare DDoS/WAF/bot features unevidenced; Turnstile is bot challenge only. | Record provider plan, ruleset IDs, bot mode and date; enable selective challenges after compatibility test. | Yes | Staging blocked-path and allowed-integration checks |
| API-02 | Medium | `/api/zeli/analytics/export`, `/api/association/export`, `/api/audit` have no scoped rate limit. | Add tenant-scoped limits and bounded date ranges as a reviewed code change. | No | 429 with `Retry-After`; separate tenant buckets |
| GH-01, GH-02 | Medium | CI uses tag-pinned actions and `:latest` Gitleaks; secret and code scanning disabled; CodeQL SARIF `upload: never`. | Pin actions to SHAs and image by digest; enable secret scanning/push protection and SARIF upload; keep narrow Gitleaks suppressions. | Yes for settings | CI check that all `uses:` are pinned; Security tab status |
| F-02 | Medium | No provisioned scheduler; retention and rights deadlines manual. | Owner accepted weekly Monday manual sweep. Record operator, procedure and evidence; revisit paid cron only with approval. | Yes | Recorded execution counts and rights-case review |
| F-03 | Medium | SMS/WhatsApp adapter is mock-only (`delivers=false`). | Confirm product promise; approve provider/contract and opt-in controls before claiming delivery. | Yes | Sandbox success/failure/duplicate-webhook tests |
| F-04 | Medium | No application-level encryption of risk signal notes. | Decide classification and whether field-level encryption is required; do not weaken DB controls meanwhile. | Yes | Synthetic-data verification of chosen control |
| F-05 | Low | `SECURITY.md` session section stale vs code/config. | Update documentation to match verified 900s/300s/28800s and header transport. | No | Doc review in release checklist |

## 3. Important hardening and test-coverage improvements

| ID | Sev | Finding | Action | Verification |
|---|---|---|---|---|
| API-03 | Low | Internal scheduler endpoints rely on static shared tokens with uneven throttling. | Apply hashed-token rate limits to all internal mutation routes; keep timing-safe comparison. | 429 after threshold; no token in logs |
| API-04 | Low | Two API routes return limited error detail; others may leak. | Standardise generic user errors with server-side correlation IDs. | Error-contract test asserts no stack/SQL/body |
| RE-01, RE-06 | Low | `robots.txt` lists internal module prefixes; stale public `/api/diag` allowlist entry. | Minimise disallow set; remove stale allowlist entry and add public-route test. | Public-route regression test |
| DEP-04 | Info | Anonymous pages set zero cookies; authenticated/SSO `Set-Cookie` unconfirmed. | In staging, capture redacted cookie attributes for local and SSO login. | Header test asserts Secure/HttpOnly/SameSite/host-only and rotation |
| GH-04 | Low | Dependency/DAST gates narrower than standard. | Add scheduled SCA review and staging DAST after stack verification. | Gate report with triage and expiry |
| Testing gaps | Medium | No component layer, no authenticated axe scan, incomplete IDOR/export/webhook/stale-session scenarios, E2E red. | Extend existing Vitest/Playwright suites; add scenarios from `REAL_WORLD_SCENARIO_CATALOGUE.md`; no new tracking SDK. | Coverage map per `TEST_STRATEGY.md` |
| F-06 / F-07 | Low | Render Oregon vs Neon `us-east-2`; CodeQL SARIF not centrally enforced. | Accept region risk or plan approved migration; decide code scanning enablement. | Baseline latency recheck; Security tab status |

## 4. Longer-term resilience and capacity

- **DEP-07:** current DB network policy, least-privilege roles, encryption at rest and restore drill not verified. A pre-migration snapshot exists and migrations are current, but no restore drill followed it. Define RTO/RPO with owner; restore into disposable DB; never restore over newer financial data. `unverified`.
- **Capacity:** production is Render free plan, 1 instance, no autoscaling. No authenticated 1,000-user evidence. Owner elected to report the limitation only. Any capacity claim requires a paid plan, isolated environment and controlled k6-equivalent test with documented workload and stop conditions.
- **Observability:** alert routing, dashboards, on-call and provider escalation paths not evidenced. Add after owner confirms provider capabilities.

## 5. Owner-only manual settings, legal and contractual actions

Use `docs/security/OWNER_MANUAL_SECURITY_ACTIONS.md` for M-01..M-13. In addition:

1. Triage and close the five E2E failures or approve a dated risk acceptance.
2. Confirm receipt of the password-reset test email sent to the owner mailbox.
3. Record weekly Monday manual retention/rights-review execution.
4. Keep the Neon API key shared during the earlier session revoked/rotated.
5. Obtain Ghanaian counsel position on lawful basis, controller allocation, DPIA and DPC registration; legal adequacy of no cookie banner; provider contracts for SMS/WhatsApp.
6. Re-authorise deployment explicitly after the gates above; this audit authorises nothing.

## Acceptance rule

No item is closed by a code change alone. Each needs evidence, regression test
where applicable, named owner and date. A green unit suite is not proof of
security or production readiness.
