# Zeli — Legacy Application Assessment (`bik-prestige-legacy`)

**Status:** investigation limited by access; owner decision required.
**Date:** 4 November 2026.

## 1. Protection rules in force

The following remain in force and were not changed by this work:

- do not delete the service;
- do not suspend it;
- do not change its environment;
- do not redeploy it;
- do not change its database;
- do not change its secrets.

## 2. What the repository and live service show

| Finding | Evidence |
|---|---|
| The legacy service is the previous Render service, retained as a rollback target | `render.yaml` header comment: previous service `srv-dbihvrmgekts73fdcbj0`, now `bik-prestige-legacy` |
| It auto-deploys from `main` | Render service metadata: `branch=main`, `autoDeploy=yes` |
| It runs the current application code | live deploy commit `4a68c5d`, the production release |
| It is publicly reachable | `https://bik-prestige-enterprise-pcxi.onrender.com` returns HTTP 200 on `/`, `/login`, `/platform/login` and `/api/health` |
| It shares the production database host | Render env host comparison: legacy `DATABASE_URL` host equals production host |
| Legacy authentication has no enforced MFA | only 7 env keys; `MFA_ENFORCEMENT` absent, so the code default is not `enforce` |
| Legacy has no Turnstile | no `TURNSTILE_*` keys configured |
| Legacy has no dedicated rate-limit secret | `RATE_LIMIT_HMAC_SECRET` absent; code falls back to `JWT_SECRET` |
| Legacy has no MFA encryption key | `MFA_ENCRYPTION_KEY` absent, so MFA enrolment cannot operate correctly |
| Legacy exposes the current login and platform surfaces | `/login` and `/platform/login` both return 200 |

This is stronger evidence than the previous release. The legacy host is not a
stale old build: it is the current application, running against the production
database, with weaker environment configuration.

## 3. Prior release finding — confirmed

The previous release reported that `bik-prestige-legacy` shares the production
Neon database and lacks the current MFA and Turnstile protections. Both points
are now confirmed from Render service metadata and environment keys. The legacy
host also auto-deploys the current `main` code, so it is not a frozen old build.

## 4. Questions and current answers

| # | Question | Answer | Confidence |
|---|---|---|---|
| 1 | Is it receiving real user traffic? | Unknown. Render's public API does not expose request metrics; dashboard access is required. | Not verified |
| 2 | Which users depend on it? | Unknown. Requires access logs and owner knowledge. | Not verified |
| 3 | Does it share production user/session data? | Yes: same database host as production. | Verified |
| 4 | What financial and customer data can it access? | Users, customers, accounts, contributions, withdrawals, remittances and daily accounts in the production database. | Verified by configuration |
| 5 | Can weaker authentication expose the shared database? | Yes conditionally: MFA is not enforced and Turnstile is absent, so a valid password is sufficient on the legacy host. | Verified configuration risk |
| 6 | Can it be isolated safely? | Yes, in stages: block public traffic first, then remove database access after a rollback window. Requires owner authorization. | Recommendation |
| 7 | Should it be retired or hardened? | Retire after evidence collection unless a named user still depends on it. Hardening is the fallback. | Recommendation |

## 5. Risk statement

A publicly reachable legacy deployment that auto-deploys the current code,
enforces no MFA, has no Turnstile, and points at the production database is a
weaker path to the same records protected on the main host. The remaining
unknown is traffic volume, not exposure. Treat this as a live production
security finding until the owner decides the transition.

## 6. Evidence collection (owner, read-only)

1. Render dashboard → `bik-prestige-legacy` → Metrics: requests, bandwidth and
   response codes for the last 30 days.
2. Render dashboard → Logs: distinct source IPs and user agents. Note whether
   traffic is health checks only.
3. Render dashboard → Environment: confirm the database hostname **without
   copying any secret value** (compare host only).
4. Neon dashboard → project → Monitoring → connections by application and
   active databases for the last 7–30 days.
5. Ask the owner's known pilot users whether they still use the legacy URL.

## 7. Recommended transition (requires owner authorization)

### Stage 0 — decide

Record: is there any non-health traffic? Is the database the production one?
If both answers are "no", retirement is low risk.

### Stage 1 — stop new use

- Announce the retirement date to pilot users.
- Publish a redirect or maintenance page on the legacy host if the platform
  permits it without changing application secrets.
- Do **not** delete the service.

### Stage 2 — remove database reach

After the rollback window:

- point the legacy service at a snapshot or a non-production database; or
- revoke its database role; or
- scale the service to zero.

Each of these changes the service, so each needs explicit owner authorization.

### Stage 3 — retire

- Confirm 30 days with no dependency.
- Keep a final database backup.
- Delete the service only with written owner approval.

### Rollback

If retirement causes a real regression, restore the previous environment from
the Render dashboard and re-enable the old host. The production database must
not be modified as part of the legacy change.

## 8. What the agent did

Nothing. No Render or Neon change was attempted. No traffic, environment or
database claim is made beyond the repository evidence and the carried-forward
prior finding.
