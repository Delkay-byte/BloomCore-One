# Production environment configuration — MaaCash

Owner: BLOOMCORE TECHNOLOGIES, registration BN428031125.
Audited: 25 November 2026. Contains no secret values.

## 1. Verified deployment identity

| Item | Verified value |
| --- | --- |
| Render service | `maacash` — `srv-dbnaciff3r2c7382tjgg` |
| Live service branch | `main` |
| Live auto-deploy | **enabled** (a push to `main` triggers one deployment) |
| Blueprint `autoDeploy` | `true`; matches the live service, so one push to `main` deploys once |
| Plan / instances / region | `free` / 1 / `oregon` |
| Public origin | `https://maacash.bloomcoretech.com` |
| Transitional host | `https://maacash.onrender.com` (offline-sync compatibility only) |
| Build | `npm ci --include=dev && npx prisma generate --schema=prisma/schema-pg.prisma && npm run build` |
| Start | `npm start` |
| Health check | `/api/health` — returned HTTP 200 during the audit |
| Database | Neon PostgreSQL, `neondb`, us-east-2; pooled `DATABASE_URL` and unpooled `DIRECT_URL` |

The free plan and single instance are pilot constraints, not a 1,000-user capacity claim.

## 2. Render environment state (names and presence only)

The live service has 52 variables. Values were never printed. The following were
present before this audit: `NODE_ENV`, `APP_ENV`, `DATABASE_URL`, `DIRECT_URL`,
`JWT_SECRET`, `RATE_LIMIT_HMAC_SECRET`, `MFA_ENCRYPTION_KEY`, `MFA_ENFORCEMENT`,
`TURNSTILE_ENABLED`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY`,
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_ALLOWED_HOSTNAMES`,
`TRUSTED_PROXY_HEADERS`, `NEXTAUTH_URL`, `SITE_URL`, `NEXT_PUBLIC_SITE_URL`,
`SESSION_IDLE_TIMEOUT_SECONDS`, `SESSION_BACKGROUND_TIMEOUT_SECONDS`,
`SESSION_ABSOLUTE_TIMEOUT_SECONDS`, `MAINTENANCE_MODE`, `CONTACT_EMAIL`,
`CONTACT_PHONE`, `FRONTEND_URL`, `RESEND_API_KEY`, `EMAIL_FROM`,
`EMAIL_FROM_HELLO`, `EMAIL_FROM_NOREPLY`, `EMAIL_FROM_NOTIFICATIONS`,
`EMAIL_FROM_SUPPORT` and `EMAIL_FROM_SECURITY`. Sender resolution prefers
`EMAIL_FROM_SECURITY`, then `EMAIL_FROM_NOREPLY`, then `EMAIL_FROM`.

Added through the Render managed environment API during this audit, without
deploying: `RISK_INTELLIGENCE_SALT`, `RISK_RETENTION_TOKEN` (each 32 random bytes
as 64 lowercase hex characters, generated in memory), `BLOOMCORE_REGISTERED_ADDRESS`,
`BLOOMCORE_AUTHORISED_SIGNATORY_NAME`, `BLOOMCORE_AUTHORISED_SIGNATORY_CAPACITY`,
`BLOOMCORE_PRIVACY_EMAIL`, `RISK_HOSTING_PROVIDERS`, `RISK_HOSTING_REGIONS`,
`MAACASH_APP_URL`. Render API environment changes do not deploy automatically.

## 3. Production-critical variables

