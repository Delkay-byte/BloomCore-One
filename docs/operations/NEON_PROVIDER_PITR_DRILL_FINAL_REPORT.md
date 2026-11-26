# Neon provider PITR drill — final status

Date: 26 November 2026. Release HELD.

## Access check (`Verified live` local environment)

- No Neon CLI was installed; `npx neonctl auth status` reported no authenticated
  session and offered browser login or an API key.
- No `NEON_*` credential environment variables or Neon config directory were
  present.
- The previously exposed Neon API key was revoked by the owner and is not
  reopened or reused.

## Result

**Provider restore drill NOT performed.** No temporary branch was created, no
historical timestamp was selected, and no production Neon branch was touched.
This is an access limitation, not a failed restore.

## Owner action (exact)

1. Authenticate the Neon CLI with an authorised account (`neon login`) or
   provide an authorised key through the secure runtime, never in chat.
2. Confirm project/branch IDs and the available PITR window from the Neon
   console; verify branch and storage allowance before creating anything.
3. Create one uniquely named temporary branch restored from the production
   parent at a timestamp inside the retained window.
4. Verify read-only: PostgreSQL version, migration status, aggregate table and
   row counts, key constraints, tenant links and audit integrity. Do not run
   migrations, seeds or application writes against it.
5. Disconnect sessions, delete only the temporary branch, confirm the production
   endpoint is unchanged.
6. Record duration, recovery point and any data-loss window.

The local `pg_dump`/`pg_restore` drill passed earlier; it does not prove Neon
provider restore.
