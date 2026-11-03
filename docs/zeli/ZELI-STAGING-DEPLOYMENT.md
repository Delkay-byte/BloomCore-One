# Zeli — Staging Deployment

**Status:** prepared; **not deployed**. No paid infrastructure was created.

## Required owner actions

1. Approve staging spend.
2. Create a dedicated Neon database `bloomcore_one_staging` (check availability).
3. Create a Render web service `bloomcore-one-staging` from `render.staging.yaml`
   (check availability). Keep `autoDeploy: false`.
4. Generate staging-only secrets:
   - `JWT_SECRET`
   - `RATE_LIMIT_HMAC_SECRET`
   - `MFA_ENCRYPTION_KEY`
5. Create a separate Cloudflare Turnstile staging site and secret.
6. Set `DATABASE_URL`/`DIRECT_URL` to the staging Neon database only.
7. Run migrations:
   ```bash
   DATABASE_URL=<staging> DIRECT_URL=<staging-direct> \
     npx prisma migrate deploy --schema prisma/schema-pg.prisma
   ```
8. Seed synthetic tenants:
   ```bash
   APP_ENV=STAGING STAGING_SEED_CONFIRM=YES DATABASE_URL=<staging> \
     npx tsx scripts/staging/seed-staging.ts
   ```
9. Deliver generated credentials out of band. Never commit or email them in
   plaintext to a group.
10. Configure Paystack **test** keys only if checkout testing is approved.
11. Keep DeepSeek disabled. For a synthetic window:
    - set `ZELI_SYNTHETIC_TESTING_ALLOWED=true`;
    - set a staging-only key;
    - enable synthetic mode from `/platform/zeli`;
    - run the probe;
    - emergency-disable immediately after the test.
12. Delete or rotate all staging credentials when testing ends.

## Seed contents

`scripts/staging/seed-staging.ts` creates:

- Tenant A and Tenant B (`STG-A`, `STG-B`);
- owner/admin, worker, agent (worker + MoMo), collector and customer per tenant;
- a platform Super Admin;
- forced password reset for every account;
- no prices, no payment transactions, no production data.

## Environment parity

| Control | Staging |
|---|---|
| MFA | enforced |
| Rate limiting | enabled with staging secret |
| Turnstile | staging keys |
| Session revocation | same code |
| CSP | same code |
| Tenant isolation | same code |
| Payment webhook | test keys + signature |
| Zeli entitlement | same code |
| External AI | disabled by default |

## Not verified here

- No Render/Neon service was created.
- No staging hostname resolves.
- Turnstile staging keys were not issued.
- No migration was run against staging.
- No synthetic credentials were delivered.

Do not describe staging as live until the owner completes and verifies these
steps.
