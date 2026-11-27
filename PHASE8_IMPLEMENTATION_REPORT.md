# MaaCash Susu Enterprise Transformation — Phase 8 Implementation Report

**Phase:** 8 — Enterprise Administration and Support
**Branch:** `feat/susu-enterprise-phase-8-admin-support`
**Worktree:** `BloomCore-One-susu-phase-8`
**Baseline:** `8a98782` (Phases 1–7 integration complete)
**Date:** 2026-11-27
**Scope:** local-only implementation and verification. No push, pull request, merge to main, deployment, production database access, provider connection or customer data was used.

---

## 1. Executive summary and classification

Phase 8 adds the administrative layer a tenant business and the platform support team need to run Susu in production: a staff lifecycle board that can offboard, reactivate, re-role and re-scope people without deleting history; a tenant-aware support request system with conversation, escalation, resolution and reopening; a platform support queue that sees every tenant but leaks no internal note back to the business; controlled, audited data exports; and an operational guide computed from the tenant's real state rather than a static checklist.

All implementation is additive. No existing authorisation predicate, tenant boundary, financial invariant or test was weakened. The only behaviour change to an existing module is the closure of the Phase 6 gap where Susu report exports produced no audit record; every export now writes one.

| Capability | Classification |
|---|---|
| Staff onboarding (account creation and first access) | **IMPLEMENTED BUT NOT FULLY TESTED** — creation is the pre-existing administrator flow, reused unchanged; Phase 8 adds the lifecycle view but no Phase 8 test exercises account creation end to end |
| Staff offboarding and reactivation | **IMPLEMENTED AND TESTED** |
| Staff role, branch assignment and session controls | **IMPLEMENTED AND TESTED** |
| Tenant support intake and conversation | **IMPLEMENTED AND TESTED** |
| Support escalation, resolution, closure and reopening | **IMPLEMENTED AND TESTED** |
| Platform service operations views | **IMPLEMENTED BUT NOT FULLY TESTED** — data layer and queue rendering are tested; the acknowledge/assign/escalate/resolve forms are exercised only through server-action tests, not through the browser |
| Controlled tenant data exports | **IMPLEMENTED AND TESTED** |
| Tenant training and operational guidance | **IMPLEMENTED AND TESTED** |
| Auditable administrative actions | **IMPLEMENTED AND TESTED** |
| PostgreSQL parity and migration portability | **IMPLEMENTED AND TESTED** |
| Support/admin rate limiting | **IMPLEMENTED BUT NOT FULLY TESTED** — limits are wired into the actions, but no dedicated test drives a subject to the ceiling |

No capability is claimed as implemented on the strength of a report, screenshot or route existing. Each row above is backed by the code path and the evidence recorded in section 13.

---

## 2. Scope, constraints and baseline

### 2.1 Included

- Tenant staff lifecycle: offboard, reactivate, change role, grant and revoke branch membership, revoke sessions, readiness checks, directory export.
- Tenant support: create, list, read, reply, reopen, counts, export.
- Platform support: queue, summary, assignment, acknowledgement, escalation, internal notes, replies, resolution, closure, reopening, export, agent list.
- Platform navigation entry and tenant navigation entries.
- Operational guide with live status per step and an explanation of the support boundary.
- Additive Prisma models for SQLite and PostgreSQL, one migration.
- Automated tests and a fresh PostgreSQL 16 migration rehearsal.

### 2.2 Excluded, and confirmed not performed

| Prohibited action | Status |
|---|---|
| Push, pull request, merge into main | Not performed |
| Deployment (Vercel, Render, HCode) | Not performed |
| Production or Neon/Render database access | Not performed |
| Hubtel or live Paystack connection | Not performed |
| Production migration | Not performed |
| Real customer data | Not used; all fixtures are synthetic |
| 1,000-VU load test | Not performed |
| Destructive Git (`reset --hard`, `clean`, stash, branch deletion) | Not performed |
| Phase 9 work during Phase 8 | Not started |

