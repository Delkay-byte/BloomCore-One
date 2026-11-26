# Risk Intelligence configuration and secret boundaries

Owner: security lead. Version: 2026.11-config-1. Never commit secret values
and never print them in logs, tickets, screenshots or reports.

## 1. Required variables

| Variable | Required | Purpose | Notes |
| --- | --- | --- | --- |
| `RISK_INTELLIGENCE_SALT` | Yes | HMAC-SHA256 subject-key salt | Managed secret store in production; versioned rotation; never the local value |
| `BLOOMCORE_AUTHORISED_SIGNATORY_NAME` | Yes for execution | Authorised BloomCore signatory on controlled instruments | Must be the verified individual; do not infer from a display name |
| `BLOOMCORE_AUTHORISED_SIGNATORY_CAPACITY` | Yes for execution | Signatory capacity/title | Use only the verified capacity; no invented CEO title |
| `BLOOMCORE_REGISTERED_ADDRESS` | Yes for execution | Registered office printed in instruments | Never invent it. While absent, presentation and countersignature fail closed; it may also be saved from the owner's confirmed record at `/platform/risk-access` |
| `BLOOMCORE_PRIVACY_EMAIL` | Optional override | Public privacy contact | Defaults to the owner-approved `bloomcoretechnologies@gmail.com`; this is not a Resend sender identity |
| `RISK_HOSTING_PROVIDERS` | Required to assert hosting | Named infrastructure providers | Leave unset and the addendum refers to the RoPA instead |
| `RISK_HOSTING_REGIONS` | Required to assert hosting | Hosting regions | Same fail-safe as above |
| `RESEND_API_KEY` | Yes for email | Transactional email | Existing provider only; no new dependency |
| `EMAIL_FROM` or `EMAIL_FROM_SECURITY` | Yes for email | Verified sender | Must be a verified domain; the public Gmail privacy contact is never the sender. Otherwise notifications fail closed |
| `RISK_AGREEMENT_HASHES` | Legacy only | legacy exact-text approval for `presentParticipationAgreement` | Not used by the controlled owner flow; do not treat as Instrument approval |
| `RISK_RETENTION_TOKEN` | Yes for scheduling | Authenticates the daily retention route | Send as `x-retention-token` or bearer token; the route returns 503 until configured |
| `GHANA_EXTRA_PUBLIC_HOLIDAYS` | Optional | Additional gazetted holidays as `YYYY-MM-DD:Name` entries | Used by rights deadlines; version recorded on each request |

Other existing application variables (database, JWT, MFA, site URL) are not
changed by this module. Do not alter production secrets as part of a code
deployment.

## 2. Local development

`next.config.ts` loads `.env.risk-intelligence.local` only when
`NODE_ENV !== "production"`. Existing variables win. The file is not an
automatic Next.js env file and is not read by a production build. Its only
current key is the local `RISK_INTELLIGENCE_SALT`.

The local salt is disposable and must never be reused in production. Tests use
their own synthetic values and the disposable `tests/test.db`.

## 3. Secret provider

The shipped environment provider is the current production provider boundary;
a managed store can be registered with `registerRiskSecretProvider()` without
changing callers. The Node instrumentation installs a durable, metadata-only
`risk_intelligence.secret_access` audit sink at boot, so key access is persisted
even when no administrator opens the console. The provider reference, version
and retirement metadata live in `RiskKeyVersion`; the secret material never does. Rotation creates a new version and keeps the previous
version available for candidate matching until retirement.

## 4. Scheduler and operations

Schedule `POST /api/internal/risk-intelligence/retention` daily with
`RISK_RETENTION_TOKEN` in `x-retention-token` (or as a bearer token). The route
expires stale signals and then runs `runSystemRiskRetentionSweep()`; it is
disabled with a 503 when no token is presented and rejects a wrong token with
403 while `RISK_RETENTION_TOKEN` is unset. A sweep must be idempotent,
must skip legal holds, and must never delete financial records. Record the run,
counts and failures in the existing audit/control event stream.

## 5. Email

`src/lib/risk-intelligence/notifications.ts` writes a durable
`GovernanceDocumentDelivery` row before sending. Success requires a provider
message id; a skipped or failed send is not delivery evidence. The unique key
(event, scope, recipient hash) makes retries idempotent. Do not claim an email
was delivered without provider evidence.

## 6. Access and organisation facts

Grant `RiskPrivacyAccess` only when a business wants a restricted privacy console.
It is optional and is not a DPO/DPS appointment or an onboarding condition.
Revoke on role change or exit. The grant is separate from tenant administrator
status and cannot be assumed from an admin session. A platform owner can always
countersign agreements and publish the controlled employee notice from
`/platform/risk-access` without any tenant grant.

A platform owner may grant `privacy_admin` or `privacy_reviewer` to an existing
active tenant administrator at `/platform/risk-access`. It does not create an
account. A delegated privacy lead can grant or revoke reviewers inside its own
business. There is no "last DPO" lock: the platform owner can restore access.
Every change writes a control and platform audit event.

The verified BloomCore signatory, registered office and hosting facts may be
stored in the additive single-row `RiskOrganisationProfile` through
`/platform/risk-access` or the privacy console. Database values take precedence
over most `BLOOMCORE_*` and `RISK_HOSTING_*` fallbacks. The public privacy email
is the exception: the owner-approved constant is canonical so a stale database
row cannot silently replace it. The TIN is never rendered in a public instrument.

## 7. Verification

Use `scripts/risk-live-readiness.ts` for a read-only count and configuration
presence check. It never prints secrets or personal data:

```
npx tsx scripts/risk-live-readiness.ts
```

The script loads `.env` and, outside production, `.env.risk-intelligence.local`
without overriding a managed deployment variable. In production, inject the
variables through the platform and do not ship the local file.
