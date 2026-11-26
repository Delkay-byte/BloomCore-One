# MaaCash performance and capacity plan

**Status:** read-only audit. No load test was run. No production target was contacted. This is a
plan and a set of proposals, not evidence of capacity.

Evidence base: `docs/PERFORMANCE_AND_LOAD_TEST_REPORT.md` (audited 25 Nov 2026),
`docs/SECURITY_AND_TEST_REPORT.md` §7, `scripts/load-test.mjs`, `playwright.config.ts`,
`vitest.pg.config.ts`, `.github/workflows/ci.yml`.

---

## 1. What is known today

| Fact | Evidence |
| --- | --- |
| Render plan `free`, 1 web instance, no autoscaling | `docs/PERFORMANCE_AND_LOAD_TEST_REPORT.md` §1 |
| `GET /api/health` returned 200 on the custom domain; a privacy-page 503 was transient | same, §1 |
| k6 not installed; only `scripts/load-test.mjs` exists | same, §1 |
| No throughput, p50/p95/p99, error rate, CPU/memory, DB pool, query, queue or provider latency measurement exists | same, §3 — absence recorded as absence |
| No isolated production-equivalent environment; local SQLite is not a PG proxy | same, §2 |
| PostgreSQL concurrency is protected by per-account advisory locks; unproven at 1,000 writers | `docs/security/FINANCIAL-OPERATION-SECURITY.md` §5; performance report §4 |
| Daily retention / in-process sweeps are not coordinated across multiple instances | performance report §4 |
| No verified snapshot or restore point from audit host | `docs/SECURITY_AND_TEST_REPORT.md` §7 |

**No 1,000-user result is claimed.** The current infrastructure cannot be declared ready for
1,000 concurrent users on the available evidence.

---

## 2. Terms — four different quantities

These are not interchangeable. A target for one does not prove the others.

| Term | Definition | Example |
| --- | --- | --- |
| **Registered** | Accounts that exist in the database, regardless of activity | 1,000 recorded users |
| **Active** | Accounts that performed a meaningful action in a defined window (e.g. 24 h or 30 d) | 1,000 daily active users |
| **Simultaneous** | Sessions open at the same instant, including idle tabs | 1,000 open browser sessions |
| **Concurrent** | In-flight requests or transactions at the same instant | 1,000 concurrent HTTP requests; or 1,000 near-simultaneous transaction submissions |

A 1,000-registered-account dataset may produce 20 active users, 5 simultaneous sessions and 2
concurrent writes. State the quantity, window and endpoint before quoting a number.

---

## 3. Workload assumptions (proposals — require owner confirmation)

| Item | Proposal | Status |
| --- | --- | --- |
| Environment | Isolated, production-equivalent staging with disposable PostgreSQL and synthetic tenants only | BLOCKED — paid infrastructure not authorised (`docs/PERFORMANCE_AND_LOAD_TEST_REPORT.md` §2) |
| Data volume | 1,000 registered synthetic accounts, 10 synthetic tenants, 2 locations each; 180 days of synthetic daily-account and ledger history per branch | PROPOSED — not verified |
| Active mix | 10% of registered accounts active in a 30-minute profile | PROPOSED — replace with real pilot telemetry if available (none today) |
| Think time | 2–10 s between user actions; provider callbacks asynchronous | PROPOSED — no telemetry exists |
| Session model | One tab session per user; multi-tab scenario run separately | Based on tab-session architecture; `e2e/tab-sessions.spec.ts` |
| Provider behaviour | All provider credentials blank or synthetic; no live Paystack, WhatsApp, SMS, Resend or AI call | MANDATORY — `scripts/e2e-env.cjs:19–52` shows the blanking pattern |
| **Tracking pixels** | **Excluded entirely.** No analytics pixel, telemetry beacon, third-party tracking request or screenshot/video capture in any load profile or measurement window. Do not count them in requests, latency, errors or bytes | MANDATORY for this plan |
| Production | No volumetric, stress, spike or soak test against production without separate written owner approval and a named window | MANDATORY |

---

## 4. Endpoints and workflow classes

### 4.1 Public surface — the only thing `scripts/load-test.mjs` covers

Exact paths from `scripts/load-test.mjs:40`:

```
/api/health
/
/pricing
/privacy
/login
```

Invocation documented in that file:

```
node scripts/load-test.mjs --url http://127.0.0.1:3100 --users 1000 --connections 100 --duration 60
```

Limits enforced in the script: `--users` integer 1–5000, `--connections` 1–users,
`--duration` 5–600 s, default `--ramp` 10 s, `--timeout` 15000 ms, `--max-error-rate` 0.01.
It records p50/p95/p99/max latency, status counts, transport errors and requests per second.
It uses Node's built-in HTTP client and adds no dependency.

**Classification:** public-surface smoke only. It never authenticates and never reaches login
success, dashboards, agreement retrieval, risk queries, transaction writes or email
(`docs/PERFORMANCE_AND_LOAD_TEST_REPORT.md` §2). Do not present its output as a capacity finding.

### 4.2 Authenticated surfaces — required for any capacity claim (not yet tested)

| Class | Representative routes / actions | Why it matters |
| --- | --- | --- |
| Sign-in | `/admin/login`, `/login` (worker, collector), `/customer/login`, `/platform/login`, `/api/auth/me`, MFA verification | Session issuance and MFA rate limits (`src/lib/security/config.ts:196–203`) |
| MoMo close | Daily-account draft/save/submit, ledger list, branch transfer | Integer-pesewa arithmetic and branch scoping |
| Susu money | Contribution, withdrawal, reversal, remittance, offline sync | Advisory locks, conditional commission claim, idempotency keys |
| Reconciliation | Statement import, matching, exception cases, liquidity snapshot | Row matching window and read-only forecast |
| Reporting | Consolidated report, performance report, CSV export | Large dataset and tenant scope |
| Zeli | Conversation, analytics (entitlement), entitlement management | Provider fallback and per-tenant entitlement |
| Governance | Risk query, notices, rights requests, disclosures | Salted hashing, audit writes, privacy grant checks |
| Webhooks | Paystack / SMS status / messaging callbacks | HMAC, duplicate and out-of-order events |