The pre-existing `stash@{0}` in the repository was left untouched.

### 2.3 Baseline

Phase 8 branched from `8a98782` in a dedicated worktree. The baseline was re-verified before any edit: `git status --porcelain` was empty and `git rev-parse HEAD` returned `8a987825e93898eede16fd4ac60802ae4ccf6e44`. `node_modules` was copied from the verified Phase 1–7 worktree because this Windows host cannot compile `better-sqlite3` (no MSVC toolchain); no dependency was added or upgraded.

---

## 3. Design and reuse decisions

1. **Reuse the existing identity, tenant and branch model.** Support requests reference `User`, `BusinessTenant` and `Location`; there is no parallel "customer support account" table and no impersonation. A support agent reads a request through an explicit platform guard; they do not receive a tenant session.
2. **The tenant comes from the session, never from the body.** `createSupportRequest` accepts category, priority, subject, description and an optional branch. The tenant id is taken from the verified context, and a supplied branch must be a tenant-owned branch the caller may read.
3. **Administrators see their scope; staff see themselves.** A company-wide administrator sees all tenant requests. A branch-scoped administrator sees requests for their branches plus their own submissions. Every other staff member sees only requests they submitted. This mirrors the Phase 2–7 branch model instead of inventing a second visibility rule.
4. **Internal notes are excluded in the database predicate.** Tenant queries add `visibility: "tenant"` to the Prisma `where`, so a page cannot leak an internal note by forgetting a filter in the component.
5. **Offboarding never deletes history.** It marks the account inactive, bumps `tokenVersion`, revokes sessions, deactivates branch memberships and an attached collector record, forces a password reset, and writes both the domain audit row and a support-independent platform record where relevant. Assignments, remittances and approvals remain and are what block an unsafe offboarding.
6. **A blocked offboarding is a feature.** The readiness check lists live responsibilities. Offboarding refuses while any remain, with a named blocker rather than a generic failure. The user must transfer or settle work first.
7. **Step-up authorisation is purpose- and target-bound.** Three new purposes were added: `staff.lifecycle` for offboarding, reactivation and session revocation; `staff.assignment` for role and branch changes; and `admin.export` for the staff directory. Grants are single-use, five-minute, bound to the session and the target user or dataset, so a grant for one person or one export cannot authorise another.
8. **Exports are metadata-only and bounded.** The staff directory and both support exports contain no message bodies, no internal notes and no credential material. They are capped at 5,000 rows, rate-limited and audited. The platform export is also platform-audited.
9. **The guide computes rather than asserts.** Each checklist item queries real state (branches, active staff, active collectors, active withdrawal policy, a remittance, a reconciliation, a support request, a second administrator). A new business sees honest "to do" items.
10. **Existing UI conventions were reused.** Tenant pages use the existing `card`, `btn`, `badge` and design tokens; platform pages use the existing slate palette, `SupportQueueTools` follows the existing CSV download component pattern, and the staff board uses the existing modal and notice components.

No new dependency, no schema rewrite, no removed field and no changed existing route contract was introduced.

---

## 4. Staff onboarding, offboarding and access changes

### 4.1 Onboarding

Account creation remains the existing administrator flow at `/admin/staff`. Phase 8 does not duplicate or replace it; the lifecycle board links to it ("Add a staff member"). This keeps password policy, invite delivery, first-login and tenant checks in one place.

The Phase 8 lifecycle board at `/susu/admin/staff` is the operational view over accounts that already exist. It shows full name, email, role, status, branch memberships, active session count, outstanding responsibilities, and whether the person is ready to offboard. It lists active people first and offboarded people below, so history stays visible.

**Classification: IMPLEMENTED BUT NOT FULLY TESTED.** The creation path is inherited, not re-proven by Phase 8 tests; the board and its read model are covered by the staff lifecycle suite and the e2e page check.

### 4.2 Offboarding

