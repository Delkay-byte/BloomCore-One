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

## 2. What the repository shows

| Finding | Evidence |
|---|---|
| The legacy service is the previous Render service, retained as a rollback target | `render.yaml` header comment: previous service `srv-dbihvrmgekts73fdcbj0`, now `bik-prestige-legacy` |
| The legacy application predates the current security model | `origin/master` is an ancestor of `origin/main` and **77 commits behind** |
| Legacy authentication has no MFA | no `mfaEnabled` or `MFA_ENFORCEMENT` in `origin/master` |
| Legacy has no Turnstile | no Turnstile reference in `origin/master` |
| Legacy still exposes login surfaces | `/login`, `/login/momo`, `/login/susu`, `/login/customer`, `/api/auth/session` on `origin/master` |
| Legacy reads the same domain tables | the old schema contains `User`, `Customer`, accounts, contributions and withdrawals |

This is repository evidence about the code. It is not evidence about the
running service's environment, which the agent cannot read without Render or
Neon access.

## 3. Prior release finding (carried forward, not re-verified)

The previous release reported that `bik-prestige-legacy` shares the production
Neon database and lacks the current MFA and Turnstile protections. That finding
is consistent with the repository evidence above, but it was not re-verified in
this change.

## 4. Questions and current answers

| # | Question | Answer | Confidence |
|---|---|---|---|
| 1 | Is it receiving real user traffic? | Unknown. Requires Render request metrics and access logs. | Not verified |
| 2 | Which users depend on it? | Unknown. Requires access logs plus user contact. | Not verified |
| 3 | Does it share production user/session data? | Reported yes by the previous release; not re-verified. | Prior finding |
| 4 | What financial and customer data can it access? | If it shares the database: users, customers, accounts, contributions, withdrawals, remittances and daily accounts. | Code-level inference |
| 5 | Can weaker authentication expose the shared database? | If it shares the database and is reachable, a valid password could create a session without MFA. Session tokens are signed with the legacy secret, so they would not automatically be valid on the new host, but the legacy host could still read and write through its own session. | Conditional risk |
| 6 | Can it be isolated safely? | Yes, in stages: block public traffic first, then remove database access after a rollback window. Requires owner authorization. | Recommendation |
| 7 | Should it be retired or hardened? | Retire after evidence collection unless a named user still depends on it. Hardening is the fallback. | Recommendation |

## 5. Risk statement

A reachable legacy deployment with password-only authentication, pointed at the
production database, is a weaker path to the same records protected by MFA and
Turnstile on the current host. The severity depends on two facts that are not
yet verified: whether it is reachable, and whether it still uses the production
database.

Do not describe the production database as fully protected until those two facts
are confirmed.

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
