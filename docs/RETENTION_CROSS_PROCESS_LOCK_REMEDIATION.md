# F5 — cross-process retention lock remediation

Date: 25 November 2026. Release remains **HELD**. All evidence below is local;
no production database, retention sweep or deployment was touched.

## 1. Problem (`Verified in code`)

Before this change, `src/app/api/internal/risk-intelligence/retention/route.ts`
used a module-level `sweepInProgress` boolean. It serialised requests inside
one Node process only. The mutation entry points
(`runSystemRiskRetentionSweep` and `expireStaleRiskSignals`) were reachable
directly, without the route guard. Two processes could both scrub the same
rows; the previous harness explicitly recorded both calls returning
`scrubbed=5`.

## 2. Implemented design (`Verified in code`)

- New model `SystemJobLease` in both `prisma/schema.prisma` and
  `prisma/schema-pg.prisma`, plus reviewed additive migration
  `prisma/migrations/20261226_system_job_lease/migration.sql`.
- `src/lib/security/job-lease.ts`:
  - `acquireJobLease(key)` — a unique-row `create`, falling back to a single
    conditional `updateMany` that claims only a `released` or expired row. The
    claim is atomic on both PostgreSQL and SQLite. A random UUID `ownerId`
    identifies the owner; no secret is stored.
  - `assertJobLease(lease)` — one atomic `updateMany` that both verifies
    `id + ownerId + fencingToken + status=running + not expired` and renews
    `expiresAt` (heartbeat). A stale owner throws `LeaseLostError`.
  - `releaseJobLease(lease, outcome)` — releases only the caller's own lease.
  - `fencingToken` increments on each takeover. A stale owner cannot release
    or continue a newer owner's lease.
- `executeRetentionSweep()` and `expireStaleRiskSignals()` both acquire the
  same lease key. Every destructive step calls `assertJobLease()` first:
  signal expiry, each signal scrub (per row), disclosure scrub, review event
  creation and the audit write.
- The route now maps a lease conflict to `409` and no longer uses process-local
  state. Token verification and the 6/hour hashed-token limit still run before
  any mutation.

Lease duration is 10 minutes, renewed by each fence/heartbeat. A process that
is hard-killed leaves a lease that becomes claimable after 10 minutes; this is
an explicit, documented bound, not an indefinite block. The fencing token
prevents a killed process that resumes from making further writes.

## 3. Tests (`Verified in code`)

`tests/f5-retention-cross-process-lock.test.ts` (disposable SQLite) proves:

1. second live claim refused;
2. expired lease takeover increments the fencing token;
3. stale owner is fenced before its next mutation;
4. one owner cannot release another owner's lease;
5. failed outcome is recorded and leaves no live lease;
6. two concurrent sweeps → exactly one success, one conflict, rows scrubbed once;
7. audit event records `leaseOwner` and `fencingToken` (no secret);
8. two genuinely independent Node processes compete through a shared database
   and exactly one claims the lease.

Result: **8/8 passed**. Command:
`npx vitest run tests/f5-retention-cross-process-lock.test.ts`.

`tests/retention-fixes.test.ts` (F1, F2, F3, F4, F6, F7) still passes: **6/6**.

## 4. Remaining limitation

The one-shell operating rule is no longer the control. The database lease is
the control. Operators still avoid two simultaneous executions because a
second run now correctly returns `409` and must be retried later. No known
code-level overlap defect remains. Production lease behaviour on Neon is
`Unverified`: no production connection was made.