`offboardStaff({ userId, reason, stepUpToken })` performs, in order:

1. Rejects a missing or short reason (minimum 10 characters).
2. Rejects the actor's own account, so an administrator cannot lock themselves out.
3. Rejects a user outside the actor's tenant.
4. Loads the readiness report and refuses while any blocker exists, returning the blocker list.
5. Claims the single-use `staff.lifecycle` grant bound to that user and to the current session.
6. Inside a transaction, sets the account inactive, increments `tokenVersion`, sets `forcePasswordReset`, deactivates branch memberships, deactivates an attached collector, and revokes every session record.
7. Writes an audit row `user.staff_offboarded` with the reason and actor.

Blockers cover active collector/customer assignments, outstanding remittances, pending approvals or corrections, and any other live responsibility the readiness query detects. A blocker is displayed with a human description and a count, not an internal id.

**Classification: IMPLEMENTED AND TESTED.**

### 4.3 Reactivation

`reactivateStaff({ userId, reason, stepUpToken })` requires a reason of at least five characters, refuses self-reactivation, confirms the account is currently inactive, restores the account, and reactivates an attached collector record only when that collector was not separately suspended. It writes `user.staff_reactivated`. It never restores old sessions or old branch memberships silently; access must be granted again.

**Classification: IMPLEMENTED AND TESTED.**

### 4.4 Role and branch changes

- `changeStaffRole` allows only worker and collector transitions from the tenant console. Promoting to administrator is refused with a message directing the business to platform support. This preserves the Phase 3–7 rule that a tenant cannot mint its own platform-level privilege. A worker-to-collector change creates the collector record in the same transaction.
- `assignStaffBranch` grants a branch membership with an explicit role.
- `revokeStaffBranchMembership` requires a reason, marks the membership inactive, and audits the change.
- `revokeStaffSessions` signs a person out everywhere without deactivating the account; it bumps `tokenVersion` and revokes session records.
- All of the above require a fresh `staff.assignment` or `staff.lifecycle` grant as appropriate.

**Classification: IMPLEMENTED AND TESTED.**

---

## 5. Tenant support intake and conversation

### 5.1 Intake

`createSupportRequest` validates category and priority against closed lists, normalises and bounds the subject (140 characters) and description (10–4,000 characters), rejects credential-shaped text (private keys, provider keys, bearer tokens, JWT-shaped strings, and `password/pin/otp/secret: value` patterns) before anything is stored, checks branch access, and applies the `supportRequest` rate limit (10 per 10 minutes per subject). It generates a `SUP-<year>-<6-character>` reference, retries up to three times on a unique collision, then writes the request, a `created` event and the tenant audit row in one transaction.

The tenant page shows the business's requests, a status count strip, the intake form and a link to each thread. A collector's default branch is applied when the request form omits a branch and the caller is a collector, so the request is routed to the right operational area without trusting the browser.

### 5.2 Conversation

`replyToSupportRequest` lets the submitter or an authorised administrator add a tenant-visible message. It refuses a closed request, moves `lastActivityAt`, and records an event. `getSupportRequestDetail` returns only tenant-visible messages, the request metadata, the event history and the resolution note. A non-administrator cannot read another person's request; a branch-scoped administrator cannot read outside their branches.

`reopenSupportRequest` is administrator-only, requires a reason of at least five characters, increments `reopenedCount`, clears the previous resolution, moves the status to `open`, and records an event and audit row. Reopening is deliberately not available to the original submitter, so a business cannot silently restart a closed dispute without its administrator seeing it.

**Classification: IMPLEMENTED AND TESTED.**

---

## 6. Support escalation, resolution and closure

The platform support workflow is a guarded state machine in `src/lib/support.ts`:

```
open -> acknowledged -> in_progress -> resolved -> closed
   \          \             \
    +----------> escalated --+--> resolved -> closed
open <- reopened (from resolved or closed, with reason)
```