| Variable | Purpose | Required | Env | Source | Format / example | Secret | Dependency | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | runtime mode | yes | prod | platform | `production` | no | all | boot preflight |
| `DATABASE_URL` | pooled database | yes | prod/scheduler | Neon dashboard | `postgresql://…` | yes | Prisma runtime | health check |
| `DIRECT_URL` | unpooled schema DB | yes | prod | Neon dashboard | `postgresql://…` | yes | migrations | `prisma migrate status` |
| `JWT_SECRET` | session signing | yes | prod | generated | ≥32 random bytes | yes | auth | login |
| `RATE_LIMIT_HMAC_SECRET` | rate-limit keys | yes | prod | generated | ≥32 random bytes | yes | abuse protection | 429 test |
| `MFA_ENCRYPTION_KEY` | TOTP encryption | yes | prod | generated | base64 32 bytes | yes | MFA | admin login |
| `MFA_ENFORCEMENT` | MFA policy | yes | prod | owner | `enforce` | no | admin auth | admin login |
| `TURNSTILE_ENABLED` | CAPTCHA gate | yes | prod | Cloudflare | `true` | no | public forms | enquiry form |
| `TURNSTILE_SECRET_KEY` | CAPTCHA verify | yes | prod | Cloudflare | provider value | yes | public forms | enquiry form |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | CAPTCHA widget | yes | prod/build | Cloudflare | provider value | no | public forms | widget renders |
| `TURNSTILE_ALLOWED_HOSTNAMES` | origin allowlist | yes | prod | owner | `maacash.bloomcoretech.com` | no | CAPTCHA | widget verifies |
| `TRUSTED_PROXY_HEADERS` | proxy IP trust | yes | prod | platform | `true` | no | rate limits | IP logging |
| `SITE_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXTAUTH_URL`, `MAACASH_APP_URL` | canonical origins | yes | prod/scheduler | owner | `https://maacash.bloomcoretech.com` | no | links, cron | reset link origin |
| `SESSION_IDLE_TIMEOUT_SECONDS` | idle lock | yes | prod | owner | `900` | no | sessions | timeout test |
| `SESSION_BACKGROUND_TIMEOUT_SECONDS` | background lock | yes | prod | owner | `300` | no | sessions | timeout test |
| `SESSION_ABSOLUTE_TIMEOUT_SECONDS` | absolute lock | yes | prod | owner | `28800` | no | sessions | timeout test |
| `RESEND_API_KEY` | email provider | yes | prod | Resend | `re_…` | yes | reset notices | Resend API |
| `EMAIL_FROM` / `EMAIL_FROM_SECURITY` | verified sender | yes | prod | Resend verified domain | `Name <security@domain>` | no | reset notices | provider acceptance |
| `EMAIL_DELIVERY` | kill switch | no | prod | owner | unset or `enabled` | no | email | boot preflight |
| `RISK_INTELLIGENCE_SALT` | subject HMAC key v1 | conditional | prod | generated | 64 hex chars | yes | risk register | `risk-live-readiness` |
| `RISK_INTELLIGENCE_KEY_V${n}` | versioned key | conditional | prod | generated on rotation | ≥24 chars | yes | key rotation | rotation test |
| `RISK_INTELLIGENCE_ACTIVE_KEY_VERSION` | active version | conditional | prod | owner | `1` | no | key rotation | key metadata |
| `RISK_INTELLIGENCE_SUPPORTED_VERSIONS` | matchable versions | conditional | prod | owner | `1,2` | no | key rotation | dual-key test |
| `RISK_RETENTION_TOKEN` | retention bearer token | conditional | prod/scheduler | generated | 64 hex chars | yes | daily sweep | one authenticated run |
| `BLOOMCORE_PRIVACY_EMAIL` | public contact | yes | prod | owner | `bloomcoretechnologies@gmail.com` | no | privacy page | page render |
| `BLOOMCORE_AUTHORISED_SIGNATORY_NAME` | agreement signatory | conditional | prod | owner | `Saviour Amegayie` | no | agreements | countersignature |
| `BLOOMCORE_AUTHORISED_SIGNATORY_CAPACITY` | signatory capacity | conditional | prod | owner | `Proprietor` | no | agreements | countersignature |
| `BLOOMCORE_REGISTERED_ADDRESS` | registered office | conditional | prod | owner record | `Hse # L7, Olive St., Akast Rd., Akatsi Volta Region, GHANA` | no | agreements | instrument render |
| `RISK_HOSTING_PROVIDERS` / `RISK_HOSTING_REGIONS` | published sub-processors | conditional | prod | verified infra | `Render` / `Oregon, United States` | no | public addendum | addendum render |

## 4. Full consumed-variable inventory

Every name below is read by code. `S` marks a secret. Values are never stored in Git.

