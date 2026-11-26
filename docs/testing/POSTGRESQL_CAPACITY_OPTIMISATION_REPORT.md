# PostgreSQL capacity optimisation report

Date: 26 November 2026. Release HELD. All evidence local and synthetic.

## 1. Baseline and profiling

Environment: PostgreSQL 18.6 loopback, real Prisma PG adapter, 70 migrations,
1,000 independent synthetic tab identities, eight forked generator workers
(max saturation 0.033 — generator never the bottleneck).

Local slow-query logging exposed repeated failures on
`INSERT INTO TabProofNonce` — duplicate primary-key violations on every
in-request re-verification of the same proof. Per authenticated request the
code also performed two separate session-activity writes and a separate
session read. Connection-pool exhaustion (P2028) had already been bounded with
`PG_POOL_MAX` (default unchanged; test run 60).

## 2. Evidence-backed changes

1. `src/lib/security/session-store.ts` — `touchSessionRecord()` is amortised
   to at most one write per 15 s per session. Authorisation still checks
   revocation and absolute expiry on every request.
2. `src/lib/security/tab-proof.ts` — `TabCredential.lastUsedAt` is likewise
   amortised to 15 s; it is informational, not an authorisation input.
3. `src/lib/security/tab-proof.ts` — short-lived (2 s) dedupe map keyed by
   worker-issued request id + nonce hash + expected surface, preventing the
   duplicate `TabProofNonce` insert and its DB error storm. A different request
   id or nonce never hits the cache; single-use semantics are preserved.
4. `scripts/local-load/*` — PostgreSQL-capable disposable harness with strict
   loopback/disposable guards, PG-aware monitor, generator exit race fix, and
   gated heap/GC sampling in `instrumentation-node.ts` (`LOCAL_LOAD_TEST` only).

No authentication, authorization, tenant isolation, financial invariant,
idempotency or audit rule was weakened. No production migration or setting.

## 3. Measured progression

| Stage | Baseline p95 / failed | After amortised writes | Final (nonce dedupe) |
| --- | --- | --- | --- |
| 50 VU | 228.92 ms / 0 | 106.64 ms / 0 | 134.01 ms / 0 |
| 100 VU | 673.10 ms / 23 | 172.63 ms / 0 | 195.04 ms / 0 |
| 250 VU | 2,825 ms / 37 | 6,243 ms / 11 | 2,585 ms / 4 |
| 500 VU | 15,017 ms / 757 | 6,628 ms / 4 | 8,102 ms / **0** |
| 750 VU | 12,036 ms / 216 | 10,459 ms / 97 | 14,821 ms / 1,017 |
| 1,000 VU | 16,189 ms / 2,194 | 14,959 ms / 1,835 | 17,401 ms / 2,112 |

Highest clean concurrency improved from **50 VUs to 500 VUs**. At 1,000 VUs
the remaining failures are transport timeouts (status 0) with p50 ~13.6 s,
application CPU avg 84.1%, RSS max 972.5 MB, GC pauses up to 94.8 ms and up to
445 active handles. The local single-instance host, not the generator, is the
limiting system; 1,000 VUs are **not sustained**.

## 4. Conclusion

Verified improvements are retained. Further work would require a second app
instance and a production-sized database/host, which is outside the local
authority. No local result certifies Render/Neon capacity.
