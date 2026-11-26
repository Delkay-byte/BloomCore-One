# Controlled PostgreSQL memory soak — final results

Date: 26 November 2026. Release HELD.

## Method

The validated Node generator drove a 50-VU, 10-minute synthetic workload at
21.05 RPS against the disposable PostgreSQL 18.6 instance (12,628 requests).
`monitor.mjs` sampled the application process every 2 seconds (249 samples),
starting immediately after a 1,000-VU spike so recovery could be observed.

## Measurements

| Point | RSS |
| --- | ---: |
| Progressive average / peak | 437.6 / 877.1 MB |
| Peak 1,000-VU average / max | 886.0 / 1,229.4 MB |
| Spike average / max | 1,374.2 / 1,555.9 MB |
| Soak first sample | 1,076.0 MB |
| Soak 25% / 50% / 75% | 677.9 / 421.4 / 274.3 MB |
| Soak final sample | 228.0 MB |
| Soak average / max | 516.6 / 1,077.7 MB |

Database counters grew monotonically with legitimate synthetic activity
(`TabProofNonce` 53,085 → 65,713; drafts 559 → 1,037) while RSS fell by ~848 MB.

## Conclusion

Memory **stabilised and was released** after load; no unbounded growth was
observed. The earlier ~785 MB peak is explained by heap retention under spike
load, not a proven leak. Heap used/total, external memory, GC pause details,
event-loop lag, open handles and live DB pool occupancy were not instrumented;
those remain `Unverified`. No heap snapshot was committed.

Status: **Verified; no leak demonstrated**. No code fix required.
