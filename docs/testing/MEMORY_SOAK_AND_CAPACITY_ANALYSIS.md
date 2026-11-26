# Memory soak and capacity analysis

Date: 25 November 2026. Release remains **HELD**.

## 1. Prior measured facts (`Verified in code` from stored evidence)

The previous local SQLite load run reported application RSS:

| Stage | Avg RSS | Peak RSS |
| --- | ---: | ---: |
| Progressive | 374.5 MB | 655.3 MB |
| Peak 1,000 VU | 570.6 MB | 785.0 MB |
| Spike | 592.5 MB | 657.2 MB |
| Soak (100 VU) | 688.0 MB | 726.1 MB |

Source: `docs/LOCAL_1000_VU_LOAD_TEST_RESULTS.md` §6. The run also observed
`TabProofNonce` growth of one row per authenticated request and
`touchSessionRecord()` plus tab-credential writes on every request.

## 2. Interpretation

Growth to ~785 MB during peak did not, by itself, prove a leak: the soak stage
stabilised near 726 MB after warm-up and did not climb without bound within the
observed window. The underlying SQLite driver is synchronous, so per-request
writes block the event loop and are the more likely cause of the connection
refusals seen above 100 VUs. Heap/external split, GC behaviour and recovery
after load were not captured in that run, so a genuine leak is **Unverified**.

## 3. Required controlled soak (not completed in this pass)

A conclusive soak needs: baseline idle RSS/heap, warm-up, steady synthetic
journeys at a sustainable concurrency, a recovery period, and sampling of RSS,
heap used/total, external memory, GC pauses, event-loop lag, open handles,
database pool connections and queue depth. Heap snapshots, if taken, must be
local and synthetic only and must not be committed.

## 4. Capacity statement

The local result does not certify Render or Neon capacity. The planned
PostgreSQL repeat is documented in
`docs/testing/LOCAL_POSTGRESQL_1000_VU_RESULTS.md`. No SLO exists for MaaCash,
so no pass/fail latency target is asserted; measured facts only.
