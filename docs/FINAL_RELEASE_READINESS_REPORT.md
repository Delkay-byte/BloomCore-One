# Final release readiness report — MaaCash

Date: 26 November 2026. Preserves earlier reports. Release **HELD**.

Nothing in this task pushed, merged, deployed, applied a production migration,
ran production retention/load, restored production Neon or changed live
Cloudflare, Render, GitHub or Neon settings.

## 1. Baseline

Branch `feat/maacash-momag-readiness`, HEAD `7192f9890df5b1b856b0b0e085c25def9b7e6393`, `origin/main` 0 behind / 90 ahead. Pre-existing dirty entries preserved; no reset or destructive rebase.

## 2. Previously completed fixes reverified

Targeted regression: **7 files, 69 tests passed** after all optimisations, covering the RSC proof shim, provider-timeout application path, retention cross-process lease, export rate limits, trusted-proxy spoofing, retired DPO alias and CI pinning. PostgreSQL integration suite **44/44**; full SQLite suite **1,869/1,869**. All fixes remain present.

## 3. PostgreSQL 1,000-VU results and optimisation

Local PostgreSQL 18.6, real Prisma adapter and 70 migrations, 1,000 independent synthetic role identities. Generator saturation max 0.033 — not the bottleneck. A verified P2028 pool exhaustion at the default pg pool of 10 was corrected with bounded `PG_POOL_MAX` (default unchanged; run used 60). Slow-query logging exposed duplicate `TabProofNonce` inserts; amortised session-activity writes and a request-id-scoped nonce dedupe cache removed that error storm. See `docs/testing/POSTGRESQL_CAPACITY_OPTIMISATION_REPORT.md`.

Final results: 50 VUs p95 134.01 ms / 0 failures; 100 VUs p95 195.04 ms / 0; 500 VUs p95 8,102.53 ms / **0 failures**; 1,000 VUs p95 17,401.34 ms / 2,112 failures of 3,014 requests. Soak at 50 VU for 10 min: 12,416 requests, p95 915.49 ms, 478 HTTP 400 business-validation failures and no transport failures.

Verdict: **1,000 VUs not sustained**. Highest clean concurrency improved from 50 to **500 VUs**. Limiting system is the single local application host under transport timeouts. Local results do not certify Render/Neon capacity. `docs/testing/POSTGRESQL_1000_VU_FINAL_RESULTS.md`.

## 4. Memory and GC

Gated heap/GC sampling (local load runtime only) during a 10-minute soak: RSS 885→302 MB, heap used 474→127 MB, external 24→10 MB, active handles 317→1. GC pauses up to ~263 ms at peak, ~15 ms at the end. Memory stabilised after collection; no leak demonstrated. Details: `docs/testing/MEMORY_AND_GC_FINAL_VERIFICATION.md`.

## 5. Cloudflare protection

No authenticated account access. DNS/WAF/bot/rate-limit/alert state **Unverified**. Exact owner runbook: `docs/security/CLOUDFLARE_FINAL_CONFIGURATION_AND_VERIFICATION.md`. No live change.

## 6. Render origin / offline sync

Custom domain is canonical, but installed clients may reference `maacash.onrender.com`; disabling the hostname is **Owner action required**. Cloudflare does not generate the custom HMAC header automatically; a Worker code sketch and secret-binding steps are prepared in `docs/security/RENDER_ORIGIN_OFFLINE_SYNC_FINAL_RUNBOOK.md`. Not deployed.

## 7. GitHub security

Local workflows verified: SHA-pinned actions, least privilege, Gitleaks digest, dependency review, 5/5 CI-pin tests. Live branch protection, required checks, secret/push protection, code scanning and environments **Unverified** — exact owner instructions in `docs/security/GITHUB_FINAL_SECURITY_VERIFICATION.md`.

## 8. Deployment smoke

Six read-only checks in `e2e/deployment-smoke.spec.ts` remain unexecuted; no authorised staging exists. **Deployment-stage verification required**. Each check is classified in `docs/testing/DEPLOYMENT_SMOKE_FINAL_RESULTS.md`.

## 9. Neon provider restore

Local `pg_dump`/`pg_restore` drill passed (138 tables, 138 PKs, 176 FKs, 553 indexes). Provider PITR/branch restore **Owner action required**; runbook at `docs/operations/NEON_PROVIDER_RESTORE_FINAL_RUNBOOK.md`.

## 10. Full regression

Typecheck pass; lint 0 errors / 151 warnings; full SQLite 1,869/1,869; PostgreSQL 44/44; targeted 80/80; RSC browser 4/4 with five consecutive clean writes; provider path 6/6. E2E clean runs after all optimisations: **125 passed, 0 failed, 0 flaky, 0 skipped (12.4 min; 12.0 min)**. Deployment-smoke results are not counted.

## 11. Risk register

Critical: none demonstrated. High: none demonstrated. Medium: 1,000-VU capacity gap; provider-only security settings; Render offline-sync compatibility. Low: deployment smoke unexecuted; Neon provider restore; heap/GC detail. Informational: completed owner items (Neon key revocation, recovery email, counsel/DPIA/DPO/DPS removal) not reopened.

## 12. Owner actions

Verify/configure Cloudflare; decide Render origin migration and bind Worker secret; enable GitHub branch protection and scanning; execute Neon provider restore drill; run deployment smoke at authorised staging; review capacity evidence and hosting decision; separately authorise release.

## 13. Release decision

**ENGINEERING INCOMPLETE — RELEASE HELD**

Material verification (production-equivalent capacity, provider security settings, provider restore, deployment smoke) remains outstanding.
