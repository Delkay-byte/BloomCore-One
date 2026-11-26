# GitHub and supply chain audit — MaaCash / BIK Prestige Enterprise

**Date:** 2026-11-25. **Method:** read-only `gh` queries, source review of `.github/workflows/ci.yml`, `.gitleaksignore`, `.gitignore`, `package.json` and `package-lock.json`. **Standard:** BloomCore v1.0 (`BC-SEC-STD-001`), sections 8, 9, 11. **No setting change, push, merge, deploy, dependency install or scan that modifies data was performed. No token values are reproduced.**

## Verified repository state

| Query | Result |
|---|---|
| `gh repo view --json ...` | `Delkay-byte/BloomCore-One`, `visibility: PRIVATE`, `isPrivate: true`, `isFork: false`, `defaultBranchRef: main`, `isSecurityPolicyEnabled: true`, viewer `ADMIN`. |
| `gh api repos/Delkay-byte/BloomCore-One/collaborators` | One collaborator: `Delkay-byte`, `admin: true`. No other direct collaborators returned. |
| `gh api repos/.../branches` | `main` reported `"protected": false`. All listed branches reported `protected: false`. |
| `gh api repos/.../branches/main/protection` | HTTP 403: "Upgrade to GitHub Pro or make this repository public to enable this feature." |
| `gh api repos/.../rulesets` | HTTP 403, same plan limitation. Ruleset existence cannot be confirmed or denied via this token. |
| `gh api repos/.../secret-scanning/alerts` | HTTP 404: "Secret scanning is disabled on this repository." |
| `gh api repos/.../code-scanning/alerts` | HTTP 403: "Code scanning is not enabled for this repository." |
| `gh api repos/.../actions/permissions` | `{"enabled":true,"allowed_actions":"all","sha_pinning_required":false}`. |
| Lockfile | `lockfileVersion: 3`; `npm ci` used in every CI job. Resolved versions: `next` 16.4.6, `react`/`react-dom` 19.2.8, `@prisma/client`/`prisma` 7.10.1, `jose` 6.2.10, `bcryptjs` 3.0.3, `zod` 4.6.7, `better-sqlite3` 13.0.3, `vitest` 4.1.11, `eslint` 9.39.5. Overrides pin `brace-expansion`, `js-yaml` 4.3.2 and `vite` 8.2.6. |

## CI pipeline summary (`.github/workflows/ci.yml`)

Triggers: push to `main`, `security/**`, `release/**`; PR to `main`; `workflow_dispatch`.

- `sqlite-verify`: `npm ci`, Prisma generate, disposable SQLite `db push`, lint, typecheck, `npm audit --audit-level=critical`, `npm test`, production build.
- `postgres-verify`: disposable `postgres:16-alpine` service, `npm ci`, `migrate deploy`, `migrate status`, `migrate diff --exit-code`, `vitest run --config vitest.pg.config.ts`.
- `mobile-browser`: Playwright Chromium mobile project.
- `secret-scan`: full-history Gitleaks via `docker run ... zricethezav/gitleaks:latest`, plus `.gitignore` assertions for secret files.
- `codeql`: `codeql-action/init@v3`, autobuild, analyze to local SARIF with `upload: never`, artifact upload. Workflow comment states code scanning is not enabled on the repository.

## Findings

### GH-01 — CI can execute unpinned third-party actions

- **Severity:** Medium.
- **Affected component/config:** `.github/workflows/ci.yml`; repository Actions settings.
- **Evidence:** Every action is referenced by mutable tag: `actions/checkout@v4`, `actions/setup-node@v4`, `github/codeql-action/{init,autobuild,analyze}@v3`, `actions/upload-artifact@v4`. API reports `allowed_actions: "all"` and `sha_pinning_required: false`. The secret-scan job runs `zricethezav/gitleaks:latest` from Docker Hub.
- **Realistic abuse scenario:** A maintainer account or upstream action repository is compromised and a tag is moved; the next CI run executes changed code with access to repository contents and any workflow secrets.
- **Impact:** Potential CI secret theft or artifact poisoning and a path to production supply-chain compromise.
- **Recommended fix:** Pin all actions to full commit SHAs, restrict allowed actions to the required allowlist, enable SHA pinning requirement where the plan supports it, and pin the Gitleaks image by digest. Review Dependabot/action update PRs before merge.
- **Owner action required:** Change repository Actions policy and approve a CI file update. This audit made no changes.
- **Regression test / verification:** Assert every `uses:` line contains a 40-character SHA and the Gitleaks image uses an immutable digest; run CI once after the change.
- **Status:** verified.

### GH-02 — GitHub secret scanning and code scanning are disabled

- **Severity:** Medium.
- **Affected component/config:** Repository security settings; `.github/workflows/ci.yml` `codeql` job.
- **Evidence:** Secret scanning API returns 404 disabled; code scanning API returns 403 not enabled; the workflow explicitly sets `upload: never` and uploads SARIF only as an artifact. Gitleaks runs in CI, which is a compensating control with full history and `--redact`.
- **Realistic abuse scenario:** A real credential is committed to a branch that does not trigger the current push patterns or a new provider token format appears; no GitHub-level alert or push protection blocks it.
- **Impact:** Slower detection of secret exposure; no central code-scanning findings queue.
- **Recommended fix:** Enable secret scanning and push protection if available on the plan; enable code scanning upload so SARIF is visible in the Security tab. Keep Gitleaks as an independent check with narrow, dated suppressions.
- **Owner action required:** Owner must enable settings in GitHub UI (plan permitting) and confirm availability. No settings were changed.
- **Regression test / verification:** Security tab shows secret scanning/push protection enabled; a synthetic test secret in a disposable branch is blocked or alerted (use a fake value only).
- **Status:** verified.

