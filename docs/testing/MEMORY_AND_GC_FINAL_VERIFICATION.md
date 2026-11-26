# Memory and garbage-collection final verification

Date: 26 November 2026. Release HELD. Local PostgreSQL 18.6, synthetic data.

## Instrumentation

A gated sampler in `src/instrumentation-node.ts` writes aggregate
`process.memoryUsage()`, active-handle count and GC performance entries to a
file inside `tests/` only when `APP_ENV=LOCAL_LOAD_TEST`,
`MAACASH_LOAD_MEM_SAMPLE=1` and the output path is inside `tests/`. The server
is started with `--expose-gc`. No heap snapshot or sensitive value is written.

## Measurements

Idle baseline: RSS 173.6 MB, heap used 87.9 MB, heap total 114.1 MB,
external 8.1 MB, 2 active handles.

During progressive load to 1,000 VUs: RSS max 970.4 MB, heap used max
785.4 MB, external max 53.3 MB, active handles up to 445, GC entries capped at
the retained 500-sample window with max pause 94.8 ms.

10-minute soak at 50 VU (492 samples, 12,416 requests, p95 915.49 ms):

| Point | RSS MB | Heap used MB | Heap total MB | External MB | Handles |
| --- | ---: | ---: | ---: | ---: | ---: |
| Start | 173.6 | 87.9 | 114.1 | 8.1 | 2 |
| 25% | 885.1 | 473.9 | 766.0 | 24.1 | 317 |
| 50% (post-GC) | 745.6 | 126.8 | 167.0 | 9.3 | 20 |
| 75% | 305.2 | 125.3 | 176.8 | 10.2 | 22 |
| End | 302.0 | 135.2 | 167.3 | 10.5 | 1 |

GC pauses reached ~263 ms at peak but settled to ~15 ms. Active handles fell
from 317 to 1. Heap and RSS **stabilised after garbage collection**; no
unbounded growth. The 478 soak failures were HTTP 400 business validation on
duplicate daily contributions, not transport errors.

## Conclusion

**Verified; no memory leak demonstrated.** No retaining-object fix required.
Raw sample files stay in `tests/pg-load-artifacts/` and are not committed.