| Area | Variables |
| --- | --- |
| Runtime | `NODE_ENV`, `NEXT_RUNTIME`, `APP_ENV`, `RENDER`, `RENDER_SERVICE_ID`, `RENDER_EXTERNAL_HOSTNAME`, `CI`, `VITEST`, `GIT_COMMIT`, `RENDER_GIT_COMMIT`, `VERCEL_GIT_COMMIT_SHA`, `SOURCE_VERSION`, `MAINTENANCE_MODE` |
| Database | `DATABASE_URL` S, `DIRECT_URL` S, `PRISMA_CLI_DATABASE_URL` S, `PG_DATABASE_URL` S, `PG_ADMIN_URL` S, `PGPASSWORD` S, `PSQL_BIN`, `SOURCE_DATABASE_URL` S, `MAACASH_VERIFY_MIGRATIONS_PATH`, `EVIDENCE_STORAGE_DIR` |
| Auth/session | `JWT_SECRET` S, `RATE_LIMIT_HMAC_SECRET` S, `MFA_ENCRYPTION_KEY` S, `MFA_ENFORCEMENT`, `SESSION_IDLE_TIMEOUT_SECONDS`, `SESSION_BACKGROUND_TIMEOUT_SECONDS`, `SESSION_ABSOLUTE_TIMEOUT_SECONDS`, `ALLOW_LEGACY_COOKIE_SESSIONS`, `ALLOWED_ORIGINS`, `TRUSTED_PROXY_HEADERS`, `TRUST_TRUE_CLIENT_IP`, `SECURITY_EVENT_PERSIST` |
| Turnstile/OIDC | `TURNSTILE_ENABLED`, `TURNSTILE_SECRET_KEY` S, `TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_ALLOWED_HOSTNAMES`, `TURNSTILE_VERIFY_URL`, `PLATFORM_OIDC_ENABLED`, `PLATFORM_OIDC_ISSUER`, `PLATFORM_OIDC_CLIENT_ID`, `PLATFORM_OIDC_CLIENT_SECRET` S, `PLATFORM_OIDC_CC_BASE`, `PLATFORM_OIDC_CC_API_KEY` S, `PLATFORM_OIDC_SCOPES`, `PLATFORM_OIDC_ALLOWED_REDIRECT_URIS`, `PLATFORM_OIDC_REDIRECT_URI`, `PLATFORM_OIDC_DEBUG` |
| Email | `RESEND_API_KEY` S, `EMAIL_FROM`, `EMAIL_FROM_SECURITY`, `EMAIL_FROM_NOREPLY`, `EMAIL_DELIVERY`, `RESEND_DISABLED`, `EMAIL_TEST_FORCE_PROVIDER`, `CONTACT_EMAIL`, `CONTACT_PHONE`, `PLATFORM_NOTIFICATION_EMAIL`, `PLATFORM_PAYMENT_NOTIFICATION_EMAIL` |
| Payments | `PAYSTACK_SECRET_KEY` S, `PAYSTACK_MODE`, `PAYSTACK_ENABLED`, `PAYSTACK_LOCAL_LIVE_TEST`, `PAYSTACK_CURRENCY`, `PAYSTACK_CHECKOUT_BANK_TRANSFER`, `PAYSTACK_LOCAL_LIVE_ALLOWED_TENANT_IDS`, `PAYSTACK_LOCAL_TEST_TENANT`, `PAYSTACK_WEBHOOK_SIGNING_SECRET` S, `PAYSTACK_WEBHOOK_SIGNING_SECRET_PREVIOUS` S |
| Zeli / AI | `DEEPSEEK_API_KEY` S, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, `DEEPSEEK_INVESTIGATION_MODEL`, `ZELI_PROVIDER`, `ZELI_EXTERNAL_AI_DISABLED`, `ZELI_INVESTIGATION_DISABLED`, `ZELI_SYNTHETIC_TESTING_ALLOWED`, `ZELI_TEAM_TESTING_ALLOWED`, `ZELI_TEAM_TESTING_TENANT_CODE`, `ZELI_PRIVACY_POLICY_VERSION`, `ZELI_APPROVAL_REFERENCE`, `ZELI_GATEWAY_MIN_COHORT`, `ZELI_EXPIRY_SCHEDULER`, `ZELI_EXPIRY_INTERVAL_MS`, `ZELI_ACCEPTANCE_PROBE`, `ZELI_ACCEPTANCE_PROBE_TOKEN` S, `ZELI_ACCEPTANCE_TENANT_CODE`, `ZELI_PROVIDER_USER_DAILY_LIMIT`, `ZELI_PROVIDER_TENANT_DAILY_LIMIT` |
| Messaging | `WHATSAPP_ACCESS_TOKEN` S, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_GRAPH_VERSION`, `WHATSAPP_RECEIPT_TEMPLATE`, `WHATSAPP_OTP_TEMPLATE`, `WHATSAPP_TEMPLATE_LANGUAGE`, `WHATSAPP_APP_SECRET` S, `WHATSAPP_VERIFY_TOKEN` S, `WHATSAPP_DELIVERY_ENABLED`, `WHATSAPP_DELIVERY_ALLOWLIST`, `SMS_PROVIDER`, `SMS_DELIVERY_ENABLED`, `SMS_DELIVERY_ALLOWLIST`, `SMS_STATUS_WEBHOOK_SECRET` S, `MESSAGING_DISPATCH_TOKEN` S, `ANOMALY_SCAN_TOKEN` S |
| Risk intelligence | `RISK_INTELLIGENCE_SALT` S, `RISK_INTELLIGENCE_KEY_V${n}` S, `RISK_INTELLIGENCE_ACTIVE_KEY_VERSION`, `RISK_INTELLIGENCE_SUPPORTED_VERSIONS`, `RISK_RETENTION_TOKEN` S, `RISK_AGREEMENT_HASHES`, `RISK_HOSTING_PROVIDERS`, `RISK_HOSTING_REGIONS`, `GHANA_EXTRA_PUBLIC_HOLIDAYS` |
| Policies/finance | `WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR`, `OFFLINE_COLLECTIONS_ENABLED`, `OFFLINE_MOMO_ENABLED` |
| Bootstrap/test | `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` S, `PLATFORM_ADMIN_PASSWORD` S, `PLATFORM_SUPER_ADMIN_PASSWORD` S, `TENANT_ADMIN_PASSWORD` S, `STAGING_SEED_CONFIRM`, `STAGING_SEED_PASSWORD` S, `STAGING_SEED_OUTPUT_FILE`, `RUN_SEED`, `E2E_PORT`, `E2E_BASE_URL`, `CAPTURE_EVIDENCE`, `MAACASH_CANONICAL_ORIGIN`, `MAACASH_LEGACY_ORIGIN`, `CHROME_PATH`, `TEMP` |

Declared but not consumed: `DB_PROVIDER`, `OFFLINE_COLLECTIONS_ENABLED` outside
guards, `MAACASH_APP_URL` before this audit (now consumed by the cron script).

## 4b. Database migration state

A Neon snapshot `snap-sweet-darkness-b4kclz8q` named
`maacash-pre-migration-20261125` was created from the `production` branch
(`br-misty-sound-b4tmag5z`) and confirmed in the snapshot list before any schema
change. A restore was not executed, because that would create a second database.

All 30 then-pending migrations were applied once with
`npx prisma migrate deploy --config prisma.pg.config.ts`. A static scan of the
pending SQL found no `UPDATE`, `DROP` or `DELETE` statements; the chain is
additive. The command reported "All migrations have been successfully applied."
Post-migration verification succeeded: `prisma migrate status` reported
"Database schema is up to date!" and record counts confirmed existing data was
preserved (2 business tenants, 12 users, 202 audit rows, 0 risk signals, 0
agreements, 0 organisation-profile rows).

## 5. External integrations checklist

| Integration | Configured | Verified | Owner action | Depends on |
| --- | --- | --- | --- | --- |
| Neon PostgreSQL | yes | app health 200; local TCP to port 5432 refused | grant operator DB access for migration/backup | all writes |
| Render hosting | yes | yes | approve paid instance for capacity | all |
| Resend email | yes | API key and sender present; live sender domain previously verified | confirm current `EMAIL_FROM` is the verified domain | password reset |
| Cloudflare Turnstile | yes | keys present | confirm widget host allowlist | public forms |
| Paystack | keys present in production | subscription path already live | confirm live mode and webhook secret | billing |
| DeepSeek / Zeli | key present | code path tested; live calls owner-gated | approve live AI use | Zeli conversation |
| WhatsApp / SMS | not configured | delivery disabled | Meta verification / provider contract | messaging |
| MTN / Telecel / AT Money provider feeds | no provider confirmation | matching works, status stays operator-recorded | provider agreement | provenance level |
| Risk HMAC secret | configured this audit | format-only verified | rotate through managed env when required | risk register |
| Retention token | configured this audit | format-only verified | approve cron spend or accept manual sweep | daily retention |

## 6. Scheduler specification (prepared, not provisioned)

`scripts/run-risk-retention-cron.mjs` posts to
`POST /api/internal/risk-intelligence/retention` with
`Authorization: Bearer $RISK_RETENTION_TOKEN`, a 30-second timeout, HTTPS-only
target and non-zero exit on failure. It logs status, elapsed time and counts only.

Render cron jobs cost **USD 1/month minimum**. The owner **rejected** that
recurring charge. No cron job was provisioned. Retention stays a manual action:
the owner runs the sweep and reviews overdue rights cases **weekly on Monday**.
The prepared
but unprovisioned job spec is: name `maacash-risk-retention`, schedule `0 2 * * *`, command
`node scripts/run-risk-retention-cron.mjs`, same release commit and environment
as the web service. Use `SITE_URL` fallback if `MAACASH_APP_URL` is absent.

## 7. Release stop conditions

Release stops if:
1. migrations cannot be confirmed applied against a verified snapshot;
2. a controlled agreement is needed but the confirmed office is not effective;
3. Turnstile keys do not match the allowed host;
4. email delivery is disabled or the sender is unverified;
5. the free-plan capacity limit is presented as 1,000-user readiness;
6. the release needs a second push or a second deployment.

## 8. Verification commands

```
npx prisma validate --schema=prisma/schema.prisma
npx prisma validate --schema=prisma/schema-pg.prisma
node scripts/verify-sqlite-migrations.mjs
npx tsx scripts/risk-live-readiness.ts
npm run typecheck
npm run lint
npm run build
npm test
```
