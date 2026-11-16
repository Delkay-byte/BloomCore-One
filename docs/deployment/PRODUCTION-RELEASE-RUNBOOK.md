# MaaCash production release runbook

Standing procedure for releasing database-plus-application changes to the MaaCash
production service, plus the record of the authentication release of 2026-11-16.

## Service facts

| Item | Value |
| --- | --- |
| Repository | `Delkay-byte/BloomCore-One` |
| Render service | `maacash` — `srv-dbnaciff3r2c7382tjgg`, `web_service`, free plan, oregon |
| Canonical origin | `https://maacash.bloomcoretech.com` (Cloudflare-proxied) |
| Render subdomain | disabled (`serviceDetails.renderSubdomainPolicy = disabled`) |
| Database | Neon PostgreSQL 18, database `neondb`, schema `public` |
| Application schema | `prisma/schema-pg.prisma` (pooled `DATABASE_URL`, direct `DIRECT_URL`) |
| Legacy service | `bik-prestige-legacy` — `srv-dbihvrmgekts73fdcbj0`, suspended |

## Standing procedure

1. **Backup.** `pg_dump -Fc` against `DIRECT_URL`, stored outside the repository with
   inheritance removed. Record size, SHA-256 and timestamp. Verify with
   `pg_restore --list`, then restore into a fresh disposable database and compare table,
   index, migration and row fingerprints.
2. **Pending migrations.** `npx prisma migrate status --schema=prisma/schema-pg.prisma`.
   Stop unless the expected migration is the only pending one.
3. **Block public traffic.** Render native Maintenance Mode is paid-only here, and
   suspension blocks deploys (`cannot deploy suspended service`) and cancels builds. Use
   the application guard instead: set `MAINTENANCE_MODE=true` and redeploy. Confirm every
   public path returns `503` while `/api/health` and `/api/health/ready` stay `200`.
   See `docs/deployment/MAINTENANCE-GUARD.md`.
4. **Block alternate origins.** Suspend `bik-prestige-legacy`; it shares the production
   database and can otherwise authenticate with old code. Keep `maacash.onrender.com`
   disabled.
5. **Migrate before deploying code.**
   `npx prisma migrate deploy --schema=prisma/schema-pg.prisma`, then `migrate status`.
6. **Verify the schema and data.** Columns, table, indexes, foreign key, migration row,
   backfill counts against the documented predicates, and unchanged password-hash,
   token-version, session, device, offline and financial fingerprints.
7. **Merge and deploy** to the existing service, with maintenance still on.
8. **Verify health and readiness**, then set `MAINTENANCE_MODE=false` and verify the
   public authentication screens.
9. **Never** run `prisma migrate reset`, `prisma db push` against production, `TRUNCATE`,
   table recreation or destructive schema rollback. Application rollback means redeploying
   the previous known-good release; the additive schema stays.

## Release record — authentication upgrade, 2026-11-16

| Stage | Evidence |
| --- | --- |
| Pre-migration backup | `maacash_prod_20261116T134516Z.dump`, 359,688 bytes, SHA-256 `3A0865F4FAA7CB402588D230D1ED0B9FEB5261F99361D64AD20CFB706C503FF2`, 457 TOC entries, 61 table-data entries, restored into an isolated `postgres:18` database with exit 0 (52 tables, 234 indexes, 29 migrations, matching `User` fingerprint) |
| Earlier backup retained | `maacash_prod_20261115T234239Z.dump`, SHA-256 `FF415CF16FBF4B32109FDC5926865DF82C929FFAD084577BE34B86FDD248C2B7` |
| Migration | `20261115_email_verification_password_policy` applied to `public` on `neondb`; `migrate status` reports up to date (30/30) |
| Backfill | Users 12/12 verified and flagged; platform admins 1/1 forced, none with a hash left unforced; portal customers 2/2 forced, none with credentials left unforced; 0 customers without portal access touched |
| Preservation | `User`, `PlatformSuperAdmin` and `Customer` fingerprints identical before and after; token-version sum 26, sessions 88, devices 8, contributions 4 (1,800.00), expenses 8, daily closing cash 27,722.20, tenants 2 — all unchanged |
| Merge | PR #44 merged as `4445a28b1d2e3320a1681e83cbc65e360b999dce` at 2026-11-16T13:49:28Z |
| Deployment | `dep-dbtgjqk9v7es73d18vr0`, commit `4445a28`, status live |
| Maintenance guard | #45 merged as `0b5f44834e15f013ffffc08562782a0abe43f618`; activated (`MAINTENANCE_MODE=true`) with every public path at 503 and health at 200, then released |
| Origin alias | `maacash.onrender.com` returns 404 |
| Legacy | `bik-prestige-legacy` suspended; returns 503 |

