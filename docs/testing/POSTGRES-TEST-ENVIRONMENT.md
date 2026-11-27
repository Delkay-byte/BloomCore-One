# PostgreSQL test environment — hook-timeout root cause and remediation

**Scope:** the disposable PostgreSQL integration suite only (`npm run test:pg`). This does not change production, staging or any managed database setting.

---

## 1. Symptom

`tests/pg-offline-idempotency.test.ts` intermittently failed in `beforeEach` with:

```
Error: Hook timed out in 10000ms.
```

The failure appeared only when the full PostgreSQL file set ran (3 of 5 earlier full runs); the same file alone passed 12 of 12 times. The `beforeEach` body is a single `TRUNCATE ... CASCADE` over the test tables, so the timeout was in test cleanup, not in an assertion.

---

## 2. What was ruled out

- **Not an advisory-lock deadlock.** The suite's application code uses `pg_advisory_xact_lock(hashtext(...))` for account/remittance serialisation, but no session was waiting on an advisory lock during the failure.
- **Not a lock wait on another session.** `pg_stat_activity` showed no other active transaction holding a conflicting table lock. The only active session was the test's own `TRUNCATE`.
- **Not a stalled query in the application.** The hang reproduced before any route or action ran, inside the cleanup hook.
- **Not a missing disconnect.** No test file disconnects its Prisma client, but idle pooled connections do not block `TRUNCATE`; the blocking session was the truncate itself.

## 3. Root cause

Instrumenting `resetDatabase` to sample `pg_stat_activity` every 1.5 seconds captured the truncate waiting on **I/O**, not a lock:

```
state=active  wait_event_type=IO  wait_event=DataFileImmediateSync
query=TRUNCATE TABLE "FoundingAllocation", ...
```

`TRUNCATE` assigns each truncated relation a new file and forces an immediate sync of that file (`DataFileImmediateSync`). The cleanup truncates roughly 40 tables, so it performs roughly 40 synchronous file writes. On this Windows host the disposable PostgreSQL 16 container stores its data on the Docker Desktop volume; under concurrent host load those syncs take long enough that 40 of them exceed Vitest's 10-second hook budget. The database server logs no deadlock or statement timeout, which is consistent with a pure I/O stall.

This also explains why the file passed alone and failed in the full run: the full run has more host I/O in flight, and the per-relation sync latency rises.

## 4. Remediation

The disposable PostgreSQL 16 server at `localhost:55499` was restarted with durability syncs disabled **for tests only**:

```sql
ALTER SYSTEM SET fsync = off;
ALTER SYSTEM SET synchronous_commit = off;
```

then `docker restart maacash-int-pg16`, verified with `SHOW fsync` → `off` and `SHOW synchronous_commit` → `off`.

This removes the `DataFileImmediateSync` wait. It does **not** change any assertion, timeout, query, fixture or application behaviour. Crash durability is not what these tests assert; the suite asserts migrations, constraints, idempotency, concurrency and tenant isolation. Production and managed databases must keep `fsync = on`.

## 5. Evidence after the change

| Run | Result | Duration |
|---|---|---|
| 1 | 15 files, 61 tests passed | 21.14 s |
| 2 | 15 files, 61 tests passed | 20.14 s |
| 3 | 15 files, 61 tests passed | 22.02 s |

Before the change the same suite took 67.39 s and failed 3 of 61 tests in the first of three diagnostic runs. The change also cut total suite time by roughly two thirds because the cleanup no longer waits on per-relation syncs.

## 6. Reproducing the environment

```powershell
docker run -d --name maacash-int-pg16 `
  -e POSTGRES_PASSWORD=localonly `
  -p 127.0.0.1:55499:5432 `
  postgres:16 -c fsync=off -c synchronous_commit=off

$env:PG_DATABASE_URL = "postgresql://postgres:localonly@localhost:55499/maacash_test_int"
$env:PG_TEST_CONFIRM = "DISPOSABLE_TEST_DATABASE"
npm run test:pg
```

The existing `scripts/pg-safety.mjs` guard still refuses any target that is not loopback, explicitly confirmed and named `maacash_test*`. The `fsync` setting is an infrastructure property of the disposable container; it is not committed to the application and has no effect on production.

## 7. Residual limitation

A CI runner that provides PostgreSQL with default durability settings can still hit this I/O stall on a slow volume. The correct CI configuration is the same: a dedicated disposable PostgreSQL service with `fsync=off` (or a tmpfs data directory). Raising the Vitest hook timeout would hide the condition without fixing it and was deliberately not done.
