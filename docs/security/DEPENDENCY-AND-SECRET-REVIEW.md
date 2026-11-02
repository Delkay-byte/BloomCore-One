# Dependency and Secret Review

Reviewed 2 November 2026.

## 1. `npm audit --omit=dev`

Three high-severity findings, one dependency chain:

| Package | Version | Path | Exposure |
|---|---|---|---|
| `prisma` | 6.19.3 | direct dependency | CLI/schema tooling |
| `@prisma/config` | 6.x | `prisma` → `@prisma/config` | CLI config parsing |
| `deepmerge-ts` | 8.x | `@prisma/config` → `deepmerge-ts` | Recursive merge in CLI config loading |

Advisory: stack exhaustion when merging recursive object graphs
(GHSA-ggr8-5vv4-36mx).

Reachability assessment:

- The running application imports `@prisma/client`, not `prisma` or
  `@prisma/config`.
- Request handling never merges attacker-controlled objects through
  `deepmerge-ts`.
- The vulnerable code runs only when an operator executes a Prisma CLI command
  against a trusted schema file.
- No application endpoint, server action or background job invokes the CLI.

Conclusion: **not reachable from production request traffic**. Residual risk is
limited to an operator running the CLI on a malicious schema.

Fix: requires Prisma 7 (breaking major). That is a separate planned upgrade, not
an incidental security-release change. `npm audit fix --force` was deliberately
not run.

`npm audit --audit-level=critical` reports **0 critical**; CI gates on this.

## 2. Secret scan of tracked files

| File | Finding |
|---|---|
| `.env.example` | Placeholders only |
| `.env.pilot` | Placeholders only: `DATABASE_URL` contains `CHANGE_ME...`, `JWT_SECRET` is `CHANGE_ME...`. No live credential. |
| `.env.pilot.local` | Not tracked (`.gitignore` includes `.env*.local`) |
| `.env` | Not tracked |
| `render.yaml` | `sync: false` references only; no values |
| `docs/`, `scripts/` | No live secrets found |

Production secrets are configured only in Render. `RATE_LIMIT_HMAC_SECRET`,
`MFA_ENCRYPTION_KEY` and the Turnstile pair were confirmed present without
reading or printing their values.

No credential found in Git history requires rotation. If the placeholder
`.env.pilot` history is considered sensitive, replace it with
`.env.pilot.example`; it contains no usable secret.

## 3. Secret handling in code

- No secret is logged: `src/lib/security/log.ts` allow-lists fields and hashes IP
  addresses with a keyed HMAC.
- MFA secrets are AES-256-GCM encrypted; recovery codes are SHA-256 hashes.
- Administrator recovery codes are SHA-256 hashes at rest and are returned once
  to the issuing administrator.
- Turnstile tokens are hashed in the replay ledger.
- API responses never return MFA secrets, recovery codes or recovery tokens.
