# Zeli — Expiry Scheduler

**Status:** implemented in the web service. No new paid Render resource.

## What it does

Every 15 minutes, and once immediately after the service starts, the process
runs `expireZeliLifecycle()`:

1. Active subscriptions whose `periodEnd` has passed become `expired`, or
   `cancelled` when the customer had cancelled at period end.
2. Active entitlements whose `expiresAt` has passed become `expired`, with an
   append-only `ZeliEntitlementEvent` (`action=expired`, `actorType=system`).

Every write is a conditional `updateMany` on the state that was read. A renewal
that extends the period first makes the condition fail, so the sweep cannot
expire a just-renewed entitlement. Repeated runs change zero rows and append no
events. Payment, subscription and entitlement history is never deleted.

## Why not a Render Cron Job

A separate cron service is a new billable resource and a second deployment to
keep in sync. The existing web service already holds the production database
credentials and is restarted by Render. Running the sweep in-process avoids a
new cost and a new secret. The trade-off is documented below.

If a managed schedule is preferred later, the exact owner action is a Render
Cron Job on the same repo and branch with schedule `*/15 * * * *` and command
`npm run zeli:expire`, sharing the production service's non-secret environment
and `DATABASE_URL`/`DIRECT_URL`. Render bills cron jobs by running time with a
**minimum of $1/month per cron job service**, so it needs explicit owner cost
approval. It has not been created.

## Hook location (important)

This project uses `src/app`, so Next scans `<root>/src` for the instrumentation
hook. The scheduler must live at `src/instrumentation.ts`. A hook placed at the
repository root is silently ignored, and the scheduled sweep then never starts
even though the service is healthy. A regression test
(`tests/zeli-expiry-scheduler.test.ts`) fails if the hook moves back out of
`src/` or if `register()` stops starting the sweep.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ZELI_EXPIRY_SCHEDULER` | unset (enabled) | Set to `disabled` to stop the timer in an environment. |
| `ZELI_EXPIRY_INTERVAL_MS` | `900000` (15 min) | Optional override; values below 60000 are ignored. |

No secret is required. The process uses the service's existing `DATABASE_URL`.

## Health and monitoring

- Each run logs `[zeli-expiry] sweep completed` with counts, or
  `[zeli-expiry] sweep failed` with the error name only. No tenant data is
  logged.
- A failed sweep never crashes the web service. The next run retries; access is
  still denied by the `expiresAt` check in the meantime.
- A missed sweep is harmless: the next run catches every lapsed row, because the
  query has no lower bound.
- Manual run: `npm run zeli:expire` (prints counts) against the target database.

## Limits

- The timer lives in one process. On a multi-instance plan each instance runs a
  sweep; the conditional updates make that safe but duplicate work is possible.
- If the service is asleep, expiry waits until the next start, and the immediate
  catch-up covers the gap.
- The sweep is a lifecycle bookkeeping job, never the access control. The
  entitlement `expiresAt` check remains authoritative on every request.