No target, timeout or dataset ceiling is established for these classes. Set them before a test.

---

## 5. Targets and stop conditions (PROPOSED — approve before any test)

Targets are proposals, not existing service-level agreements. The owner must accept or replace
them before a run. Record the accepted values in the run report.

| Metric | Proposed target | Stop condition |
| --- | --- | --- |
| Public-page availability | ≥ 99.9% of measured requests | Stop if 5xx > 1% of measured window or health check fails twice |
| Public-page p95 latency | ≤ 800 ms warm instance; cold start reported separately | Stop if p95 > 2 s for 2 consecutive minutes |
| Authenticated page p95 | ≤ 1.5 s warm | Stop if p95 > 3 s for 2 consecutive minutes |
| Financial mutation success | ≥ 99% of valid synthetic requests | Stop immediately on double-post, negative balance, or cross-tenant write |
| Error rate | ≤ 1% excluding deliberate negative cases | Stop at > 1% for 60 s |
| DB pool | Headroom ≥ 20% of configured pool | Stop at sustained ≥ 90% utilisation or P1001/P1002 connection errors |
| Provider calls | 0 unapproved live calls; synthetic only | Stop immediately on any real provider credential being present |
| Instance health | 1 instance, no restart during window | Stop on restart, OOM or failed readiness |
| Data integrity | Ledger balance invariant holds after every profile | Stop on any invariant break; preserve logs for investigation |

Additional hard stops: any real customer data detected, any request to a production host, any
destructive command, any test that submits a form against a non-disposable database.

---

## 6. Profiles (all in isolated environment)

| Profile | Purpose | Shape (proposal) | Duration |
| --- | --- | --- | --- |
| **Baseline** | Warm single-user reference for each endpoint class | 1–2 users, sequential, think time 2–5 s | 10 min |
| **Load** | Expected pilot traffic | Ramp 50 → 250 simultaneous sessions with realistic mix; keep concurrent writes ≤ 10% of sessions | 30 min |
| **Spike** | Sudden arrival after idle / cold start | 0 → 250 sessions in 60 s; include a separately recorded cold-start case | 15 min |
| **Stress** | Find first breaking point, not to break production | Step concurrent requests until a stop condition fires, then stop; never on production | ≤ 30 min |
| **Soak** | Leaks, queue growth, sweep drift | 100 simultaneous sessions, steady mix, 4 h; record memory, pool, queue depth | 4 h |
| **Concurrency** | Business-invariant race conditions | 2, 10, 50 and 100 simultaneous writes to the **same** synthetic account / idempotency key; assert one post | 15 min per step |

Concurrency tests must use synthetic accounts created for the purpose and must assert database
state, not just HTTP status. The existing PostgreSQL test `tests/pg-withdrawal-concurrency.test.ts`
is the model: two 80.00 withdrawals on a 100.00 balance yield one posted withdrawal and a final
balance of 10.00; a replayed key posts once.

Tracking pixels are excluded from every profile. Browser-based profiles must disable analytics
and media capture of third-party requests; no pixel endpoint is added to the path list.

---

## 7. Execution sequence and evidence record

1. Obtain written owner approval defining environment, window and accepted targets.
2. Provision isolated PostgreSQL and app instance; apply migrations with
   `npm run db:migrate:prod` **against the disposable target only** after confirming the guard
   in `scripts/pg-safety.mjs` (loopback host, `maacash_test*` name, explicit confirmation value).
3. Seed synthetic tenants and accounts; verify no real customer record is present.
4. Run baseline, then load, spike, stress, soak and concurrency in that order. Stop on any §5
   condition; do not continue to "complete" the profile after a stop.
5. Capture: exact command, git HEAD, environment class, workload mix, dataset counts, latency
   percentiles, error breakdown, DB pool/utilisation, provider synthetic responses, stop events,
   and the invariant checks that passed or failed.
6. Publish results with the limitations section filled in. An estimate from a smaller
   environment stays an estimate, not proof (`docs/PERFORMANCE_AND_LOAD_TEST_REPORT.md` §6).

Suggested report fields (no secret values):

```
command:
git HEAD:
environment class (isolated / production-equivalent / local proxy):
registered / active / simultaneous / concurrent values (state each):
dataset counts:
profiles run and stop events:
p50 / p95 / p99 / max per endpoint class:
error rate and status breakdown:
DB pool utilisation and query latency:
provider latency (synthetic only):
invariant checks:
unverified assumptions:
owner approval reference:
```

---

## 8. Tool fit (no new dependencies mandated)

| Tool | Fit | Decision |
| --- | --- | --- |
| `scripts/load-test.mjs` | Built-in Node HTTP, guarded inputs, public paths only | Use as-is for public smoke. Label output as smoke, never capacity |
| k6 | Good for authenticated workflows, think times and staged VU profiles | Optional; adopt only with an approved isolated environment and synthetic data. Not installed today |
| Playwright | Good for client-perceived timing and layout stability under throttling | Use for weak-network scenarios; do not use it as a throughput generator |
| Vitest / `tests/pg-withdrawal-concurrency.test.ts` | Good for deterministic concurrency invariants | Keep as the correctness gate alongside any load profile |

Do not add a load tool, dependency or paid plan as a side effect of this plan. That is an owner
decision with a budget and a named environment.