`canTransitionSupport` is the single source of truth; actions call it before writing, and the UI only offers transitions the current status allows. Each action requires a live platform session and records:

| Action | Effect | Audit |
|---|---|---|
| Acknowledge | status `acknowledged`, assigns the acting agent, sets `assignedAt` | `support.acknowledged` |
| Assign | validates the target agent is active, reassigns | `support.assigned` |
| Escalate | requires a reason ≥5 characters, sets `escalated`, `escalatedAt`, increments `escalationLevel` | `support.escalated` |
| Internal note | message with `visibility: "internal"`, never returned to the tenant | `support.internal_note_added` |
| Reply | tenant-visible message, moves `open/acknowledged` to `in_progress`, assigns if unassigned | `support.replied` |
| Resolve | requires a resolution note ≥10 characters, sets `resolvedAt`, `resolvedAgentId`, `resolutionNote` | `support.resolved` |
| Close | allowed from `resolved`; from `escalated` it additionally requires a reason | `support.closed` |
| Reopen | requires a reason, increments `reopenedCount`, clears resolution, status `open` | `support.reopened` |

Every platform action revalidates `/platform/support` and the request page. No action accepts a tenant id from the browser: the request row supplies it and the platform audit row records the request reference and tenant.

**Classification: IMPLEMENTED AND TESTED.**

---

## 7. Platform service operations

`/platform/support` is the service-operations view:

- Eight summary cards: open work, unassigned, escalated, urgent open, older than 48 hours, awaiting first response, resolved in the last seven days, and businesses with open requests.
- Filters for status, priority, category, assignment (all, mine, unassigned) and free-text search over reference and subject. Urgent work is ordered first.
- A queue table linking to each request, with priority, age, assignee and last activity.
- A CSV export of the filtered queue that contains metadata only and writes a platform audit row.

`/platform/support/[id]` shows the request, the submitting business and person, the tenant-visible conversation, internal notes clearly badged as internal, the resolution block, an assignment/acknowledgement panel, and an audit trail behind a disclosure. Every reply, note, assignment, escalation, resolution, closure and reopening is available from that page.

The platform shell gained a "Support Queue" entry with a life-buoy icon.

**Classification: IMPLEMENTED BUT NOT FULLY TESTED.** The queue data, filtering, summaries and every server action are tested; the browser journey covers the queue rendering the request a business opened. The individual platform action forms are not clicked in a browser test.

---

## 8. Controlled tenant data exports

### 8.1 Staff directory

`exportStaffDirectoryCsv({ stepUpToken })`:

- Requires the tenant administrator guard and a fresh `admin.export` grant bound to the dataset `staff_directory`.
- Applies burst (2 per 10 seconds) and sustained (10 per 10 minutes) limits per administrator.
- Builds rows inside the actor's branch scope, so a branch-limited administrator sees only staff in their branches.
- Emits `Full name,Email,Phone,Role,Status,Branch access,Collector status,Active sessions,Joined (UTC)` via the shared CSV builder, which neutralises spreadsheet formulas.
- Writes `user.staff_directory_exported` before returning the file, with the row count and dataset.
- Names the file `staff-directory-<YYYY-MM-DD>.csv`.

### 8.2 Support exports

- Tenant: `exportTenantSupportRequests` returns request metadata for the caller's scope, with no messages, and audits `support.exported`. Filename `support-requests-<date>.csv`.
- Platform: `exportSupportQueue` returns filtered queue metadata, no bodies and no internal note counts, and writes a platform audit row `support.exported`.

### 8.3 Financial report export audit (Phase 6 gap)

The Phase 6 verification found that Susu report exports returned a CSV without recording who exported it. Phase 8 closes that gap in `susu-reporting.actions.ts`: a shared `finishExport` helper writes `finance.susu_report_exported` with report name, row count, date range, optional branch and format before any of the four report exports returns. A test now proves the audit row exists and carries the row count.

**Classification: IMPLEMENTED AND TESTED.**

---