### GH-03 — Branch protection and rulesets cannot be confirmed; classic protection off for `main`

- **Severity:** Medium (evidence gap).
- **Affected component/config:** `main` branch; repository rules.
- **Evidence:** `branches` API reports `main` `"protected": false`. Direct protection and rulesets endpoints return HTTP 403 with a plan upgrade message, so rulesets may exist but cannot be verified with this token.
- **Realistic abuse scenario:** A direct push to `main` bypasses review and required CI checks; `autoDeploy: true` on Render then deploys unreviewed code.
- **Impact:** Unreviewed production deployment path if no ruleset exists.
- **Recommended fix:** Require at least one approving review, required status checks (`sqlite-verify`, `postgres-verify`, `secret-scan`, `codeql`), dismissal of stale approvals, and no direct pushes to `main` via a ruleset or classic protection.
- **Owner action required:** Inspect Settings → Rules/Rulesets in the GitHub UI and record the result. This is the single most important owner check in this audit.
- **Regression test / verification:** From a disposable non-admin identity, attempt a direct push to `main`; it must be rejected. Confirm required checks are listed on a test PR.
- **Status:** classic protection **verified absent**; ruleset state **unverified** (API 403).

### GH-04 — Dependency and DAST gates are narrower than the standard

- **Severity:** Low.
- **Affected component/config:** `.github/workflows/ci.yml`; `.github/` workflow inventory.
- **Evidence:** Only `ci.yml` exists. `npm audit --audit-level=critical` fails only critical advisories; high/moderate require triage outside CI. No dependency-review action, no SBOM generation, no DAST job, no accessibility smoke job in the workflow. The standard's default merge gate (§11) recommends these layers, with DAST against safe staging.
- **Realistic abuse scenario:** A high-severity transitive vulnerability or a designed-in access-control regression merges without a blocking signal.
- **Impact:** Reduced supply-chain and release assurance; compensating controls exist (CodeQL SARIF, Gitleaks, full unit suite, Playwright mobile project, DB migration rehearsal).
- **Recommended fix:** Add dependency review for PRs, SBOM generation for release artifacts, and a scheduled DAST/accessibility job against isolated staging with narrowly triaged suppressions. Do not block on every unverified scanner finding.
- **Owner action required:** Approve pipeline scope changes and staging budget; no changes made here.
- **Regression test / verification:** Confirm new jobs appear as required checks and that an intentionally vulnerable fixture (synthetic) fails the dependency gate.
- **Status:** verified.

### GH-05 — Secret hygiene in tracked files

- **Severity:** Informational (positive control with one note).
- **Affected component/config:** `.gitignore`, `.gitleaksignore`, `.env.example`, `render.yaml`.
- **Evidence:** `.gitignore` excludes `.env`, `.env.*`, `*.env`, `.secrets/`, `*.key`, `*.db` and allows only `*.example` templates. `render.yaml` marks `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, provider keys and signing secrets `sync: false`. `.env.example` contains variable names/placeholders only. `.gitleaksignore` contains nine narrowly pinned historical fingerprints (commit hash + file + rule + line) described as test fixtures; no broad wildcard suppression. Source scan for provider key prefixes found only prefix checks (`paystackKeyMode` at `src/lib/payments/paystack.ts:122-126`) and a comment, not secret values.
- **Realistic abuse scenario:** A developer commits a `.env` or pastes a live provider key into source.
- **Impact:** Ignore rules and CI Gitleaks reduce risk; history rewrites would still be required if a real secret were ever committed.
- **Recommended fix:** Keep ignores and pinned suppressions; review any new `.gitleaksignore` entry for expiry and justification.
- **Owner action required:** None.
- **Regression test / verification:** CI secret-scan job already asserts secret files are ignored and runs full-history Gitleaks.
- **Status:** verified.

### GH-06 — Release evidence is incomplete for a clean gate

- **Severity:** Low.
- **Affected component/config:** `.tmp-final-test2.log`, `.tmp-e2e-clean.log`; BloomCore §11.1.
- **Evidence:** Unit suite final log: `157 passed (157)` files, `1828 passed (1828)` tests. E2E clean log: `5 failed`, `111 passed (19.1m)`. An earlier unit log had 5 failures that were later fixed. Full E2E pass is **not** established.
- **Realistic abuse scenario:** Release approved on unit-test green while five browser journeys remain broken.
- **Impact:** Process risk; not evidence of a specific vulnerability.
- **Recommended fix:** Triage and fix the five E2E failures or record written risk acceptance with owner and expiry before release.
- **Owner action required:** Product owner sign-off on exceptions.
- **Regression test / verification:** Attach an E2E run summary from the release candidate.
- **Status:** verified.

## Explicit unknowns

- GitHub plan limits prevented reading branch protection and rulesets; this is the main unresolved control.
- No `npm audit`, SCA tool or secret scan was executed by this audit; CI configuration was inspected, not re-run.
- Collaborators via org/team membership were not enumerated; only direct collaborators were queried. Team-based access remains **unverified**.
- Deploy keys, webhooks, GitHub Apps, environment protection rules and runner configuration were not queried.

## Conclusion

Repository is private with a security policy and a single admin collaborator. CI is substantial (lockfile install, lint/typecheck, unit tests, Postgres migration rehearsal, Gitleaks full history, CodeQL artifacts). The two Medium items needing owner action are unpinned CI actions plus disabled GitHub scanning (GH-01/GH-02) and unconfirmed branch protection (GH-03).
