# MaaCash Release and Dashboard Remediation — Final Report

**Date:** 2026-11-27
**Task:** Controlled Phase 1–9 release, live dashboard remediation, provider-disclosure improvement, safe workspace cleanup
**Status:** Phase 1–9 release DEPLOYED AND VERIFIED LIVE. Dashboard defect fixes implemented and locally verified on `fix/maacash-dashboard-access-2026-11-27`, held for owner approval per the Stage 7 boundary.

---

## 1. Phase 1–9 baseline verification

| Claim | Verified by inspection | Result |
|---|---|---|
| Final verification branch `feat/susu-enterprise-phases-1-9-verification` | `git worktree list`, branch tip | `1a626eb` — "fix(susu): close Phase 9 verification gaps" ✓ |
| Phase 9 fix commit | branch log | `1a626eb` at tip ✓ |
| Phase 8 merge `39a23d0` | `git log` | merge of `61335fe` (Phase 8 tip) into `8a98782` ✓ |
| Phase 8 branch tip `61335fe` | branch log ✓ |
| Worktree `BloomCore-One-susu-phases-1-9-verification` | present, clean ✓ |
| `PHASE9_FINAL_VERIFICATION_REPORT.md` | read — classification **B — TECHNICALLY READY FOR CONTROLLED PILOT**; scope discipline confirmed (no push/deploy/production access during verification) |
| `SUSU_ENTERPRISE_RELEASE_CHECKLIST.md` | read — 18 automated-test claims mapped to commands |
| `PHASE8_IMPLEMENTATION_REPORT.md`, `PHASE9_PROVIDER_BOUNDARY.md` | read — HCode/Hubtel boundary: not integrated, not claimed |
| `docs/testing/POSTGRES-TEST-ENVIRONMENT.md` | read — fsync/synchronous_commit disabled **on the disposable local test container only** (`maacash-int-pg16`, loopback 55499); production durability untouched |
| Working tree / stash / untracked files | main worktree clean except untracked user artifacts (load-test evidence, `docs/testing/testing report.zip`) and 88 disposable `.tmp-*.log` files; `stash@{0}` (pre-existing evidence png changes) preserved untouched |

## 2. Current `origin/main` comparison

