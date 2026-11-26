# GitHub security and branch protection runbook

Date: 25 November 2026. No push, merge or GitHub settings change was made.
Workflow files below are prepared locally only.

## 1. Prepared locally (`Verified in code`)

`.github/workflows/ci.yml`:

- Least-privilege default `permissions: contents: read`.
- All third-party actions pinned to verified full commit SHAs:
  - `actions/checkout` `11bd719…` (v4.2.2)
  - `actions/setup-node` `49933ea…` (v4.4.0)
  - `actions/upload-artifact` `ea165f8…` (v4.6.2)
  - `github/codeql-action` init/autobuild/analyze `018511a…` (v3.28.13)
  - `actions/dependency-review-action` `595b5ae…` (v4.7.3)
- Gitleaks image pinned by digest
  `sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854`
  (v8.28.0), full reachable history, `--redact`, no verbose finding values.
- New `dependency-review` job on pull requests, scheduled weekly and manual;
  lockfile-aware `npm audit --omit=dev --audit-level=high`.
- Existing SQLite, PostgreSQL, mobile browser, secret-scan and CodeQL jobs
  retained. CodeQL SARIF remains an artifact because central code scanning is
  not verified as enabled.

`.github/dependabot.yml` prepared for npm and GitHub Actions, weekly Monday in
`Africa/Accra`.

## 2. Exact check names for required checks (`Verified in code`)

Job names in `ci.yml` become the commit check names:

1. `SQLite generate, lint, typecheck, tests and build`
2. `PostgreSQL migration rehearsal and integration tests`
3. `Mobile browser and offline-shell tests`
4. `Secret scan (working tree and full history)`
5. `CodeQL static analysis`
6. `Dependency review and lockfile-aware audit`

Do not make a check required until it has run successfully on the target
repository and the exact name is confirmed in the check list.

## 3. Owner actions (`Owner action`, settings not changed)

1. Settings → Branches → Rulesets (or classic protection) on `main`:
   - Require a pull request before merging.
   - Require the verified checks listed above.
   - Block force pushes and branch deletion.
   - Require conversation resolution where supported.
   - Restrict bypass to the repository owner/admin only.
   - Require one review if a second trusted reviewer exists; do not create an
     impossible approval rule for a single-maintainer workflow.
   - Do not require deployment success while the release is held.
2. Settings → Code security and analysis:
   - Enable secret scanning and push protection if the plan supports them.
   - Enable Dependabot alerts and security updates.
   - Enable code scanning (CodeQL) and SARIF upload if the plan supports it.
   - Verify the Security tab shows results; a workflow file alone is not proof.
3. Actions → General: limit Actions permissions to repository defaults with
   read-only `GITHUB_TOKEN`, allow only the actions used above, and require
   approval for first-time contributors.
4. Environments: create a protected environment for deployment credentials,
   with owner approval required. Do not expose deploy secrets to pull requests
   from forks.
5. After all checks have run green, add them as required checks and test that
   a direct push to `main` by a non-admin is rejected.

## 4. Status

Workflows: prepared locally, not pushed. Branch protection: `Unverified`.
Secret scanning / push protection: `Unverified`. Code scanning: `Unverified`.
Dependabot alerts: `Unverified`. Plan entitlement: `Unverified`.
