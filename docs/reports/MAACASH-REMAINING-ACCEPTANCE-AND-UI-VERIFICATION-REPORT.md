# MaaCash — Remaining Acceptance, Auth Hardening and UI Verification Report

Date: 2026-11-08
Repository: `Delkay-byte/BloomCore-One`
Feature branch: `fix/auth-susu-ui-acceptance`
Base commit (`origin/main` at branch point): `1aa7a6e`
Pull request: [#22](https://github.com/Delkay-byte/BloomCore-One/pull/22)
Squash merge commit on `main`: `70ee74f9e145aa0df21d41194aef13335d8761da`
Production service: `maacash` (`https://maacash.onrender.com`)
Deployment status: **live and verified** (final deploy `dep-dbo10q67bikc73c9dhqg`)

**Evidence labels used below**

- **Verified** — executed in this environment or read directly from the code.
- **Calculated** — produced by the application's own arithmetic during tests.
- **Observation** — a finding from inspecting the implementation.
- **Limitation** — not executed, or executed only partially.
- **Recommendation** — proposed follow-up, not implemented here.

---

## 1. Scope

This work closes the acceptance items left open by release `1aa7a6e`:

1. The reported `401` from `/api/auth/me?module=momo` on the MoMo workspace.
2. End-to-end verification that a Susu withdrawal requires the administrator's own password.
3. UI polish for the collector, customer, administrator and MoMo workspaces.
4. Full browser acceptance at desktop and mobile widths.
5. Evidence for the four roles, tab-session isolation, refresh, copied URLs, logout and module isolation.

The previously merged MoMo accounting correction is not reworked. The combined
accountability formula, labels, reconciliation outcomes and submitted-account
read-only behaviour are unchanged.

---

## 2. Auth investigation and fix

### 2.1 Reported failure

A MoMo agent could see a `401` from `/api/auth/me?module=momo` after sign-in,
which left the workspace header without identity or tenant context.

### 2.2 Findings

- **Limitation:** the original `401` could not be reproduced against the isolated
  E2E database. It remains unconfirmed whether the production cause was a stale
  cached response, a service-worker timing race, or a module-cookie mismatch.
- **Observation:** several client workspaces called `/api/auth/me` after mount
  only to render identity, tenant name and module navigation. That made first
  paint depend on a client request whose credential attachment is asynchronous.
- **Observation:** `/api/auth/me` did not previously forbid caching. A cached
  `200` or `401` could disagree with the calling tab's proof-of-possession state.

### 2.3 Changes applied

- `src/app/api/auth/me/route.ts`
  - Added `dynamic = "force-dynamic"`.
  - Every response now carries
    `Cache-Control: no-store, no-cache, must-revalidate, private`,
    `Pragma: no-cache` and `Vary` on the tab proof headers.
  - Existing module selection, server session revalidation, revocation check and
    tenant resolution are unchanged.
- Worker, collector, customer and administrator workspaces now receive identity,
  tenant name, entitlement and navigation from server-resolved props.
  - `src/app/worker/(workspace)/WorkerShell.tsx` and
    `dashboard/WorkerDashboardClient.tsx`
  - `src/app/collector/(workspace)/CollectorShell.tsx` and
    `dashboard/CollectorDashboardClient.tsx`
  - `src/app/customer/(portal)/CustomerShell.tsx`
  - `src/components/AdminWorkspaceShell.tsx`, shared by `/admin/*` and
    `/susu/admin/*`
- `src/components/WorkspaceSwitcher.tsx` accepts a server-resolved `bothModules`
  prop and no longer issues an auth lookup for a single-module agent.
- `src/app/customer/(portal)/profile/page.tsx` maps the real action result
  (`{ customer, account, currentCollector, currentCycle }`) instead of casting a
  raw customer row. This fixes a genuine portal crash found during acceptance.

No authentication rule was weakened. Tab proof-of-possession, module
authorisation, server session validation, revocation, MFA and tenant scoping are
unchanged. No security check was moved to the client.

---

## 3. Susu withdrawal password verification

**Verified** by unit and browser tests.

- `verifyPasswordAction` requires an explicit `module`; the administrator session
  is resolved for that module. No password trimming, no fallback to another
  role's session, no shared cookie ambiguity.
- The withdrawal action runs only after successful step-up verification and
  still enforces:
  - administrator role and Susu entitlement;
  - tenant scope;
  - available-balance and cycle rules;
  - one-day commission on the first withdrawal in a cycle;
  - idempotency key reuse protection;
  - audit records for success and failure.
- Browser acceptance: a wrong password shows `Incorrect password` and no
  withdrawal is created; the administrator's own password completes exactly one
  withdrawal.
- Unit acceptance:
  - another administrator's genuine password is rejected for this session;
  - the correct password creates one withdrawal, records the authorising
    administrator, charges one day's commission and leaves the calculated
    balance;
  - the same idempotency key cannot post twice;
  - audit entries carry the acting administrator and tenant.

Commission rules were not changed.

---

## 4. UI changes

### 4.1 MoMo worker

- Server-resolved header, tenant and navigation.
- Live accountability summary remains beside the form on wide screens.
- Shortage still requires an explanation before submission; positive difference
  and balanced outcomes remain distinct.
- Submitted accounts remain read-only.
- Draft save state and restore are unchanged.

### 4.2 Susu collector

- Server-resolved identity and tenant.
- Header layout corrected at narrow widths.
- Collection dialog uses `role="dialog"`, `aria-modal`, a labelled heading,
  labelled amount input and Escape handling.
- Success tick replaces duplicate confirmation content.
- Duplicate “all caught up” card removed.
- Search, filters, visit list, collected list and remittance summary remain.

### 4.3 Customer portal

- Server-resolved name and business name.
- In-app sign-out confirmation dialog with Escape handling; no browser-native
  prompt.
- Profile page renders customer, account, collector and cycle correctly.
- Payments, statement, withdrawals, profile and settings verified.

### 4.4 Administrator and Susu administrator

- One shared shell for `/admin/*` and `/susu/admin/*`.
- Module navigation follows the tenant entitlement resolved on the server.
- Zeli Analytics entry is hidden when the tenant has no entitlement.
- Existing page content and actions are unchanged.

---

## 5. E2E coverage added

| File | Coverage |
|---|---|
| `e2e/momo-workflow.spec.ts` | MoMo session, `no-store`, module isolation, fresh-tab denial, refresh, balanced/positive/shortage submissions, draft persistence |
| `e2e/role-workflows.spec.ts` | Collector search and collection, customer portal pages and sign-out, dual-module admin dashboard, withdrawal password rejection then success, remittances and MoMo reports |
| `e2e/tab-sessions.spec.ts` | Two administrators in one browser profile, forced worker stop, logout isolation, copied URL isolation, worker/customer cross-role isolation |
| `e2e/responsive.spec.ts` | 360, 390, 768 and 1280 px screenshots plus document-overflow checks |

The E2E seed now includes a MoMo worker, an assigned branch, customer-portal
access, a second collector customer with a fresh cycle, and three draft daily
accounts for balanced, positive and shortage scenarios. All fixtures live only
in `tests/e2e.db`.

Selector defects in `e2e/correction.spec.ts` and `e2e/platform.spec.ts` were
corrected: the correction reason is now addressed by its accessible name, the
platform revoke button is scoped to the entitlement panel, and the emergency
stop test accepts its deliberate confirmation dialog.

---

## 6. Automated verification results

All commands were run sequentially so the shared test database was not used by
two suites at once.

| Command | Result |
|---|---|
| `npm run test:e2e` | **48 passed** (47 Chromium desktop, 1 mobile Chromium) |
| `npm test` | **657 passed** across 65 files |
| `npm run test:security` | **51 passed** across 6 files |
| `npm run typecheck` | Passed, no output |
| `npm run build` | Passed |
| `npm run lint` | 0 errors, 73 pre-existing warnings |

The security suite includes tenant isolation, financial security, security
hardening, administrator recovery, offline isolation and staff-status tests.

---

## 7. Browser acceptance by role

| Role | Verified behaviour |
|---|---|
| MoMo agent | Sign-in, server-resolved header and branch, `/api/auth/me?module=momo` returns the agent, other modules return `Not authenticated`, fresh tab returns `Not authenticated`, refresh keeps identity, daily account submission outcomes |
| Susu collector | Sign-in, assigned customer search, collection dialog, recorded contribution, today's money summary, remittance discrepancy display |
| Customer | Sign-in, dashboard, payments, statement, withdrawals, profile, settings, sign-out dialog, Escape cancellation |
| Administrator | Sign-in, both entitled modules, withdrawal wrong-password rejection, withdrawal success, remittance page, MoMo reports |
| Platform operator | Zeli provider controls, entitlement grant and revoke, emergency stop, global availability switch; no tenant financial data on the platform page |

Tab isolation was exercised inside one browser profile:

- two administrators in two tabs keep separate identities after refresh;
- logout in one tab leaves the other authenticated;
- a copied authenticated URL in a new tab does not inherit the session;
- a worker tab and a customer tab coexist with separate module and tenant scope;
- a forced worker stop fails closed without cross-tab leakage.

---

## 8. Responsive evidence

Screenshots were captured at 360, 390, 768 and 1280 CSS pixels. Document-level
horizontal overflow was asserted on login, worker, collector and customer
surfaces. Wide tables scroll inside their own containers.

Evidence folder:
`docs/reports/evidence/maacash-acceptance-responsive/`

36 images:

| Surface | Files |
|---|---|
| Sign-in role chooser | `login-<width>-roles.png` |
| MoMo agent dashboard | `worker-<width>-dashboard.png` |
| MoMo read-only submitted account | `worker-<width>-daily-readonly.png` |
| Susu collector dashboard | `collector-<width>-dashboard.png` |
| Customer dashboard | `customer-<width>-dashboard.png` |
| Customer statement | `customer-<width>-statement.png` |
| Administrator dashboard | `admin-<width>-dashboard.png` |
| Susu withdrawals | `admin-<width>-withdrawals.png` |
| MoMo reports | `admin-<width>-reports.png` |

---

## 9. Financial and tenant safety

- Tests used the isolated SQLite database `tests/e2e.db`; no production
  credentials, real customer records, real money or production MFA state were
  touched.
- No schema migration was added. No persisted field changed.
- Every new server-resolved prop is informational for rendering. Pages and
  server actions continue to resolve the tenant and role from the session.
- Withdrawal commission, cycle, idempotency and audit behaviour are unchanged
  and now covered by explicit tests.

---

## 10. Remaining limitations

- **Limitation:** the production `401` was not reproduced. Its original trigger
  remains unconfirmed. The no-store response and server-resolved first paint
  remove the two most plausible causes but cannot prove the production cause
  without an authorised production account.
- **Limitation:** an owner or authorised production administrator must still sign
  in to the deployed service and confirm the MoMo header, daily account and Susu
  withdrawal flow with production credentials.
- **Observation:** lint retains 73 warnings that predate this branch. None are
  errors and none were introduced to silence a real defect.
- **Recommendation:** if the production symptom returns, capture the response
  status and headers for `/api/auth/me?module=momo` from the affected tab before
  reloading. That evidence will identify a cached response versus a session
  mismatch.

---

## 11. Changed files

Application:

- `src/app/api/auth/me/route.ts`
- `src/app/worker/(workspace)/layout.tsx`
- `src/app/worker/(workspace)/WorkerShell.tsx`
- `src/app/worker/(workspace)/dashboard/page.tsx`
- `src/app/worker/(workspace)/dashboard/WorkerDashboardClient.tsx`
- `src/app/collector/(workspace)/layout.tsx`
- `src/app/collector/(workspace)/CollectorShell.tsx`
- `src/app/collector/(workspace)/dashboard/page.tsx`
- `src/app/collector/(workspace)/dashboard/CollectorDashboardClient.tsx`
- `src/app/customer/(portal)/layout.tsx`
- `src/app/customer/(portal)/CustomerShell.tsx`
- `src/app/customer/(portal)/profile/page.tsx`
- `src/app/admin/(workspace)/layout.tsx`
- `src/app/susu/admin/layout.tsx`
- `src/components/AdminWorkspaceShell.tsx`
- `src/components/WorkspaceSwitcher.tsx`

Tests and fixtures:

- `e2e/helpers.ts`
- `e2e/momo-workflow.spec.ts`
- `e2e/role-workflows.spec.ts`
- `e2e/tab-sessions.spec.ts`
- `e2e/responsive.spec.ts`
- `e2e/correction.spec.ts`
- `e2e/platform.spec.ts`
- `scripts/seed-e2e.ts`
- `tests/reauth.test.ts`

Documentation:

- `docs/reports/MAACASH-REMAINING-ACCEPTANCE-AND-UI-VERIFICATION-REPORT.md`
- `docs/reports/evidence/maacash-acceptance-responsive/`

---

## 12. Deployment record

| Item | Value |
|---|---|
| Pull request | [#22](https://github.com/Delkay-byte/BloomCore-One/pull/22) |
| CI check | Lint, typecheck, test, build — passed (3m 31s) |
| Squash merge commit | `70ee74f9e145aa0df21d41194aef13335d8761da` (code), `6bbac4985e93b6fe5f3d760db2aea758f09f5fb0` (report record) |
| Deploy identifier | `dep-dbo10q67bikc73c9dhqg` (final) |
| Deployed commit SHA | `6bbac4985e93b6fe5f3d760db2aea758f09f5fb0` |
| `/api/health` | **200**, `status=ok`, `env=production`, commit matches |
| `/api/health/ready` | **200**, `status=ready`, `database=ok` |
| `/api/auth/me?module=momo` unauthenticated | **401**, `Cache-Control` contains `no-store`, `Vary` includes `x-bloomcore-tab-proof` and `x-bloomcore-tab-request-id` |

The code deploy `dep-dbo0t9gu01pc73dvi2fg` went live at
2026-11-08T05:57:22Z on merge commit `70ee74f`. The record-only follow-up was
deployed as `dep-dbo10q67bikc73c9dhqg`, which went live at
2026-11-08T06:04:48Z on `6bbac49`. Health, readiness and the unauthenticated auth
response were re-verified against the final deployment. Behavioural code is
identical between the two commits.

Production authenticated flows were not exercised because no authorised
production account was available to this agent.

---

## 13. Final status

`IMPLEMENTATION PASSED — OWNER PRODUCTION LOGIN STILL REQUIRED`

All implementation, automated tests and browser sweeps passed in the isolated
environment. Production confirmation requires an authorised owner sign-in.
