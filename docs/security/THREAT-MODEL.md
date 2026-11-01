# BloomCore One — Threat Model

## 1. Assets

1. Tenant administrator, worker, collector and customer credentials.
2. Platform operator credentials and platform configuration.
3. Customer PII (name, phone, email, address, customer/account numbers).
4. Financial records: contributions, withdrawals, commissions, card fees,
   remittances, daily MoMo account figures.
5. Tenant isolation: each business's records must remain invisible to others.
6. Audit trails and session state.
7. Integration secrets (database, JWT, Turnstile, MFA encryption, HMAC).

## 2. Actors

| Actor | Capability |
|---|---|
| Anonymous internet user | Can reach marketing pages, login, recovery, health |
| Authenticated worker | MoMo daily operations within own tenant |
| Authenticated collector | Susu collections for assigned customers |
| Tenant administrator | Full tenant administration, financial approval |
| Customer | Own portal records only |
| Platform operator | All tenants, provisioning, suspension |
| Compromised browser / stolen cookie | Whatever the stolen session allows |
| Malicious tenant administrator | Attempts cross-tenant access or financial manipulation |

## 3. Threats and mitigations

| ID | Threat | Path | Mitigation | Residual |
|---|---|---|---|---|
| T-01 | Credential stuffing / brute force | `/login`, `/admin/login`, `/platform/login` | Persistent per-IP limits, progressive 1/5/15-minute cooldown, Turnstile, generic errors, dummy bcrypt for unknown accounts | Distributed botnets below thresholds; Turnstile must be enabled |
| T-02 | Account enumeration | Login, recovery | Identical responses, state checks after password, comparable timing | Response-size/timing differences from infrastructure remain possible |
| T-03 | Account denial of service by locking an email | Login | Cooldown is primarily pair-scoped; account-wide threshold is 30 and capped at 15 minutes | An attacker can still cause short, repeatable refusals |
| T-04 | Stolen session cookie | Any authenticated route | HttpOnly/Secure/SameSite, short absolute lifetime, `SessionRecord` revocation, tokenVersion | A stolen token remains valid until revoked or expiry |
| T-05 | Cross-tenant ID substitution | Server actions and APIs | Tenant resolved from session, every referenced ID checked with `assertTenantEntity`, cross-tenant tests | Future code must keep using the guard |
| T-06 | Tenant admin reaches platform console | `/platform/*` | Separate cookie, separate table, `kind`/`tokenType` claims, platform-only guard | None known |
| T-07 | Forged/edited JWT claims | Cookie | HS256 signature, issuer/audience/use claims, DB status + tokenVersion + registry checks | `JWT_SECRET` compromise breaks everything; rotate only with a migration plan |
| T-08 | Financial replay / double submit | Contributions, withdrawals, offline sync | Unique `referenceId`, client idempotency keys, reservation before money moves, single transaction | UI does not yet send an idempotency key for every form |
| T-09 | Race condition on withdrawal balance | Withdrawal | Single transaction, conditional commission claim, in-transaction aggregates | PostgreSQL read-committed can still interleave two withdrawals; a per-account advisory lock or serializable isolation is a follow-up |
| T-10 | Malicious offline payload | `/api/offline/sync-contribution` | Same-origin check, device+user+tenant binding, channel authorization, whole-day amount validation, tenant-scoped account lookup | Device compromise still allows valid-looking collections |
| T-11 | XSS | All user-controlled fields | React escaping, CSP, server-side schema validation | `unsafe-inline` weakens CSP; no HTML rendering of user input was found |
| T-12 | CSRF | Cookie-authenticated mutations | Server actions validate Origin (framework), API mutations use `isSameOriginRequest`, SameSite cookies | Forms with no Origin and no Fetch Metadata are rejected |
| T-13 | SQL injection | Prisma queries | Parameterised Prisma client; no string-concatenated SQL except `SELECT 1` | Raw SQL must be reviewed if added |
| T-14 | Open redirect | Login redirects | Redirect targets are fixed literals, never request parameters | — |
| T-15 | MFA bypass via alternate login | All login entry points | MFA step is applied inside shared resolvers and every dedicated login action; challenge cookie is separate and short-lived | A future login route must call `beginMfaStepIfRequired` |
| T-16 | Turnstile bypass | Login/recovery | Server-side Siteverify, hostname/action/time checks, single-use token ledger, fail-closed on timeout | If `TURNSTILE_ENABLED=false`, no challenge is required by design |
| T-17 | Secret leakage via logs | Security logging | Allow-listed fields, keyed IP fingerprints, no bodies/tokens | Application `console.error` paths must be reviewed when adding features |
| T-18 | Privilege escalation by worker/collector | Admin actions | `requireTenantAdmin`, role checks, capability checks after password | Enum status inputs are only partially validated (M-03) |
| T-19 | Suspended tenant keeps access | Tenant routes | `getTenantContext` requires `status === ACTIVE` | Sessions stay in the browser but every request resolves to denial |
| T-20 | Supply-chain compromise | npm dependencies | Lockfile, `npm audit` in CI (critical), review before upgrades | Prisma CLI advisory remains; no automated dependency updates configured |

## 4. Out of scope / assumptions

- Render and Cloudflare infrastructure are trusted to set client-IP headers.
- Neon is trusted to protect the database at rest and in transit.
- The owner controls who holds platform operator credentials.
- Email delivery is not implemented, so reset-token delivery is blocked.
- No formal data-classification policy exists for log retention; see the runbook.
