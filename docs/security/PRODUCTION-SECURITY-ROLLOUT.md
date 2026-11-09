# Production Security Rollout

**Do not deploy until the owner has reviewed this branch.** No production
migration was run and no production service was changed during implementation.

## 1. Pre-flight (local / CI)

```powershell
cd "Momo module"
npm ci
npx prisma generate
npx prisma db push --skip-generate   # SQLite test schema
npm run typecheck
npm run lint
npm test
npm run build
```

All four commands must pass before proposing the merge. See
`SECURITY-TEST-RESULTS.md` for the recorded results.

## 2. New environment variables

Generate secrets on Windows PowerShell:

```powershell
# 32 random bytes, base64 — RATE_LIMIT_HMAC_SECRET
$b = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
[Convert]::ToBase64String($b)

# 32 random bytes, base64 — MFA_ENCRYPTION_KEY (separate value!)
$b2 = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b2)
[Convert]::ToBase64String($b2)
```

Add to Render → `bloomcore-one` → Environment:

| Variable | Required | Value |
|---|---|---|
| `RATE_LIMIT_HMAC_SECRET` | Yes | output of the first command |
| `MFA_ENCRYPTION_KEY` | Yes | output of the second command (must be 32 bytes) |
| `MFA_ENFORCEMENT` | Yes | `optional` first |
| `TURNSTILE_ENABLED` | Yes | `false` first |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | When enabling Turnstile | Cloudflare site key |
| `TURNSTILE_SECRET_KEY` | When enabling Turnstile | Cloudflare secret key |
| `TURNSTILE_ALLOWED_HOSTNAMES` | When enabling Turnstile | `maacash.bloomcoretech.com,maacash.onrender.com,bloomcore-one.onrender.com` during the domain transition |
| `TRUSTED_PROXY_HEADERS` | Yes | `true` |

Do **not** reuse `JWT_SECRET` for either new secret. Do not commit values. The
owner must obtain the Turnstile pair from Cloudflare; they cannot be generated
here.

If `RATE_LIMIT_HMAC_SECRET` is missing in production, authentication fails
closed with a configuration error. Add it before deploying.

## 3. Database migration (Neon)

The migration is additive:

`prisma/migrations/20261101_security_hardening/migration.sql`

Rehearse on an isolated PostgreSQL database first:

```bash
# isolated branch/database, never production
export DATABASE_URL="postgresql://...:...@ep-...-pooler.../bloomcore_rehearsal?sslmode=require"
export DIRECT_URL="postgresql://...:...@ep-...... /bloomcore_rehearsal?sslmode=require"
npx prisma migrate deploy --schema=prisma/schema-pg.prisma
```

Then verify:

1. `SELECT count(*) FROM "User";` is unchanged.
2. `SELECT count(*) FROM "Contribution";` etc. are unchanged.
3. New tables exist and are empty:
   `RateLimitCounter`, `AuthThrottle`, `TurnstileTokenUse`, `SessionRecord`.
4. `User.mfaEnabled` defaults to `false` for every row.
5. Start the application against the rehearsal database and log in with a test
   account.

Apply to production only during an approved change window:

```bash
npx prisma migrate deploy --schema=prisma/schema-pg.prisma
```

Do not use `prisma migrate dev` or `db push` against production.

Rollback / forward recovery:

- The migration only adds tables and nullable/defaulted columns, so the previous
  application version keeps working if the deploy is rolled back.
- Dropping `SessionRecord` logs every user out (server-side sessions vanish).
  Dropping the rate-limit tables resets counters. Neither touches business data.
- If a later forward fix is needed, add a new migration; never edit an applied
  migration.

## 4. Deployment sequence

1. Merge only after owner approval.
2. Confirm all new secrets exist in Render.
3. Run the production migration during the change window.
4. Deploy the security branch build (Render auto-deploys `main`; the owner
   decides when to merge).
5. Verify:
   - `/api/health` returns 200;
   - `/api/health/ready` returns 200 with `database: "ok"`;
   - an administrator can sign in;
   - a worker/collector can sign in;
   - a customer can sign in;
   - a wrong password shows a generic error and increments the throttle;
   - logging out and reusing the old cookie fails (registry revocation);
   - `/admin/security/mfa` shows the enrolment card;
   - platform `/platform/security/mfa` loads.
6. Enrol MFA for the platform operator and each tenant administrator.
7. Only then set `MFA_ENFORCEMENT=enforce`.
8. Configure Turnstile per `CLOUDFLARE-TURNSTILE-SETUP.md`; keys first, then
   `TURNSTILE_ENABLED=true`.

## 5. Post-deploy checks

- Render logs show `security_event` JSON lines for logins and throttles.
- No password, token, cookie or MFA secret appears in logs.
- One failed-login series produces a 1-minute refusal after five failures.
- An authenticated administrator can still complete normal business operations.
- Offline sync still works for an enrolled device.

