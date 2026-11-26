# Baseline before final remediation — 25 November 2026

Evidence captured **before** any source change in this remediation. No production
target was contacted. No secret value appears in this file.

## 1. Git baseline (`Verified in code`)

| Item | Value |
| --- | --- |
| Repository | `https://github.com/Delkay-byte/BloomCore-One.git` (`Verified in config`) |
| Working repository | `C:\Users\SAVIOUR\Documents\DScience\BIK Prestige Ent\BloomCore-One` |
| Branch | `feat/maacash-momag-readiness` |
| HEAD | `7192f9890df5b1b856b0b0e085c25def9b7e6393` |
| `origin/main` | `92d6d974e1e41d7b0586e823f9c000a0a7fe0925` |
| Relationship | 0 behind, 90 ahead |
| Dirty entries | 129 modified/untracked/deleted entries, all pre-existing work preserved |

The other candidate worktrees (`BloomCore-One-zeli`, `Momo module`,
`BloomCore-Engineering-Standards`) are separate checkouts and were not used as
the implementation target.

## 2. Pre-change command results

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass (exit 0) |
| `npm run lint` | result recorded in `.tmp-baseline-lint.log`; prior report: 0 errors, 151 warnings |

## 3. State reported by the previous addendum (`Verified in code`)

- E2E: 121 passed, 0 failed, 0 flaky, 6 skipped, twice from clean states.
- Full unit suite: 1,834 passed.
- k6: not installed. Local generator used SQLite only; 50 VUs sustainable;
  1,000 VUs not sustained.
- Retention F5 open: in-process overlap guard only.
- Provider timeout scenario unverified; no injectable provider endpoint.
- Six E2E skips are deployed-origin-only checks in `e2e/custom-domain.spec.ts`.
- Release status: HELD.

## 4. Pre-change code facts confirmed by inspection

- `src/app/api/internal/risk-intelligence/retention/route.ts:21` — module-level
  `sweepInProgress` flag; no database-backed lease.
- `src/lib/actions/risk-governance.actions.ts:2424` — `executeRetentionSweep()`
  is the single mutation entry for both the scheduler and privacy-admin actions.
- `src/lib/security/client-ip.ts:51-71` — `CF-Connecting-IP` is trusted whenever
  `TRUSTED_PROXY_HEADERS=true`; `X-Forwarded-For` and `X-Real-IP` are ignored.
- `render.yaml:13-15` — default `maacash.onrender.com` host deliberately kept
  reachable for offline-device sync; `render.yaml:79-80` enables trusted proxy.
- Three export routes have no rate limit: `/api/zeli/analytics/export`,
  `/api/association/export`, `/api/audit`.
- Only `.github/workflows/ci.yml` exists. Actions are tag-pinned, not SHA-pinned;
  CodeQL SARIF upload is `never`; no Dependabot config.
- Local Docker daemon v29.9.2; `postgres:18-alpine` image available. Production
  database engine is Neon PostgreSQL 18.6 (`docs/NEON-RENDER-DEPLOYMENT.md:22`).

## 5. Constraints carried into the work

Release remains HELD. No push, merge, deploy, production migration, production
retention execution, production load test or live provider setting change is
authorised. Counsel/DPIA/DPO/DPS approval is removed by owner direction and is
not reopened.