- `origin/main` at preflight: `edcf9fe` (merge of PR #67, `fix/public-signin-role-chooser`).
- `git merge-base --is-ancestor origin/main release/maacash-susu-enterprise-2026-11-27` → **true**: the release branch was built on top of current `origin/main`.
- `git log release..origin/main` → **empty** (zero commits on main missing from the release branch).
- The reconciliation merge `93917e6` produced a tree **identical** to the Phase 9 tip (`git diff 1a626eb 93917e6` is empty): every main-branch change was already contained in the phase branch; the merge preserved history without replacing newer code with older phase code.

## 3. Changes reconciled from current main

No conflict substitutions were required. The reconciliation brought the branch
history together (PR #67's role-chooser work, dependabot-merged CI fixes, the
Phase 1–9 chain) with a clean tree merge; CI's full gate (below) validated the
combined source.

## 4. Final release branch and merge commit

- Release branch: `release/maacash-susu-enterprise-2026-11-27` (worktree `BloomCore-One-susu-release`)
- Reconciliation commit: `93917e6` ("chore(release): reconcile Susu Phases 1-9 with current main")
- Deployed merge commit on `origin/main`: **`18e4262`** ("Merge pull request #68 …"), tree-identical to `93917e6`.

## 5. Pull request and CI results

PR #68 (release branch → `main`): **all 11 required checks passed** —
SQLite generate/lint/typecheck/tests/build (8m40s–8m49s), PostgreSQL migration
rehearsal and integration tests (2m14s–2m18s), mobile/offline browser tests,
secret scan (working tree and full history), CodeQL, dependency review.
Merged with a merge commit (the repository's permitted method). No force-push,
no branch-protection change, no direct push to `main`.

PR diff audited: 150 files, all Susu-phase work (admin surfaces, prisma
migrations, tests, docs). No `.env`, database, build output, credential or
generated-artifact files included.

## 6. Production commit deployed

**`18e4262`** — confirmed via the Render API as the commit of the deployment that reached **live**.

## 7. Render service and deployment verification

- Service: `maacash` (`srv-dbnaciff3r2c7382tjgg`), branch `main`, **autoDeploy: yes**, not suspended — verified live via the Render API rather than assumed.
- Domain: `https://maacash.bloomcoretech.com` (unchanged; no duplicate service created, no retired host reactivated).
- Deployment of `18e4262`: `build_in_progress` → `update_in_progress` → **`live`** (observed via API polling).
- No repeated restart or crash loop: health endpoints answered consistently across the monitoring window.

## 8. Database migration and backup evidence

- Render never runs migrations (repo policy: "Database schema is NEVER created or altered by a build"). The migration is an explicit operator step.
- All 8 new Susu migrations scanned for destructive SQL: **additive only** — no `DROP TABLE`, no `DROP COLUMN`, no `TRUNCATE`/`DELETE` of business records (the only TRUNCATE hits are comments stating records will not be truncated).
- Migration rehearsal (fresh PG16, existing-data upgrade, interrupted-migration recovery) passed locally and in CI.
- `prisma migrate status` against production before deploy: 70 of 78 migrations already applied; pending = **exactly the 8 Susu migrations**.
- Recovery point: owner confirmed the Neon history/restore window covers the migration moment (Neon API was unavailable that evening — its `api.neon.tech` hostname had no DNS record — so the provider-side recovery point was confirmed through the console by the owner).
- `prisma migrate deploy` applied all 8; post-deploy `migrate status`: **"Database schema is up to date!"**; `prisma migrate diff`: **"No difference detected."**
- No development seed or cleanup script touched production; no manual data edits.

## 9. Live smoke-test results (`https://maacash.bloomcoretech.com`, read-only)

| Check | Result |
|---|---|
| `/` landing page | 200 |
| `/login`, `/admin/login`, `/privacy` | 200 |
| `/api/health` | 200 `{"status":"ok"}` |
| `/api/health/ready` | 200 `{"status":"ready"}` |
| `/tab-session-sw.js` (service worker) | 200 |
| `/admin/billing`, `/admin/dashboard` unauthenticated | 307 → `/admin/login` (correct clean redirect) |
| No real payment, customer, contribution, withdrawal or subscription change was performed | confirmed |

No production business data was modified during smoke verification.

## 10. Subscription and authentication root cause

**ROOT CAUSE IDENTIFIED — FIXED AND TESTED LOCALLY (not yet live):**

1. `useRedirectHandler` replaced **every** server-action `NEXT_REDIRECT` with `router.replace("/login")` — a package restriction or permission denial was presented as an expired session.
2. `getTenantContext` classified any unexpected failure (including a transient database outage) as an invalid session and bounced signed-in owners to the login page.
3. `requireTenantContext` had a single denial shape; role/module/branch denials were indistinguishable from session loss.
4. Login routed owners to the dashboard even when the package could not start operations, deferring the block to a mid-workflow bounce.

Corrections: redirect digests now carry their true destination (same-origin paths only — open redirects refused); resolver failures throw a retryable `TenantContextError` (session preserved, error boundary with retry); denials route to `/unauthorized?reason=…` with plain-language explanations; login routes blocked packages directly to Billing & Plan with the resolved state. Billing & Plan stays reachable without an active package. Details in `OWNER_DASHBOARD_FIX_REPORT_2026-11-27.md` §2.1.

## 11. Admin-card navigation root cause

**ROOT CAUSE IDENTIFIED — FIXED AND TESTED LOCALLY (not yet live):**

`/admin/login` silently restored the previous administrator dashboard whenever the browser still held a valid session, so clicking the business-owner card behaved like "return to where I was". The card now links with `?switch=1` — a deliberate sign-in always shows the form; a plain visit still recognises a valid session (no re-authentication, no loop) and routes it correctly, including to Billing & Plan when the package is blocked. Sessions are never cleared, recreated or corrupted by the card.

## 12. Corrected subscription-gating behavior

Server-side classification (`src/lib/billing/access.ts`) now drives login, MFA
session issuance, `enforcePaidOperations` and the billing page's copy. States
are separated: `active`, `grace_period` (operable), `pending_payment`,
`failed`, `past_due`, `suspended`, `cancelled`, `refunded`, `expired`
(billing required), `none` (legacy grandfathering), `tenant_unavailable`.
Money operations stay server-gated (`requireTenantAdminMomo`/`Susu` and
`enforcePaidOperations`); the frontend change only stops mislabelling them.

## 13–15. Shift board, liquidity board, locations

**ROOT CAUSE IDENTIFIED — FIXED AND TESTED LOCALLY (not yet live):**

These pages catch every error from their guarded server actions and rendered
generic "could not be loaded" messages, combining real failures with redirect
destinations. Corrections: server redirects navigate; genuine failures render
retryable notices with **Try again** (loads are read-only; retry cannot
duplicate financial operations); loading skeletons fixed (locations' dangling
loading state corrected); empty datasets keep their valid empty states.

## 16. Full business-owner navigation audit

Every admin data module carries a tenant guard (verified by scanning all 16
action modules: `daily-account`, `susu-dashboard`, `momo-ledger`,
`branch-transfer`, `momo-history`, `worker`, `anomaly`, `staff`,
`zeli-anomaly`, `performance`, `provider-statement`, `messaging-settings`,
`tenant-policy`, `reporting`, `association`, `location` — all call
`requireTenant*` / `getApiTenantContext`). Package gating rides on
`requireTenantAdminMomo`/`Susu` → `enforcePaidOperations`; Billing & Plan
(`requireTenantAdmin`) is deliberately package-independent; audit/auth APIs are
session-guarded; settings/devices are static client shells with no data
dependency. Route inventory: Dashboard→daily-account+susu-dashboard actions;
Zeli BI→`requireTenantAdmin`; Locations/Workers/Ledger/Cash & Float/Liquidity/
Reconciliation/Shifts/Performance/Anomalies/Risk Intelligence/Agreements/
History/Reports(+Consolidated)→guarded MoMo actions; Susu section→
`requireTenantAdminSusu` pages + guarded actions; Association→guarded; Billing/
Staff/Policy/Messaging/Audit/Integrations/Settings→`requireTenantAdmin` or
static; Support→tenant-guarded support actions. All pages respect the logged-in
tenant via the session-derived `TenantContext` (no client-supplied tenant id).

## 17. MoMo UI layout corrections

**AUDITED AT RENDERED LEVEL — one presentation defect found and fixed.**

Objective scan: all 13 business-owner admin surfaces (dashboard, liquidity,
shifts, locations, ledger, transfers, reconciliation, anomalies,
risk-intelligence, performance, consolidated report, integrations, billing)
were rendered at 390 / 768 / 1280 / 1440 px and measured for horizontal
overflow (`scrollWidth` vs `clientWidth`, plus per-element inspection):
**zero horizontal overflow at every width**. Visual inspection of the
liquidity board and the redesigned capability page at 390 px and 1440 px
confirmed clean wrapping, correct GH₵ rendering, aligned metric cards and
legible tables. Shared primitives (SVG cedi glyph, overflow-x-auto table
wrappers, flex-wrap cards, mobile drawer) behave as designed.

One defect found and fixed: the integrations page's long static information
notice was duplicated onto the shared toast stack (`Notice` defaults
`popup=true`), and the floating copy covered the status legend on phones. The
page now renders it with `popup={false}` (the component's documented
"contextual panel" mode); visually verified after rebuild.

Pre-existing characteristic recorded (not a defect of this work, reproduced on
the release build): a full page load of an admin route after the 120-second
tab-assertion window can be redirected by the middleware to `/admin/login`,
where the session is recognised and the owner is forwarded to the dashboard.
The user is never signed out; only the originally requested destination is
lost. The middleware, service worker and assertion code are byte-identical
between the release and fix trees; the fix branch neither introduces nor
worsens it. Recommended future improvement (out of this release's scope):
carry the originally requested destination through the login forward.

## 18. Provider disclosure corrections

**FIXED AND TESTED LOCALLY.** Seven-state status model (available / sandbox /
not_configured / unavailable / coming_soon / manual_process /
requires_owner_setup), one status per capability, legend on the page, WhatsApp
configured-but-disabled now `unavailable` (not "not configured"), SMS provider
selected-but-no-adapter `unavailable` vs nothing-selected `not_configured`,
telco/bank/identity/customer-payment capabilities `unavailable` with truthful
boundary copy, accounting `manual_process`, approvals section hidden when
empty, `comingSoon` boolean removed. Every limitation from the disclosure
rules is preserved; nothing was hidden. Page remains read-only.

## 19. Test files and exact results

| File | Tests | Result |
|---|---|---|
| `tests/dashboard-access-matrix.test.ts` (new) | 18 | pass |
| `tests/dashboard-access-states.test.ts` (new) | 12 | pass |
| `tests/integration-capabilities.test.ts` (new) | 4 | pass |
| `tests/integration-readiness.test.ts` (rewritten) | 10 | pass |
| `tests/auth-email-password.test.ts` (1 assertion updated) | 26 | pass |
| `tests/tenant-status-access.test.ts` (mock aligned) | 6 | pass |
| `e2e/maacash-coming-soon.spec.ts` (rewritten for the truthful status model) | 8 (4 tests × 2 browser projects) | pass |
| Full release gate on the fix tree (`npm run test:release`) | unit **2,111 / 2,111**, PG integration **61 / 61**, e2e **129 / 129** | all 9 steps PASS |

Gate evidence trail: gate runs 1–3 and the browser-suite runs are documented in
`OWNER_DASHBOARD_FIX_REPORT_2026-11-27.md` §5, including the e2e
infrastructure defect (leaked `next start` process serving a stale build and
mutated database) that produced two invalid runs before its root cause was
fixed in `scripts/verify-e2e.mjs`.

## 20. Remaining defects and limitations

- Defect fixes are **not yet deployed** — they require the Stage 7 approval. Until then, the live app still shows the reported behaviors.
- Pre-existing tab-assertion characteristic (section 17): a full admin-page load after the 120-second assertion window may pass through `/admin/login` and land on the dashboard; the user stays signed in. Unchanged machinery, reproduced on the release build; improvement deferred out of scope.
- Render's log-query API endpoints returned 400/404 for programmatic access; deployment health was evidenced by deploy status + health/readiness endpoints + page responses instead of raw log lines.
- Neon's public API (`api.neon.tech`) had no DNS record for the entire evening; API-key-based automation (backup snapshot creation) could not run — the owner confirmed the recovery point via the console instead.
- One 5-second-timeout flake occurred in a file-scan branding test under heavy concurrent local I/O; it passed in clean re-runs (test untouched).
- Render free-tier cold starts (~15 min idle sleep) remain an operational limitation, documented in the deployment doc.

## 21. Disk cleanup details and recovered space

Executed after the release deployment and after all defect-fix work was
committed to the preserved local branch. Full details in
`MAACASH_DISK_CLEANUP_REPORT.md`. Summary:

- **11 disposable worktrees removed** (Phase 2–8, the three Susu integration
  worktrees, the Phase 9 verification worktree and the release worktree) —
  every branch tip verified reachable from released `origin/main` before
  removal, every branch itself kept.
- **88 disposable `.tmp-*` test logs** removed from the primary worktree
  (~2.9 MB) plus per-worktree tmp files.
- **Measured recovery ≥ 1.89 GB**; total is substantially larger (the remaining
  removed worktrees each carried node_modules and, for two of them, full
  production builds — not individually measured before deletion).
- Preserved: the primary worktree, the active defect-fix worktree, the zeli
  worktree, all branches, the pre-existing stash, all user load-test evidence
  and documents, uncertain items (a detached-HEAD temp worktree, pre-dating
  root-level logs, a Windows `nul` artifact) and all Docker test containers.

## 22. Defect-fix branch and commit

- Branch: `fix/maacash-dashboard-access-2026-11-27` (worktree `BloomCore-One-susu-dashboard-fixes`)
- Based on the release reconciliation commit `93917e6` (tree-identical to deployed `18e4262`)
- Commits:
  1. `de9f9e0` fix(dashboard): never present package, role or branch denials as a logout
  2. `3a99e23` fix(disclosures): give each provider capability one truthful status
  3. `054cd2d` test(dashboard): cover the owner access matrix and disclosure statuses
  4. `107ae95` fix(e2e): kill the whole verify-e2e server tree on Windows
  5. `a89042d` docs: record the owner-dashboard remediation and release evidence
  6. `8177388` fix(disclosures): stop the capability notice duplicating as a toast
- No database migration is required for these fixes (no schema change).
- Push/deploy: **pending owner approval** (Stage 7 boundary)

## 23. Explicit confirmation of what was and was not deployed

**Deployed to production (commit `18e4262`):** the complete verified Phase 1–9
Susu integration — branch foundation, collector operations, remittance
lifecycle, withdrawal controls, reconciliation, reporting, customer
onboarding, Phase 8 administration/support, Phase 9 verification fixes — plus
the 8 additive database migrations applied via the approved operator workflow.

**NOT deployed:** every dashboard-defect fix in sections 10–15 and 18 — the
auth/subscription redirect corrections, the shift/liquidity/locations error
handling, the admin-card behavior, the provider-disclosure redesign, and their
new tests. These live only on the local defect-fix branch and require owner
approval before push, PR, CI and deployment.

**Also not performed:** production data edits, real payments, seed scripts
against production, branch-protection changes, force-pushes, deletion of user
files, and any change to the service identity or domain.

## Defect classification summary

| Defect | Classification |
|---|---|
| Subscription restriction presented as logout | ROOT CAUSE IDENTIFIED · FIXED AND TESTED LOCALLY |
| Role/branch/feature denial presented as logout or permission wall | ROOT CAUSE IDENTIFIED · FIXED AND TESTED LOCALLY |
| Admin-card silent dashboard restore | ROOT CAUSE IDENTIFIED · FIXED AND TESTED LOCALLY |
| Shift board load error | ROOT CAUSE IDENTIFIED · FIXED AND TESTED LOCALLY |
| Liquidity board load error | ROOT CAUSE IDENTIFIED · FIXED AND TESTED LOCALLY |
| Locations load error | ROOT CAUSE IDENTIFIED · FIXED AND TESTED LOCALLY |
| Provider disclosure presentation | ROOT CAUSE IDENTIFIED · FIXED AND TESTED LOCALLY |
| MoMo layout quality | FIXED AND TESTED LOCALLY — rendered audit at 390/768/1280/1440 px: zero horizontal overflow across 13 surfaces; one toast-duplication defect found and fixed |
| Capability notice duplicating as a toast over the status legend | ROOT CAUSE IDENTIFIED · FIXED AND TESTED LOCALLY |
| E2E harness leaking its server process on Windows | ROOT CAUSE IDENTIFIED · FIXED AND TESTED LOCALLY (`scripts/verify-e2e.mjs`) |
| Admin route full-load after the 120 s tab-assertion window redirects via login to the dashboard | PRE-EXISTING (reproduced identically on the release build; machinery byte-identical between trees; user stays signed in). Documented with a recommended future improvement; intentionally not changed in this release. |
| Live verification of all fixes | NOT APPLICABLE YET — awaiting Stage 7 approval |