## 6. Rollback

1. Redeploy the previous build (Render → Deploys → previous deploy).
2. Set `TURNSTILE_ENABLED=false` if Turnstile is implicated.
3. Set `MFA_ENFORCEMENT=optional` if MFA enrolment blocks an account.
4. Do not drop the security tables during an incident; they are additive and
   harmless to the old build.
5. Rotate `JWT_SECRET` only with a documented plan: it signs every session and
   invalidates all users at once.

## 7. Outstanding owner decisions

- Email delivery provider for password resets (blocking self-service recovery).
- Whether to adopt Argon2id (requires backward-compatible rehash on login).
- Financial approval thresholds and reversal policy.
- Formal log retention period and SIEM forwarding.
- Independent penetration test before handling higher-value production data.

---

# Release record — 2 November 2026

## Owner-configured secrets (verified present, values not read into logs)

| Variable | Observation |
|---|---|
| `RATE_LIMIT_HMAC_SECRET` | present, 44 characters (base64 32 bytes) |
| `MFA_ENCRYPTION_KEY` | present, 44 characters (base64 32 bytes) |
| `TURNSTILE_ENABLED` | `true` |
| `TURNSTILE_ALLOWED_HOSTNAMES` | `maacash.bloomcoretech.com,maacash.onrender.com,bloomcore-one.onrender.com` |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | present, 24 characters |
| `TURNSTILE_SECRET_KEY` | present, 35 characters |
| `TRUSTED_PROXY_HEADERS` | `true` |
| `JWT_SECRET` | present, unchanged |
| `DATABASE_URL` / `DIRECT_URL` | present, Neon `neondb` (pooled/direct) |

These were already configured by the owner and were not regenerated or
overwritten.

## Production backup

- Timestamp: `2026-11-02T00:11:24Z`.
- Source database: Neon `neondb` (the database behind `bloomcore-one`).
- Method: logical NDJSON per table, gzip, 22 tables, 19 rows total.
- Manifest with per-table counts and SHA-free row verification stored outside
  the repository at
  `%LOCALAPPDATA%\Temp\opencode\backups\bloomcore-20261102T001124Z` (not
  committed; contains production personal data).
- Verification: every table count matched the source at backup time and again
  after restore into the isolated rehearsal database.

## Isolated rehearsal

- PostgreSQL database: `bloomcore_rehearsal_20261102` on the same Neon project
  (separate database, not production).
- Restored the verified backup into it.
- Applied every migration with
  `npx prisma migrate deploy --schema=prisma/schema-pg.prisma`.
- Verified 1 tenant, 1 user, 1 platform operator, 5 tenant audit rows and 11
  platform audit rows remained; security tables were added and empty.
- PostgreSQL concurrency tests passed; see `SECURITY-TEST-RESULTS.md`.

## Migrations added in phase 2

1. `20261102_admin_recovery_and_customer_mfa`
2. `20261102_financial_reversals`

Both additive. No row is rewritten or deleted.

## Production migration / deployment

- Production migration applied: `2026-11-02T00:44Z` (approximately).
  Prisma reported all migrations applied, including:
  `20261101_security_hardening`, `20261102_admin_recovery_and_customer_mfa`,
  `20261102_financial_reversals`.
- Data verification after migration: 1 tenant, 1 user, 1 platform operator,
  5 tenant audit rows, 11 platform audit rows. No rows lost or rewritten.
- New tables confirmed: `RateLimitCounter`, `AuthThrottle`,
  `TurnstileTokenUse`, `SessionRecord`, `AccountRecoveryRequest`.
- New columns confirmed: `User.mfaEnabled`, `PlatformSuperAdmin.mfaEnabled`,
  `Customer.mfaEnabled`, `Contribution.reversalOfId`,
  `Withdrawal.reversalOfId`.
- First deploy (`db50104`) failed at TypeScript because the PostgreSQL Prisma
  schema lacked the MFA fields. Fixed in `c7df779` (schema only; the database
  migration already had the columns).
- Live deploy after the build fix: `dep-dbju02m417fc73bc1otg` at `c7df779`.
- CSP fix `9ddeefd` deployed as `dep-dbju7fh42hec73e33if0`.
- Final release record and documentation deploy: `ef22c5c`
  (`dep-dbju93nb9u1s73c5jebg`).
- `MFA_ENFORCEMENT` set to `enforce` and the service redeployed.
- Health: 200. Readiness: 200, database ok.
- Turnstile: widget rendered with the production key; a real token was verified
  server-side and consumed exactly once.
- CSP: Google Fonts and the Turnstile connection probe allow-listed; no
  remaining top-level CSP errors. `'unsafe-inline'` remains.
