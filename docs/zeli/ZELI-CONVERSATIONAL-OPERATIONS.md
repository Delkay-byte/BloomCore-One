# Zeli — Production and Staging Operations Verification

**Date:** 4 November 2026.
**Scope:** scheduler, Neon recovery, staging topology, Render configuration.
**Access note:** the agent has no Render or Neon credentials. Items marked
**OWNER ACTION REQUIRED** were not performed or verified.

## 1. Expiry scheduler

### Code evidence

| Property | Implementation |
|---|---|
| Registration | `src/instrumentation.ts` exports `register()` |
| Startup catch-up | `void runSweep()` runs immediately on register |
| Interval | 15 minutes default; `ZELI_EXPIRY_INTERVAL_MS` accepted only at 60 seconds or more |
| Process safety | timer is `unref()`d, so builds and short-lived workers exit |
| Test safety | skipped when `VITEST` is set |
| Operator kill switch | `ZELI_EXPIRY_SCHEDULER=disabled` |
| Failure handling | logs the error name only; never crashes the server |
| Multi-instance safety | every status change is a conditional `updateMany` on the state that was read; a lost race is counted as `skipped` |
| Idempotence | repeated sweeps are safe; entitlement events are append-only |

### Test evidence

- `tests/zeli-expiry.test.ts`
- `tests/zeli-expiry-scheduler.test.ts`

### Production execution evidence

**NOT VERIFIED.** Confirming that production executions succeed requires the
Render log stream.

Owner step:

1. Render → `bloomcore-one` → Logs.
2. Search for `[zeli-expiry] sweep completed`.
3. Confirm a recent entry exists and the counts are plausible.
4. Confirm no repeating `[zeli-expiry] sweep failed`.

### Cron job

Do not provision the optional Render Cron Job. The in-process scheduler is
registered, catch-up capable and race-safe. A paid cron job adds cost with no
demonstrated benefit.

## 2. Neon recovery

**NOT VERIFIED.** The agent has no Neon dashboard or API access.

Owner steps:

1. Neon Console → project used by `bloomcore-one` → Settings / Backups.
2. Record the plan's point-in-time-recovery window (or the snapshot schedule).
3. Confirm whether recovery creates a branch and whether that branch is billed.
4. Perform a non-production restore rehearsal:
   - create a branch from a timestamp before a known test write;
   - verify the expected row is absent in the restored branch;
   - delete the rehearsal branch.
5. Record the recovery time objective actually available on the current plan.
6. Confirm the production connection string is the pooled host and migrations
   use the direct host (`DIRECT_URL`).

Do not run a restore against the production branch.

## 3. Staging topology

| Item | State |
|---|---|
| Service | `bloomcore-one-staging` |
| Auto-Deploy | OFF. Keep OFF. |
| Database | separate staging Neon database |
| Paystack | TEST credentials |
| MFA | enforced |
| Turnstile | staging hostname configuration |
| Deployment | manual, from an approved commit |

### Is a separate `staging-api` service necessary?

The repository contains no `staging-api` service definition. `render.staging.yaml`
defines one web service (`bloomcore-one-staging`) that serves both the UI and the
API routes; the API is part of the same Next.js application.

Conclusion: a separate `staging-api` service is **not required by this
architecture**. If one exists in the Render dashboard, it is likely a duplicate.
It must not be created for this work.

Owner step: if `staging-api` exists, confirm its `DATABASE_URL` points only to
the staging database and either document its purpose or retire it. Do not point
it at production.

## 4. Production configuration checklist

| Setting | Required state | Verification |
|---|---|---|
| Auto-Deploy | After CI checks pass | Owner: Render settings |
| Production database | production Neon only | Owner: dashboard hostname |
| Paystack | LIVE credential | Owner: dashboard |
| Paystack webhook | `https://bloomcore-one.onrender.com/api/payments/paystack/webhook` registered and verified | Owner confirmed; do not re-register |
| MFA enforcement | `MFA_ENFORCEMENT=enforce` | `render.yaml` declares `enforce`; confirm live value |
| Turnstile | production site/secret keys, allowed hostname | Owner: dashboard |
| Global Zeli availability | ON | Owner: `/platform/zeli` |
| Local Zeli | available | Code: local path has no provider dependency |
| External AI | controlled by approval gate; production blocked | Code: `PRODUCTION_PROVIDER_APPROVED=false`, `PRODUCTION_CONVERSATION_APPROVED=false`, emergency stop default |
| Conversation provider | no production call | Code and tests |
| Credential | configured, never displayed | Boolean check only |

## 5. Checks the agent performed

- Full local unit and integration suite (see release record).
- Typecheck and lint.
- Production build.
- Scheduler registration and expiry tests.
- Provider-off tests proving no outbound call.
- Repository evidence for the legacy service.

## 6. Checks the agent could not perform

- Render dashboard settings and logs.
- Neon backup/recovery state.
- Live staging deployment of this branch.
- Any authenticated production session.
- Real traffic evidence for the legacy service.
- A live DeepSeek synthetic call.

All of the above are owner actions or require owner credentials.