## 9. Tenant training and operational guidance

`/susu/admin/guide` is a working checklist, not marketing copy:

- Eight steps: branches, active staff, active collector, withdrawal policy, a recorded remittance, a reconciliation, a support request, and a second administrator. Each step shows done/to-do, the reason it matters and a deep link.
- The "second administrator" step is owned by the platform, because a tenant cannot create one; the page says so.
- "Operating rhythm" describes daily, weekly and monthly routines.
- "What support can and cannot do" states plainly that support will never ask for a password, PIN, API key or customer account number, and that support cannot change financial history or approve a withdrawal.

The guide reads live counts, so a business that has not configured Susu cannot see a false "ready" state.

**Classification: IMPLEMENTED AND TESTED.**

---

## 10. Auditability and administrative action history

Phase 8 uses the existing audit infrastructure rather than a parallel log:

- Tenant actions call `createAuditLogTx` inside the transaction, so a failed write cannot leave an audit claim without the change.
- Platform actions call `createPlatformAuditLog` after the write and record the request reference and the tenant.
- Offboarding, reactivation, role changes, branch grants/revocations and session revocation all carry the reason and the actor.
- Exports record the dataset, row count and, for support, the filter context.
- The platform request page renders the audit trail, so an operator can see who did what to a request without reading the database.

Audit rows are never presented as a substitute for authorisation; they are evidence after the fact. Their creation is best-effort for tenant audit and transactional for platform writes as per the existing helpers.

**Classification: IMPLEMENTED AND TESTED.**

---

## 11. Data model, migrations and portability

The additive block `// PHASE 8 - ENTERPRISE ADMINISTRATION AND SUPPORT` was added to both `prisma/schema.prisma` (SQLite) and `prisma/schema-pg.prisma` (PostgreSQL):

- `SupportRequest`: unique reference, tenant, optional branch, submitter, category, priority, status, subject, description, assignment, escalation level/time, resolution, closure, reopen count and last activity. Five indexes cover the queue, tenant scope, submitter, assignment and status.
- `SupportMessage`: request, author type, optional user or agent, visibility, body, timestamps, cascade on request delete.
- `SupportEvent`: request, event type, actor type and ids, from/to status, reason, timestamp, cascade.
- Back-relations on `BusinessTenant`, `Location` and `PlatformSuperAdmin`.

The migration `prisma/migrations/20270105_susu_admin_support/migration.sql` is portable: plain `CREATE TABLE`, `CREATE INDEX` and `ALTER TABLE ... ADD CONSTRAINT` statements that apply to both SQLite and PostgreSQL through the shared migration chain. It creates no SQLite-only syntax and no PostgreSQL-only type.

Verification:

| Check | Result |
|---|---|
| `npx prisma validate` (both schemas) | pass |
| `npx prisma migrate deploy` on a fresh PostgreSQL 16 database | 78 migrations applied, exit 0 |
| `npx prisma migrate status` | "Database schema is up to date!" |
| `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema-pg.prisma` | "No difference detected." (exit 0) |
| PostgreSQL integration suite | 15 files, 61 tests, all pass |
| SQLite schema preparation | pass |

The fresh database was `maacash_phase8_fresh` on the local disposable PostgreSQL 16 container at port 55499. No production, Neon or Render host was contacted.

**Classification: IMPLEMENTED AND TESTED.**

---

## 12. Authorization, tenant isolation and security controls

