# Performance and load test report — MaaCash

Audited: 25 November 2026. Owner decision for Phase 13: **report limitation only**.
No 1,000-user test was run against live production and no successful 1,000-user
result is claimed.

## 1. Actual baseline

| Item | Verified fact |
| --- | --- |
| Render plan | `free` |
| Web instances | 1 |
| Region | Oregon (web) / Neon `us-east-2` (database) |
| Autoscaling | none |
| Health check | `GET /api/health` returned HTTP 200 on the custom domain |
| Public privacy page | HTTP 200 on recheck after a transient 503 |
| Database connectivity from audit host | TCP 5432 refused (Prisma P1001); app itself is healthy |
| k6 | not installed |
| Load tool used | `scripts/load-test.mjs`, Node built-in HTTP, version 1.0 |

Workloads are not interchangeable: 1,000 registered accounts, 1,000 daily active
users, 1,000 simultaneous sessions, 1,000 concurrent requests and 1,000
near-simultaneous transaction submissions impose very different loads. None of
these has been demonstrated.

## 2. Test environment constraint

A 1,000-user test against live production is prohibited without separate owner
approval. No isolated production-equivalent environment exists. Provisioning one
would require paid infrastructure, which the owner did not authorise for this
phase. Local development uses SQLite and is not a valid proxy for PostgreSQL
connection limits, lock contention or network latency.

`scripts/load-test.mjs` exercises only the unauthenticated public surface
(`/api/health`, `/`, `/pricing`, `/privacy`, `/login`). It does not exercise login,
dashboards, agreement retrieval, risk queries, transaction writes or email. Any
number it produces is a public-surface smoke result, not a capacity finding.

## 3. What was measured

No authenticated, production-equivalent, sustained-load measurement was
performed. The following measurements were *not* obtained: throughput,
requests per second, p50/p95/p99 latency, error rate, timeout rate, CPU or memory
utilisation, database connection utilisation, query latency, queue depth or
provider latency. Absence of evidence is recorded as absence, not as success.

## 4. Identified risks

- Free plan cold starts after inactivity; a sleeping instance cannot serve a
  sudden burst.
- One instance and no horizontal scaling; a process restart drops in-flight work.
- Neon pooler connections are finite; concurrent writes can exhaust them.
- Financial operations rely on database locks and conditional updates under
  read-committed semantics; behaviour under 1,000 concurrent writers is unproven.
- Resend, Cloudflare Turnstile and Paystack have provider-side rate limits that
  were not characterised under load.
- The daily retention sweep and in-process sweeps are not coordinated across
  multiple instances; the single-instance plan currently limits that risk.

## 5. Failure and resilience review (static)

Conditional updates protect duplicate submission, single-use tokens and
concurrent daily-account corrections; unit and PostgreSQL tests cover several of
these paths. The following remain untested at scale: connection exhaustion,
provider outage under concurrent retries, partial failure between the app and a
provider, and restart during a sweep. No destructive test was run against live
data.

## 6. Conclusion

**The current infrastructure cannot be declared ready for 1,000 concurrent
users.** The evidence does not support that claim. What is supported: the service
is healthy at low traffic, configuration fail-closed guards exist, and no
authenticated load test contradicts everyday use by a small pilot group.

To make an evidence-based statement, the owner would need to approve:
1. a paid production instance with multiple instances or a larger plan;
2. an isolated, production-equivalent environment with synthetic data only;
3. an authenticated load tool such as k6 with realistic think times and the
   50/100/250/500/750/1,000 VU progression;
4. database and provider instrumentation for the metrics listed in §3.

Extrapolation from a smaller environment would remain an estimate, not proof.
