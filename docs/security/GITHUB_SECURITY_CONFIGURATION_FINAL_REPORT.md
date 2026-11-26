# GitHub security configuration — final report

Date: 26 November 2026. Repository `Delkay-byte/BloomCore-One` (private).

## Authentication and permissions (`Verified live`)

`gh auth status`: account `Delkay-byte`, token scopes `gist`, `read:org`,
`repo`, `workflow` (value never printed). API reports `admin: true`,
`main` is the default branch.

## Settings attempted / verified

| Setting | Result | Classification |
| --- | --- | --- |
| Rulesets on `main` | API 403: "Upgrade to GitHub Pro or make this repository public" | Unavailable on current plan — Owner action |
| Classic branch protection on `main` | API 403: same plan restriction | Unavailable on current plan — Owner action |
| Secret scanning | API 422: "not available for this repository" | Unavailable on current plan — Owner action |
| Push protection | Disabled with secret scanning | Unavailable — Owner action |
| Code scanning / CodeQL | API 403: not enabled; plan restriction applies | Unavailable — Owner action |
| Dependabot alerts | Disabled; enabling API needs `admin:repo_hook` scope | Owner action (scope/plan) |
| Environments | `main - bik-prestige`, `main - BIK-Prestige-Enterprise`, `main - bloomcore-one`, `main - maacash` exist; reviewed environment had no protection rules | Verified; owner decision on protection rules |

No paid upgrade or scope refresh was performed.

## Local workflow controls (`Verified in code`)

`.github/workflows/ci.yml`: SHA-pinned third-party actions, least-privilege
`permissions: contents: read`, Gitleaks pinned by digest, dependency review and
lockfile-aware audit. `.github/dependabot.yml` prepared. CI supply-chain pin
tests 5/5; full CI-pin scope verified earlier.

## Required check names observed on `main` (`Verified live`)

- `SQLite generate, lint, typecheck, tests and build`
- `PostgreSQL migration rehearsal and integration tests`
- `Mobile browser and offline-shell tests`
- `Secret scan (working tree and full history)`
- `CodeQL static analysis`

These names come from recent successful check runs, not from guesswork. No
required-check configuration was applied because branch protection is
unavailable on the current plan.

## Outcome

No live repository setting was changed: the authenticated plan does not permit
the requested controls. Owner action: upgrade to a plan supporting rulesets and
GHAS, or make the repository public if acceptable, then apply these settings.