- **Platform vs tenant.** Tenant support actions use the tenant context; platform actions use `requirePlatformAdmin`. A tenant session cannot call a platform action and vice versa. Tests cover both directions, including a missing platform session.
- **Tenant isolation.** Every tenant query pins the session tenant id. The cross-tenant test creates two businesses and proves each sees only its own request.
- **Branch scope.** Branch-scoped administrators are limited in both list and detail reads and in exports. A forged branch id is rejected by `assertBranchAccess` before the write.
- **No impersonation.** Support reads through the platform guard; it never mints a customer or staff session.
- **Internal notes.** Filtered in the database predicate for tenant reads and asserted absent from the tenant detail and tenant export in tests.
- **Credential screening.** Credential-shaped text is rejected before storage; a test sends `password: Hunter2!` and asserts refusal.
- **Step-up.** New purposes are single-use, five-minute, session-bound and target-bound. Tests prove a second offboarding with the same grant fails and that an offboarding without a grant leaves the account untouched.
- **Self-protection.** An administrator cannot offboard or reactivate themselves.
- **Privilege ceiling.** Tenant administrators cannot create or promote an administrator; a test asserts the role stays unchanged and the error explains why.
- **Session revocation.** Offboarding and explicit sign-out revoke session records and bump `tokenVersion`; tests assert every session is revoked.
- **CSV safety.** Shared `csvCell` neutralises formula triggers; exports contain no password hashes or message bodies.
- **Rate limits.** Support creation, support replies and administrative exports are limited per subject. Limits are wired but not driven to the ceiling by a dedicated test.
- **Dual-session support access.** A business owner who signed in through the private admin login can use support without a separate Susu tab cookie; the resolver still requires a live tenant session and derives the role from the database.

**Classification: IMPLEMENTED AND TESTED**, with rate-limit ceilings and browser-level platform actions the two not-fully-tested areas.

---

## 13. Test evidence and verification results

### 13.1 New Phase 8 tests (43 tests)

| File | Tests | What it proves |
|---|---|---|
| `tests/susu-support-tenant.test.ts` | 12 | creation and reference, event and audit, credential rejection, foreign branch refusal, cross-tenant isolation, non-admin own-only visibility, branch-scoped admin visibility, internal notes never returned, reply/closed behaviour, administrator reopen and count, non-admin reopen refusal, export metadata without internal bodies plus audit, tenant-only counts |
| `tests/susu-staff-lifecycle.test.ts` | 12 | overview shape, blockers and refusal with live assignment, reason length, self-offboard refusal, missing step-up leaves account active, full offboarding effects (status, tokenVersion, memberships, sessions, audit), single-use grant, collector reactivation, worker-to-collector promotion, admin promotion refusal, branch grant/revoke, sign-out without deactivation |
| `tests/platform-support.test.ts` | 13 | summary counts, urgent ordering and assignment filters, acknowledge, reassign, inactive-agent refusal, escalate with level and audit, reply moving status, internal note hidden from tenant but visible to agent, resolve note requirement, close/resolve/reopen flow, escalated close reason, metadata-only export and platform audit, unauthenticated refusal |
| `tests/susu-guide-and-export.test.ts` | 6 | honest fresh guide, all live steps complete when records exist, second-admin remains to-do, staff export requires a grant, directory export content and audit, branch-limited export scope, Susu report export audit |

### 13.2 Existing suites re-run after the change

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0, 0 errors, 193 warnings — the baseline count; three initial new warnings were cleaned rather than added to the backlog |
| `npm test` (SQLite) | **181 files, 2,072 tests, all passed**, 330.88 s on the final tree (387.14 s on the first run) |
| `npm run test:pg` (PostgreSQL 16) | **15 files, 61 tests, all passed**, 53.60 s |
| `npm run build` | exit 0; both new routes (`/susu/support`, `/susu/support/[id]`, `/susu/admin/staff`, `/susu/admin/guide`, `/platform/support`) compiled |
| `npx playwright test e2e/maacash-support.spec.ts` | see section 13.3 |
| Fresh PostgreSQL migration rehearsal | 78 migrations, status clean, no drift |

Baseline for comparison: 177 files / 2,029 tests / 451.36 s and 15 files / 61 tests. Phase 8 adds 4 files and 43 tests; the runtime difference is host variance, not a slowdown introduced by the new schema (the support tables are indexed and the tests are small).

### 13.3 Browser acceptance

`e2e/maacash-support.spec.ts` runs three tenant checks and one platform check:

