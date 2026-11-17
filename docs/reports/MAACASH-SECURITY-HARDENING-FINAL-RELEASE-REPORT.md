# MaaCash Security Hardening — Final Release Report

**Release:** PR #48 — `security/comprehensive-hardening-sec-01-to-sec-16`
**Merge commit:** `dd13058` (2026-11-17T17:27:35Z)
**Production:** https://maacash.bloomcoretech.com — Render `srv-dbnaciff3r2c7382tjgg`
**Staging:** https://maacash-staging.onrender.com — Render `srv-dbto0188v5cc73ar4d30`
**Final CI head:** `b810470` (push run `44134003457`, pull-request run `44134021252` — all five jobs green)
**Database:** Neon PostgreSQL 18.7, `/neondb` on `ep-lively-mode-b4jimg0y`

---

## 1. Release outcome

The P0 login failure is fixed and verified in production. The complete SEC-01 → SEC-16 set and
residual risks A–F are closed at the code and runtime level; G–I remain documented environment
limitations. The release was deployed through a controlled maintenance window with a verified
database backup, an additive migration, a green CI gate, and live post-deploy acceptance.

No production customer record, password, MFA factor, balance, device enrolment or financial
entry was created, changed or deleted. No real MoMo or Paystack charge was initiated.

---

## 2. The 20 required items

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | **P0 Turnstile login failure** | **Fixed** | Production served sitekey `0x4AAAAAAFvt9wHpwkG5A_eF` (widget "Bloomcore One Webpage") while the server held the secret for widget `0x4AAAAAAGEI6B_FX_oEmRex` ("Maacash Production"). The Render variable `NEXT_PUBLIC_TURNSTILE_SITE_KEY` was corrected to the matching sitekey; the deployed bundle now serves `0x4AAAAAAGEI6B_FX_oEmRex` and the server secret is unchanged. |
| 2 | **Turnstile fails closed** | **Verified live** | A submission with no token returns the generic "Security verification failed" and creates no session. A real browser obtained a 773-character token; the server replied "Security check complete" and rejected only the bogus credentials. One token → one Siteverify call; the client requests a fresh challenge after a failure. |
| 3 | **SEC-01 server-action surface** | Closed | Session minting stays outside `"use server"`; no exported action accepts a subject ID. Regression: `tests/security-actions.test.ts`. |
| 4 | **SEC-02 tenant and session integrity** | Closed | `isSessionCurrent`, `getTenantContext`, `requirePlatformAdmin` reject persisted upgrade flags on every module. |
| 5 | **SEC-03 offline allocation concurrency** | Closed with runtime proof | `lockAccountForUpdate` inside the transaction; two devices cannot over-allocate. `tests/pg-offline-idempotency.test.ts`. |
| 6 | **SEC-04 step-up grants** | Closed | Hash-only, subject/session/purpose/target/context bound, five-minute, single-use; new PostgreSQL proof `tests/pg-step-up.test.ts`. |
| 7 | **SEC-05 client IP trust** | Closed, residual documented | `CF-Connecting-IP` authoritative; `True-Client-IP` only by explicit opt-in. |
| 8 | **SEC-06 remittance idempotency** | Closed | `(tenantId, idempotencyKey)` unique plus request hash; replay returns the original result. |
| 9 | **SEC-07 MFA recovery codes** | Closed with runtime proof | One conditional `updateMany` per code; concurrent claims yield exactly one success. `tests/pg-mfa-recovery.test.ts`. |
| 10 | **SEC-08 workspace selection** | Closed | Selection payload carries server-derived `amr`; platform password change re-issues the current verified `amr`. `tests/workspace-switch.test.ts`. |
| 11 | **SEC-09 static path allowlist** | Closed | Only approved asset directories and root files are public; nested protected paths with `.json/.pdf/.css` are refused. |
| 12 | **SEC-10 public health surface** | Closed | Health responses stay minimal; readiness checks the database without leaking details. |
| 13 | **SEC-11 Turnstile verification** | Closed with live proof | Siteverify validates success, action, hostname, challenge age and replay; the production preflight refuses to boot when Turnstile is enabled without keys or allowed hostnames. |
| 14 | **SEC-12 secret hygiene** | Closed | Broad `.env*`/secret ignores; CI secret-scan job runs Gitleaks over full reachable history and passes. |
| 15 | **SEC-13 dependencies and Prisma 7** | Closed | Prisma 7.10.1 with driver adapters; `npm audit` **0 high, 0 critical**; `--omit=dev` **0**; 10 moderate remain in dev-only tooling. No `npm audit fix --force`. |
| 16 | **SEC-14 email-token binding** | Closed | `destinationEmailHash` binds verification links; legacy unbound tokens are invalidated. |
| 17 | **SEC-15 MFA enrolment limits** | Closed | Durable per-subject limits, 15-minute pending-secret reuse, explicit restart, audited disable with password + current code. |
| 18 | **SEC-16 transactional email** | Closed (preflight + reliability) | Production boot fails when delivery is disabled or the sender/key is missing; delivery failures are audited, retryable and never leave a dead token blocking resend. A durable cross-process outbox remains an infrastructure improvement. |
| 19 | **Residual C — retention and alerting** | Closed in code | `SecurityEventRecord` + `SecurityAlert`, 365-day pruning that never touches `AuditLog`/`PlatformAuditLog`, and an alert queue on the admin and platform dashboards. |
| 20 | **Residual D — break-glass administrator** | Closed in code | Platform MFA reset requires step-up, a written reason, a second platform administrator where one exists, and otherwise a critical alert plus an audited single-administrator exception. |