## Pending release — SEC-01 to SEC-16 hardening (PR #48)

Not deployed. This section records the release checks required for the hardening branch.

1. Apply the additive migration
   `20261116_security_stepup_recovery_email_remittance` with `prisma migrate deploy`.
   Before applying it, confirm:
   - No duplicate `(tenantId, idempotencyKey)` values exist in `CollectorRemittance`
     (all existing rows are expected to have NULL keys).
   - The count of legacy recovery-code hashes by subject type matches the post-migration
     `MfaRecoveryCode` count. Only 64-hex hashes are copied.
   - Unused legacy `EmailVerificationToken` rows are expected to be invalidated; users
     receive a fresh verification link.
2. Verify the schema: `StepUpGrant`, `MfaRecoveryCode`, the remittance unique index, the
   email destination column and the MFA pending-timestamp columns.
3. Confirm the production email preflight passes. The application now refuses to boot in
   production when `RESEND_API_KEY`/sender identity is missing or delivery is disabled.
   Verify `RESEND_API_KEY`, `EMAIL_FROM_SECURITY`, `SITE_URL` and `NEXTAUTH_URL` in the
   Render dashboard without printing values.
4. Smoke-test one step-up path with a synthetic staging account, not a customer:
   password confirmation -> withdrawal/correction grant -> single use.
5. Confirm Turnstile siteverify succeeds from the deployed origin (valid, expired and
   replayed token cases) if `TURNSTILE_ENABLED=true`.
6. Run the retained PostgreSQL concurrency suite against a disposable database.
7. Do not merge or deploy until the owner approves the final PR head.

### Owner actions still required

- Prisma 7 major-upgrade decision (the remaining high production advisories are the Prisma
  CLI/config chain).
- Controlled staging dynamic tests for Turnstile, trusted-proxy behaviour and the compiled
  server-action surface.
- Gitleaks full-history scan and CodeQL/Semgrep/Trivy/ZAP execution where available.
- Decide the policy and UI for financial maker-checker and second-person break-glass approval.


## Security position (record accurately)

An AI-assisted security assessment was performed before release. It is **not** an
independent human penetration test, audit or certification, and must not be described as
one. Findings SEC-01 (critical), SEC-02 and SEC-03 (high) were fixed before the migration;
the remaining medium, low and informational findings are recorded in
`docs/security/MAACASH-AI-SECURITY-ASSESSMENT.md`.

Outstanding requirement: commission an independent professional penetration test when
business revenue allows. Until then, treat the authentication surface as reviewed by
automation only.

Recommended cadence:

- Dependency and advisory monitoring continuously (`npm audit`, Dependabot).
- Monthly review of authentication and security-event logs.
- Quarterly application-security review of new authentication, tenant and financial code.
- External independent assessment before any enterprise or regulated customer onboarding.

## Operational notes

- The maintenance guard stays in the codebase permanently; it is inert unless
  `MAINTENANCE_MODE` is set. Keep it, and keep its test suite green.
- Paystack webhooks are refused while the guard is on; events are redelivered by the
  provider and the handler is idempotent on the provider event id.
- Session behaviour after this release: an account carrying a mandatory-upgrade flag is
  refused by session checks, so users complete the upgrade before regaining access.
- `bik-prestige-legacy` must not be resumed on old code. If it is ever needed, deploy the
  current release to it and configure `RESEND_API_KEY` and sender variables first.