1. An administrator reaches `/susu/support`, opens a request with a real subject and description, lands on the thread URL, and sees the generated `SUP-<year>-<code>` reference.
2. `/susu/admin/guide` shows the checklist, the operating rhythm and the support boundary.
3. `/susu/admin/staff` shows the staff board, the "Add a staff member" link and the outstanding/sessions columns.
4. The platform console shows the support queue and the request the business just opened.

Result: **1 file, 4 tests passed** (see the recorded run in section 13.4).

### 13.4 Exact command results

| Command | Exact result |
|---|---|
| `git rev-parse HEAD` at branch point | `8a987825e93898eede16fd4ac60802ae4ccf6e44` |
| `npx prisma validate` (SQLite and PostgreSQL schemas) | valid |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0, `196 problems (0 errors, 196 warnings)` before the warning cleanup; `193 problems (0 errors, 193 warnings)` after it |
| `npm test` | `Test Files 181 passed (181)`, `Tests 2072 passed (2072)`, 330.88 s |
| `npm run test:pg` | `Test Files 15 passed (15)`, `Tests 61 passed (61)`, 53.60 s |
| `npm run build` | exit 0; `/susu/support`, `/susu/support/[id]`, `/susu/admin/staff`, `/susu/admin/guide`, `/platform/support` compiled |
| `npx playwright test e2e/maacash-support.spec.ts` | `4 passed (2.4m)` |
| Fresh PostgreSQL 16 `migrate deploy` | `78 migrations`, "All migrations have been successfully applied." |
| Fresh PostgreSQL 16 `migrate status` | "Database schema is up to date!" |
| `migrate diff --from-config-datasource --to-schema prisma/schema-pg.prisma` | "No difference detected." |

The fresh PostgreSQL rehearsal used database `maacash_phase8_fresh`; the PostgreSQL suite used the disposable `maacash_test_int` database with `PG_TEST_CONFIRM=DISPOSABLE_TEST_DATABASE`. The safety guard refuses any non-loopback or non-`maacash_test*` target.

---

## 14. Defects, gaps and discrepancies

1. **Staff onboarding is inherited, not re-proven.** The Phase 8 board links to `/admin/staff`; no Phase 8 test creates a staff account. This is why onboarding is classified as not fully tested rather than implemented and tested.
2. **Platform action forms are not browser-tested.** The server actions are covered; the queue is browser-tested for rendering. A future Phase 9 pass should click acknowledge, assign, resolve and close in the browser.
3. **Rate-limit ceilings are not tested.** The limits exist and are applied, but no test drives a caller to the limit and asserts the refusal. The existing generic rate-limit tests cover the primitive, not these subjects.
4. **The last-administrator guard is effectively unreachable from this surface.** The actor must be an active administrator, and the action rejects self-offboarding, so a tenant cannot use this page to remove its final administrator by accident. The code still checks and reports the blocker; the test suite does not force the state because it cannot be produced through the action.
5. **No dedicated e2e for the platform detail page.** The queue is browser-tested; the detail page and its forms are tested at the action layer.
6. **Lint warnings.** The first pass introduced three warnings from the new code: two role constants used only as types and one unused fixture in the guide/export test. All three were cleaned before the final run; the warning count returned to the baseline 193.
7. **Phase 6 export-audit gap is closed, not merely noted.** The report export now writes an audit row; the test asserts it. This is a behaviour change to an existing module and is called out here because Phase 8 was not the phase that introduced the export.
8. **Support access from an administrator-only session required a resolver change.** The first implementation used the Susu tab guard everywhere, which would have bounced a business owner who signed in through `/admin/login` to the staff login. The support pages and actions now resolve a Susu tab session first and fall back to an administrator session whose database role is admin. This is a deliberate widening for the owner persona, not for collectors or workers.

No discrepancy was found between a Phase 1–7 report and the code that Phase 8 depended on, other than the Phase 6 export-audit gap recorded above.

