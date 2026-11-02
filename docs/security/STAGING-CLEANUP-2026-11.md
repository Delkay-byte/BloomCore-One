# Staging Cleanup Report — Authenticated Assessment 2026-11

**Date:** 2 November 2026
**Environment:** local production-mode staging `bloomcore-one-pentest`
**Candidate:** `security/authenticated-pentest-2026-11` (base `a71cb1c`)

## Completed

| Item | Action | Result |
|---|---|---|
| Staging application server | Stopped after evidence capture | Stopped |
| Isolated PostgreSQL database `bloomcore_staging` | `DROP DATABASE` in the dedicated Docker container | Dropped |
| Staging PostgreSQL container `bloomcore-pg-test` | Removed | Removed |
| External account/TOTP file | Deleted from the temporary directory | Deleted |
| Local Prisma client | Regenerated from `prisma/schema.prisma` (SQLite dev schema) | Restored |
| Temporary test scripts that minted sessions | Removed; only the synthetic seed remains | Removed |
| Production | No access, deployment, migration or data change | Unchanged |

## Data destroyed

- Tenant A/B synthetic records, users, customers, accounts, cycles, contribution,
  devices and MFA secrets.
- The generated test password and recovery-code list.

## Data retained

- Test procedures and seed source: `scripts/pentest/seed-staging.ts`.
- Sanitized evidence: ZAP HTML/JSON reports, manual probe results and this
  report set. No token, cookie, TOTP secret or password is stored in them.
- Automated regression tests and fixes on the security branch.

## Verification

- `docker ps` shows no staging container.
- The temporary account file no longer exists.
- `git status` contains only intended documentation and seed files.
- No production URL was scanned with active attacks.

## Remaining environment work

A hosted staging service (`bloomcore-one-pentest`) with a separate Neon/PostgreSQL
branch has **not** been provisioned, because no paid service or staging
credentials were approved. The exact steps, required secrets and account roles
are in `PENTEST-READINESS.md` and `STAGING-PENTEST-2026-11.md`.
