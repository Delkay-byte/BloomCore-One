# GitHub final protection verification

Date: 25 November 2026. No live GitHub setting changed.

`Verified in code` local: `.github/workflows/ci.yml` pins every `uses:` to a 40-char
SHA, uses least-privilege `permissions: contents: read`, runs Gitleaks by digest,
dependency review, npm audit, SQLite, PostgreSQL, mobile browser and CodeQL jobs.
`tests/ci-supply-chain-pins.test.ts` → 5/5 passed.

`Unverified` live: branch protection/ruleset on `main`, required PR review,
required checks, secret scanning, push protection, code scanning, Dependabot
alerts and deployment environment protection.

Owner actions: enable the above in repository settings; make these check names
required after they run green: `SQLite generate, lint, typecheck, tests and build`,
`PostgreSQL migration rehearsal and integration tests`, `Mobile browser and
offline-shell tests`, `Secret scan (working tree and full history)`, `CodeQL
static analysis`, `Dependency review and lockfile-aware audit`. Block force
push and deletion; restrict bypass to owner/admin; protect deploy credentials
in an environment requiring approval.

No workflow was pushed; activation is owner action.