---

## 15. Residual risks, limitations and recommendation

### Residual risks

- **Operational discipline.** Offboarding refuses while work is live, but a business can still choose to settle or transfer badly. The audit trail makes that visible; it cannot make the decision correct.
- **Support capacity.** The queue is honest about age and first response, but a platform team that ignores it will still miss requests. The queue is a tool, not a service-level guarantee.
- **Internal-note discipline.** The database predicate prevents tenant exposure, but an agent can still paste sensitive material into a tenant-visible reply. The credential screen catches common patterns, not judgement.
- **Export scope.** Exports are metadata-only by construction; a future export that adds bodies must add its own authorisation and audit, and must not reuse the existing helper without re-reading it.
- **PostgreSQL rehearsal scope.** The fresh database proves the migration applies and matches the schema. It does not prove production data volume or lock behaviour; that remains a Phase 9/release activity.
- **Dual-session resolver.** The support surface now accepts an administrator session as well as a Susu tab session. The role is still read from the database and the tenant still comes from the context, but this is a second accepted entry point that should be covered by a session-hijack test in Phase 9.

### Limitations

- No email or push notification was added for support events; the queue and the tenant thread are the notification surface.
- No attachment upload was added; support requests are text-only. This avoids introducing file storage and malware handling without a separate security review.
- No SLA clock, agent workload balancing or on-call rotation was added. The summary exposes age and awaiting-first-response counts only.
- No tenant-facing support satisfaction survey was added.

### Recommendation

Phase 8 is complete for its stated scope, with the honest exceptions recorded above: staff onboarding is inherited rather than re-proven, platform action forms and rate-limit ceilings lack browser/ceiling tests, and the dual-session support entry point should be security-tested in Phase 9.

The work is ready to be committed on `feat/susu-enterprise-phase-8-admin-support` and handed to Phase 9 for final integration, security and release-readiness verification. No production action of any kind was taken.

---

## Appendix A — Files changed

### New

- `prisma/migrations/20270105_susu_admin_support/migration.sql`
- `src/lib/support.ts`
- `src/lib/support-access.ts`
- `src/lib/actions/susu-support.actions.ts`
- `src/lib/actions/platform-support.actions.ts`
- `src/lib/actions/susu-staff-lifecycle.actions.ts`
- `src/lib/actions/susu-admin-export.actions.ts`
- `src/lib/actions/susu-guide.actions.ts`
- `src/app/susu/support/layout.tsx`, `page.tsx`, `[id]/page.tsx`, `_components/SupportRequestForm.tsx`, `[id]/_components/SupportThread.tsx`
- `src/app/susu/admin/staff/page.tsx`, `_components/StaffLifecycleBoard.tsx`
- `src/app/susu/admin/guide/page.tsx`
- `src/app/platform/(console)/support/page.tsx`, `[id]/page.tsx`, `_components/SupportQueueTools.tsx`, `_components/SupportWorkspace.tsx`
- `tests/susu-support-tenant.test.ts`
- `tests/susu-staff-lifecycle.test.ts`
- `tests/platform-support.test.ts`
- `tests/susu-guide-and-export.test.ts`
- `e2e/maacash-support.spec.ts`

### Modified

- `prisma/schema.prisma`, `prisma/schema-pg.prisma` — additive Phase 8 models and back-relations
- `src/lib/actions/susu-reporting.actions.ts` — export audit helper and four call sites
- `src/lib/security/config.ts` — four Phase 8 rate limits
- `src/lib/security/step-up.ts` — three Phase 8 purposes
- `src/lib/admin-nav.tsx` — Staff & Access, Operational Guide, Support entries
- `src/app/platform/PlatformShell.tsx` — Support Queue entry
- `src/app/collector/(workspace)/CollectorShell.tsx` — Support menu entry
- `tests/setup.ts` — support tables cleaned before parent tables

No file was deleted. No existing route was removed or renamed.