### Residual risks E–I

| Item | Disposition |
|---|---|
| E. Financial maker-checker | Closed. Withdrawals at/above the configured threshold and every reversal need a different administrator's approval, consumed atomically once. Single-administrator tenants post only through an audited exception. Queue at `/susu/admin/approvals`; PostgreSQL proof `tests/pg-dual-control.test.ts`. |
| F. First MFA enrolment | Closed. Requires a verified channel (verified user e-mail, active platform account) before enrolment starts and before confirmation. |
| G. Offline device protection | Unchanged; existing AES-GCM/PBKDF2 and lock behaviour preserved. The expanded tamper matrix was not added in this pass. |
| H. Service-worker dependency | Fail-closed tab proof unchanged; the 15 mobile browser tests (offline shell, reconnection, dual-role switch) pass. |
| I. Dynamic testing | Not performed as a paid/manual pentest. Automated gates: `npm audit` (0 high/critical), 944 SQLite tests, 44 PostgreSQL tests, 15 mobile browser tests, CodeQL, Gitleaks. ZAP/Semgrep/Trivy and an independent pentest remain owner actions — no human pentest is claimed. |

---

## 3. Prisma 7 migration (SEC-13)

| Area | Change |
|---|---|
| Schemas | `datasource.url`/`directUrl` removed from `prisma/schema.prisma` and `prisma/schema-pg.prisma` (Prisma 7 forbids them) |
| CLI configuration | `prisma.config.ts` (SQLite default) and `prisma.pg.config.ts` (PostgreSQL, unpooled `DIRECT_URL`) |
| Runtime | `src/lib/prisma-client.ts` selects `PrismaBetterSqlite3` for `file:` and `PrismaPg` for PostgreSQL; `src/lib/db.ts` is a singleton over that factory |
| Build | `next.config.ts` keeps native drivers external and drops the Node-only maintenance module from the edge compilation; `src/instrumentation-node.ts` now owns the boot preflight and the background sweep |
| Scripts | All operator/seed/migration scripts use the shared factory; `ensure-columns` converted to ESM; Prisma 7 removed `db push --skip-generate`, handled everywhere |

Migration evidence: all **32** migrations applied to a disposable PostgreSQL 16 container; `migrate diff` reported "No difference detected"; the PostgreSQL suite passed; the production build and the built server booted and ran a sweep with the Prisma 7 adapters.

---

## 4. Staging rehearsal

| Step | Result |
|---|---|
| Database isolation | Staging Neon host `ep-hidden-bread-b4z5w9cz` is distinct from production `ep-lively-mode-b4jimg0y`; row scan before reset showed 53 tables and **zero** rows |
| Schema reset + migration | Public schema recreated; all 32 migrations applied; `migrate status` clean |
| Synthetic seed | `STG-A`/`STG-B` tenants, 10 synthetic accounts, 12 customers, 18 contributions, 4 withdrawals, 2 remittances, 4 daily accounts, Zeli availability enabled. Zero non-fixture e-mail addresses |
| Runtime | Deployed `b810470`; health 200; both a synthetic administrator and the platform operator authenticate successfully (redirected to the forced password-upgrade screen, as seeded) |
| Configuration added | Staging e-mail senders, canonical URL, `RATE_LIMIT_HMAC_SECRET`, `MFA_ENCRYPTION_KEY`, `TRUSTED_PROXY_HEADERS`, `MFA_ENFORCEMENT=optional` |

Staging Turnstile remains disabled because the "Maacash Staging" widget only lists
`staging-maacash.bloomcoretech.com`, which does not resolve, and the available Cloudflare token
cannot edit Turnstile widgets or DNS. **Owner action:** add `maacash-staging.onrender.com` to the
staging widget (or create the missing DNS record), then set
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`/`TURNSTILE_ENABLED=true` on staging. Production is unaffected and
remains enabled and verified.

---

## 5. Release gates

| Gate | Result |
|---|---|
| TypeScript | `tsc --noEmit` clean |
| ESLint | 0 errors (77 warnings, unchanged categories) |
| SQLite suite | 87 files / 944 tests passed |
| PostgreSQL suite | 10 files / 44 tests passed (local Docker and CI) |
| Mobile browser suite | 15 tests passed (local and CI) |
| Production build | `next build --webpack` succeeded; server booted and completed a background sweep |
| Dependency audit | 0 high, 0 critical; 10 moderate in dev tooling only |
| Secret scan | Gitleaks full reachable history — clean |
| CodeQL | Green on the final head |
| Schema drift | `migrate diff` empty against production after the migration |

Earlier intermittent CI failures (`maacash-improvements`, `zeli-billing-lifecycle`,
`pg-financial-corrections`) were re-run repeatedly on the final branch and did not reproduce; the
PostgreSQL file failures were traced to the test harness not pointing the application client at
`PG_DATABASE_URL` and were fixed rather than skipped.

---

## 6. Backup, migration and deployment

| Step | Evidence |
|---|---|
| Pre-migration backup | `pg_dump --schema=public --format=custom` → `maacash-prod-premig-20261117T172111Z.dump` (sha256 prefix `5981f0d48a1d0f309574b030`), 53 tables, `pg_restore --list` clean |
| Restore verification | Restored into a disposable PostgreSQL 18 instance; all 53 tables recreated and **0 row-count mismatches** against production; `neon_auth` metadata attributes (`pg_attver`) excluded as provider-internal |
| Maintenance window | `MAINTENANCE_MODE=true`; login returned 503 with the maintenance page while `/api/health` stayed 200 for Render |
| Migration | `prisma migrate deploy --config prisma.pg.config.ts` applied `20261117_security_retention_alerting_dual_control` (additive: 4 tables, 16 indexes, no `ALTER`/`DROP`); `migrate status` up to date; `migrate diff` empty |
| Data integrity | Before and after: Users 12, Customers 4, Contributions 4, Withdrawals 0, AuditLog 194, tenants 2 — identical |
| Merge | PR #48 merged as `dd13058` at 2026-11-17T17:27:35Z |
| Deployment | `dep-dbu8t2c9v7es73djef70` live; boot clean, preflight passed |
| Reopen | `MAINTENANCE_MODE=false`; `dep-dbu8urgm7kps73bborc0` live; login 200, health 200, readiness 200 |

---

## 7. Live production acceptance

| Check | Result |
|---|---|
| Login page | HTTP 200 in ~1.1 s; Turnstile script loads; `window.turnstile` present; widget state `ready` |
| Sitekey/secret match | Deployed chunk serves `0x4AAAAAAGEI6B_FX_oEmRex`, the widget whose secret production holds |
| Token issuance | Real headed browser obtained a 773-character token |
| Server verification | "Security check complete" + "Invalid credentials" for a deliberate bogus account — Turnstile passed, credentials correctly rejected |
| Fail-closed | Submission without a token → "Security verification failed", no session |
| Protected routes | `/admin/dashboard`, `/susu/admin/approvals`, `/settings` → 307 to login; `/platform/dashboard` → 307 to platform login |
| Headers | CSP with per-request nonce, HSTS preload, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `nosniff` |
| Background sweep | Runs on boot with the Prisma 7 adapter; no schema errors in production logs |
| Data | No customer, password, MFA, balance or financial record changed |

---

## 8. Known limitations and owner actions

1. **Staging Turnstile hostname** — add `maacash-staging.onrender.com` to the Cloudflare staging widget (or create `staging-maacash.bloomcoretech.com` DNS) before enabling Turnstile on staging.
2. **Two platform administrators** — the break-glass control prefers a second approver; keep at least two enrolled platform super-admins.
3. **Durable e-mail outbox** — SEC-16 currently relies on audited, retryable delivery plus account resend; a cross-process outbox would remove the remaining dependency on provider availability.
4. **Dynamic security testing** — ZAP/Semgrep/Trivy and an independent penetration test are still recommended; none was performed or claimed.
5. **PR #49 (pricing/enquiries)** — kept out of this release; it was based on `d6d1577` and must be rebased onto `dd13058` before review.

---

## 9. Constraints honoured

- Turnstile stayed enabled and fail-closed; no bypass, no fail-open, no secret rotation that would mask the mismatch.
- No password, Turnstile token, MFA code, API key or raw personal identifier is recorded in this report, the repository or application logs.
- No production customer data was read into staging or into any test; staging holds synthetic fixtures only.
- No new paid service, hosting upgrade or unapproved security tool was introduced.
- `npm audit fix --force` was never used; the remaining moderate advisories are dev-only and a production `npm audit --omit=dev` is clean.
- No failing test was deleted, skipped or weakened; the one harness timeout change raises a budget without touching its assertions.
- No real mobile-money or card charge was initiated.
