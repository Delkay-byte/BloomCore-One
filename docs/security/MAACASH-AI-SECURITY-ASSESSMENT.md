# MaaCash AI-Assisted Application Security Assessment

**Date:** 2026-11-16
**Subject commit:** `d4e153a1b5d82d5d66146a85790e012fba26ef72` (`fix(auth): enforce MFA before password upgrades and complete migration scope`)
**Reviewed branch:** `feat/auth-email-verification-password-upgrade`
**Repository:** BloomCore-One (MaaCash), Next.js 16 App Router, Prisma, PostgreSQL
**Report author:** Automated AI agent (DeepSeek V4.1 Flash 1010) operating under the OpenCode harness.

## Important status statement

This is an **AI-assisted assessment performed by an automated agent**. It is **NOT an independent human penetration test**, **NOT a certification**, and **NOT an audit**. It is a static, code-and-configuration review augmented by `npm audit`. Findings marked `confirmed` have direct code evidence; findings marked `suspected` require runtime, infrastructure or concurrency proof that this review could not obtain.

No application code, test, configuration or migration was modified. The only file created is this report.

## 1. Scope

Reviewed at commit `d4e153a`:

1. Authentication and account lifecycle: `src/lib/actions/auth.actions.ts`, `src/app/login`, `src/app/admin/login`, `src/app/customer`, `src/app/platform/login`, `src/lib/auth.ts`, `src/lib/platform-auth.ts`, `src/middleware.ts`.
2. MFA: `src/lib/security/mfa.ts`, `mfa.actions.ts`, `mfa-challenge.ts`, `mfa-login.ts`, `session-store.ts`, `src/components/security/*`, TOTP step replay (`mfaLastTotpStep`), recovery codes.
3. Sessions: `SessionRecord`, `tokenVersion`, tab credentials and nonces, timeouts, revocation, `tab-proof.ts`, `tab-assertion.ts`, `tab-session-client.ts`.
4. Tokens: `account-tokens.ts`, `password-recovery.actions.ts`, `email-verification.actions.ts`, `password-change-challenge.ts`, `password-policy.ts`.
5. Mandatory upgrade enforcement: every login path, MFA completion, workspace selection/switch, platform SSO callback and `oidc-login.ts`.
6. Tenant isolation / IDOR / BOLA: every `src/lib/actions/*.ts` file, tenant scoping, cross-tenant reads/writes, customer portal access.
7. Role escalation and platform boundaries: `PlatformSuperAdmin` separation, platform vs tenant sessions, module capability checks, `access-links.ts`.
8. Financial integrity: daily accounts, Susu contributions/withdrawals/remittances, reversals/corrections, authorization, idempotency, amount validation.
9. Offline and devices: `src/lib/offline/*`, `src/app/api/offline/*`, device enrollment binding, replay/idempotency, HMAC/encryption handling, unlock gates.
10. Input validation and injection: zod usage, raw SQL, file/path handling.
11. CSRF, XSS, SSRF, open redirect.
12. Secrets handling and logging.
13. Dependencies and supply chain.
14. Migration and schema safety for `prisma/migrations/20261115_email_verification_password_policy/migration.sql` and `prisma/schema-pg.prisma`.
15. Production configuration exposure: `render.yaml`, `next.config.ts`, headers/CSP, health endpoints, error handling.

Out of scope by instruction: any runtime exploit, denial-of-service, brute force, destructive test, deployment action, provider API call, database write, or reading `.env`/`.secrets`/dumps.

## 2. Methodology and evidence handling

- Static review of the exact commit, not the live working tree.
- The working tree changed branch during the review (from the subject feature branch to `chore/maintenance-guard`). To avoid reviewing the wrong revision, the commit was exported read-only with `git archive` into a temporary directory, and all evidence in this report was re-read from that frozen snapshot. No checkout, reset, stash or worktree was performed.
- Targeted data-flow review: browser input -> server action/route -> authorization guard -> tenant resolution -> database query -> response.
- Pattern searches for raw SQL, unsafe HTML, outbound fetches, session minting, tenant filters and secret logging.
- `npm audit --json --omit=dev` against the frozen lockfile.
- No SAST engine (Semgrep/CodeQL), DAST scanner, dependency scanner beyond `npm audit`, app server, test runner or database was run. Those tools were unavailable in this environment or prohibited by the rules.

## 3. Tools actually used

| Tool | Use |
|---|---|
| `git` | `ls-tree`, `archive`, `show`, `diff`, `rev-parse`, `cat-file`; commit and branch verification |
| File reader | Full and targeted reads of source, schema, migration, config and tests |
| `grep` / ripgrep | Pattern searches for guards, session minting, raw SQL, `dangerouslySetInnerHTML`, outbound fetch, env names, secret logging |
| `npm audit --json --omit=dev` | Advisory summary for the frozen lockfile |
| PowerShell | Read-only listing, line-number lookup, hash/audit parsing |

**Unavailable / not used:** Semgrep, CodeQL, Snyk, Trivy, OWASP ZAP, Burp, Playwright runtime, `tsc` against the subject commit (working tree was moving), database, application server, Render/Cloudflare APIs, email provider.

## 4. Findings summary

| ID | Severity | Title | Status | Primary location |
|---|---|---|---|---|
| SEC-01 | Critical | Unguarded `issueModuleSession` is a callable server action that mints a session for any user id, module and `amr` | confirmed | `src/lib/actions/auth.actions.ts:320` |
| SEC-02 | High | Mandatory password upgrade is not enforced on live sessions; platform write actions ignore the force-reset flag | confirmed | `src/lib/auth.ts:546`, `src/lib/tenant.ts:132`, `src/lib/platform-auth.ts:290` |
| SEC-03 | High | Offline contribution sync can double-allocate cycle days under concurrency | suspected | `src/app/api/offline/sync-contribution/route.ts:421`, `prisma/schema-pg.prisma:311` |
| SEC-04 | Medium | Financial step-up reauthentication is client-only; withdrawal and password-reset actions accept the mutation with an admin session alone | confirmed | `src/lib/actions/susu-withdrawal.actions.ts:40`, `src/components/ReauthDialog.tsx:51` |
| SEC-05 | Medium | Trusted-proxy headers are trusted without a verified proxy chain; rate-limit bucket and same-origin allow-list can be influenced by request headers | suspected | `src/lib/security/client-ip.ts:43`, `src/lib/security/same-origin.ts:37` |
| SEC-06 | Medium | Collector remittance accepts unvalidated amounts and has no idempotency or rate limit | confirmed | `src/lib/actions/susu-collector.actions.ts:384` |
| SEC-07 | Low | MFA recovery codes are consumed with a non-atomic read/modify/write, so one code can be used twice concurrently | suspected | `src/lib/security/totp.ts:168`, `src/lib/security/mfa.ts:236` |
| SEC-08 | Low | Session `amr` is downgraded or omitted on workspace selection and platform password re-issue | confirmed | `src/lib/actions/auth.actions.ts:329,368`, `src/lib/actions/platform.actions.ts:342` |
| SEC-09 | Low | Middleware asset bypass matches any path containing a dot | confirmed | `src/middleware.ts:326` |
| SEC-10 | Low | Public health endpoints disclose deployed commit SHA and environment name | confirmed | `src/app/api/health/route.ts:29`, `src/app/api/health/ready/route.ts:51` |
| SEC-11 | Low | Turnstile is disabled in the production blueprint, leaving only rate limits and cooldowns against login automation | confirmed | `render.yaml:67`, `src/lib/security/config.ts:117` |
| SEC-12 | Low | `.gitignore` does not cover `.env.*` broadly | confirmed | `.gitignore:3` |
| SEC-13 | Low | `npm audit` reports three high advisories in Prisma CLI/config and `deepmerge-ts` (build-time path) | confirmed | `package.json`, `package-lock.json` |
| SEC-14 | Low | Email-verification token is not bound to the email address it was issued for | confirmed | `src/lib/actions/staff.actions.ts:187`, `src/lib/security/account-tokens.ts:141` |
| SEC-15 | Informational | Self-service MFA enroll/confirm/disable actions lack per-subject rate limits | confirmed | `src/lib/security/mfa.actions.ts:448` |
| SEC-16 | Informational | New accounts are unusable if transactional email is disabled or misconfigured | confirmed | `src/lib/actions/staff.actions.ts:105`, `src/lib/email/resend.ts:88` |

Counts: **1 Critical, 2 High, 3 Medium, 8 Low, 2 Informational.**

---

## SEC-01 — Unguarded `issueModuleSession` mints a session for any user, module and `amr`

**Severity:** Critical
**Status:** confirmed (code evidence)
**Affected file/route:** `src/lib/actions/auth.actions.ts:320-333` (module is `"use server"` at line 1); reachable as a Next.js server action RPC endpoint.
**OWASP mapping:** ASVS 5.0 V6 Authentication, V8 Authorization, V9 Self-contained Tokens; API Top 10 2023 API2 Broken Authentication, API5 Broken Function Level Authorization; WSTG-ATHN-04, WSTG-ATHZ-02.

### Weakness

Every exported async function in a `"use server"` module is compiled into a callable server action. `issueModuleSession` is exported and performs **no authentication or authorization check**. It accepts the target `userId`, the target `module` and an `mfaVerified` boolean directly from the caller, builds the payload from that user's database row, and returns a fully valid session token.

### Evidence

```ts
// src/lib/actions/auth.actions.ts:1
"use server";
...
// src/lib/actions/auth.actions.ts:320
export async function issueModuleSession(
  userId: string,
  module: ModuleName,
  mfaVerified = false
): Promise<{ payload: JwtPayload; token: string }> {
  const payload = await buildSessionPayload(userId);
  const withAmr: JwtPayload = {
    ...payload,
    module,
    amr: mfaVerified ? "pwd+mfa" : "pwd",
  };
  const token = await setModuleSession(module, withAmr);
  return { payload: withAmr, token };
}
```

The same module also exports `resolveCustomerAuth` (line 734) and `resolveStaffAuth` (line 863). Those two include password and throttling checks and return only a payload, so they are not equivalent bypasses, but they are unintended public RPC surface.

### Preconditions

- The caller can invoke the server action (Next.js server actions are ordinary POST endpoints; the action ID must be known or derived).
- The attacker knows a target `User.id` or `Customer.id`. User ids are returned by `/api/auth/me` to the authenticated owner and appear in audit/admin surfaces; they are identifiers, not secrets.
- No password, MFA code, session or tenant membership is required.

### Practical impact

A worker, collector, customer, or unauthenticated attacker who obtains the action ID and a user id can mint:

- a valid session for **any** user, including another tenant's administrator;
- a session for **any** module (`admin`, `momo`, `susu`, `customer`), regardless of the account's real role or module capability;
- a session with `amr: "pwd+mfa"`, which satisfies the MFA-enforcement checks in `src/lib/auth.ts` and `src/middleware.ts`.

Chained with `/api/auth/tab/enroll`, the returned token can be exchanged for a tab credential and a 120-second assertion, producing a complete authenticated browser session. This is a full authentication and authorization bypass.

### Remediation

1. Remove `issueModuleSession` from the exported surface. Move session-minting helpers into a non-`"use server"` module (for example `src/lib/session-issue.ts`) and import them internally.
2. Do the same for `resolveCustomerAuth` and `resolveStaffAuth`; only the login actions should be exported.
3. Add a build-time or lint rule that fails when a `"use server"` module exports a function whose first parameter is a subject id, or that calls `setModuleSession`/`setPlatformSession` without a guard.
4. Defence in depth: require a short-lived, single-use login completion proof inside `issueModuleSession` so even an accidental export cannot mint a session from arbitrary input.

### Regression test

- Static test: assert `auth.actions.ts` exports only the documented action names (`login`, `selectWorkspace`, `switchWorkspace`, `logout`, `verifyPasswordAction`, `changePassword`, `customerLogin`, `unifiedLogin`, `adminLogin`, `completeRequiredPasswordChange`, `completeRequiredCustomerPasswordChange`, `customerChangePassword`, `customerLogout`).
- Runtime test: invoking the action with `{ userId: otherUser.id, module: "admin", mfaVerified: true }` must fail with "Not authenticated" and must not create a `SessionRecord`.

---

## SEC-02 — Mandatory password upgrade is not enforced on live sessions; platform writes ignore the flag

**Severity:** High
**Status:** confirmed (code evidence)
**Affected files/routes:** `src/lib/auth.ts:546-580`, `src/lib/tenant.ts:132-145`, `src/lib/platform-auth.ts:290-296`, `src/lib/actions/platform.actions.ts:651,794,855,904,956`
**OWASP mapping:** ASVS 5.0 V6 Authentication, V7 Session Management, V8 Authorization; WSTG-ATHN-02, WSTG-SESS-06; API Top 10 2023 API2, API5.

### Weakness

The release adds a mandatory credential upgrade (`forcePasswordReset` / `forcePortalPasswordReset` / platform `forcePasswordReset`). New logins correctly receive only a purpose-bound password-change challenge. However, the **server-side session validity check does not consult the flag**, and the **platform write guard does not either**:

- `isSessionCurrent` validates timing, `SessionRecord`, MFA, account status, email verification and `tokenVersion`; it never reads `forcePasswordReset`.
- `getTenantContext` re-reads the user and `tokenVersion`; it never reads `forcePasswordReset`.
- `requirePlatformAdmin` returns the session even when `session.forcePasswordReset` is true. Only `requirePlatformPage` (pages) and `requirePlatformRead` (platform read actions) check it. Tenant creation, tenant status/profile/module changes and tenant-admin password reset use `requirePlatformAdmin`.

The migration deliberately does not revoke existing sessions (`prisma/migrations/20261115_email_verification_password_policy/migration.sql:10-11`), and the design document records the same decision. The result is that every session issued before deployment keeps full access, and a platform operator session issued before deployment can still perform privileged writes.

### Evidence

```ts
// src/lib/auth.ts:546
export async function isSessionCurrent(payload: JwtPayload): Promise<boolean> {
  ...
  const user = await db.user.findUnique({
    where: { id: payload.userId },
    select: { tokenVersion: true, status: true, emailVerified: true },
  });
  if (!user || user.status !== "active") return false;
  if (!user.emailVerified) return false;
  if (user.tokenVersion !== (payload.tokenVersion ?? 0)) return false;
  return true;
}
```

```ts
// src/lib/platform-auth.ts:290
export async function requirePlatformAdmin(): Promise<PlatformSession> {
  const session = await getPlatformSession();
  if (!session) {
    redirect("/platform/login");
  }
  return session;          // no forcePasswordReset check
}
```

`enrollTenant` (`platform.actions.ts:651`), `setTenantStatus` (`:794`), `updateTenantProfile` (`:855`), `updateTenantModules` (`:904`) and `resetTenantAdminAccess` (`:956`) all call `requirePlatformAdmin()`.

### Preconditions

- The attacker holds a session that was issued before the migration/deployment (stolen token, shared device, or an insider), or the platform operator already had an open console session.
- The session has not been revoked and is within the 8-hour absolute lifetime.

### Practical impact

- The mandatory upgrade can be skipped for the remaining life of every pre-existing session, contrary to the release objective.
- A pre-existing platform session can create tenants, suspend tenants, change module entitlements and reset tenant-administrator passwords without completing the required password upgrade.
- The old password and the old session remain valid in parallel, widening the window in which a leaked credential is useful.

### Remediation

1. In `isSessionCurrent`, reject a user session when the re-read row has `forcePasswordReset === true` (and customer sessions when `forcePortalPasswordReset === true`). Redirect to the appropriate first-login/challenge screen.
2. In `getTenantContext`, apply the same check so server actions fail closed even if a page guard is bypassed.
3. Change `requirePlatformAdmin` to refuse when `session.forcePasswordReset` is true, or split it into `requirePlatformSession` and `requirePlatformWritable`.
4. Alternatively, revoke all sessions in the migration/deploy step (`UPDATE "SessionRecord" SET "revokedAt" = now()`), accepting the forced re-login.

### Regression test

- Create a user with `forcePasswordReset = true` and a valid `SessionRecord`/JWT whose `forcePasswordReset` claim is false. Call a tenant action and assert denial.
- Same for a platform session: call `enrollTenant` and assert refusal while the flag is true.
- Assert that a normal post-upgrade session still works.

---

## SEC-03 — Offline contribution sync can double-allocate cycle days under concurrency

**Severity:** High
**Status:** suspected (code-level race; needs a concurrent runtime test)
**Affected files/routes:** `src/app/api/offline/sync-contribution/route.ts:421-478`, `prisma/schema-pg.prisma:311-326`; compare `src/lib/actions/susu-contribution.actions.ts:276-334`
**OWASP mapping:** ASVS 5.0 V2 Validation and Business Logic, V8 Authorization, V11 Cryptography (integrity); API Top 10 2023 API6 Unrestricted Access to Sensitive Business Flows; WSTG-BUSL-01.

### Weakness

The online contribution path serializes balance changes with a PostgreSQL transaction-scoped advisory lock (`lockAccountForUpdate(tx, account.id)`), then recomputes paid days inside the transaction. The offline sync route performs the same read-modify-write **without the lock**:

1. read all allocations for the cycle,
2. derive `paidDays`,
3. choose the next unpaid days,
4. insert a contribution and allocation rows.

There is no unique constraint on `(contributionId, cycleDay)` or `(accountId, cycleId, cycleDay)`. Two concurrent sync requests with different idempotency keys therefore both observe the same unpaid days and both allocate them. Each request is individually idempotent (unique `OfflineTransaction.idempotencyKey` and unique `Contribution.referenceId`), but different keys are treated as different instructions.

### Evidence

```ts
// src/app/api/offline/sync-contribution/route.ts:421
result = await db.$transaction(async (tx) => {
  const existingAllocations = await tx.contributionAllocation.findMany({
    where: { contribution: { cycleId: cycle.id, reversedAt: null }, tenantId: ctx.tenantId },
  });
  const paidDays = new Set(existingAllocations.map((a) => a.cycleDay));
  ...
  for (let day = 1; day <= 31 && allocations.length < daysCovered; day++) {
    if (!paidDays.has(day)) { allocations.push({ ... cycleDay: day ... }); }
  }
  ...
```

```prisma
// prisma/schema-pg.prisma:311
model ContributionAllocation {
  ...
  @@index([contributionId])
  @@index([cycleDay])
  @@index([tenantId])
}
```

The online action does call `await lockAccountForUpdate(tx, account.id);` (`susu-contribution.actions.ts:277`); the offline route has no equivalent.

### Preconditions

- Two or more sync requests for the same account/cycle run concurrently (two devices, a retry storm, or a deliberately parallel client).
- The requests use different idempotency keys.

### Practical impact

- The same cycle day can be paid twice while the "days paid" count remains low, allowing contributions beyond the 31-day cycle ceiling.
- The customer's displayed balance and paid-day history diverge from the intended savings schedule.
- A collector can produce a ledger that appears to satisfy more days than were actually collected, complicating reconciliation and withdrawal eligibility.

### Remediation

1. Call `lockAccountForUpdate(tx, account.id)` at the start of the offline sync transaction, exactly as the online action does.
2. Add a database invariant: `@@unique([contributionId, cycleDay])` is not sufficient for cross-contribution duplication; prefer `@@unique([tenantId, cycleId, cycleDay])` and adjust reversal handling (reversals must remove or supersede the allocation, not insert a duplicate).
3. Alternatively, derive allocations from a single atomic counter/claim row per cycle day.
4. Add a serializability/retry test that runs two sync requests concurrently against PostgreSQL.

### Regression test

- Seed one cycle, fire two `POST /api/offline/sync-contribution` requests concurrently with different keys for the same one-day amount, and assert exactly one allocation exists for the day and exactly one contribution is posted.
- Repeat with the online action to prove both paths behave identically.

---

## SEC-04 — Financial step-up reauthentication is client-only

**Severity:** Medium
**Status:** confirmed (code evidence)
**Affected files/routes:** `src/lib/actions/susu-withdrawal.actions.ts:40-256`, `src/app/susu/admin/withdrawals/page.tsx:245-253`, `src/components/ReauthDialog.tsx:51-57`
**OWASP mapping:** ASVS 5.0 V6 Authentication (step-up), V8 Authorization; WSTG-ATHN-09; API Top 10 2023 API5, API6.

### Weakness

The UI requires the administrator to re-enter their password before a withdrawal via `ReauthDialog`. The dialog calls `verifyPasswordAction` and, only on success, calls `executeWithdrawal()`. The server action `processWithdrawal` itself does **not** receive or verify any reauthentication proof. A caller that invokes the action directly with a valid admin session bypasses the step-up entirely.

The same pattern exists for staff password reset and capability changes (`ReauthDialog` usage in `admin/(workspace)/workers/[id]/page.tsx` and `susu/admin/collectors/page.tsx`).

### Evidence

```tsx
// src/components/ReauthDialog.tsx:51
const result = await verifyPasswordAction(password, module ? { module } : undefined);
if (result.success) {
  setPassword("");
  onConfirmed();          // client-only gate
}
```

```ts
// src/lib/actions/susu-withdrawal.actions.ts:46
const ctx = await requireTenantAdminSusu();
...
const account = await db.susuAccount.findFirst({ where: { id: accountId, tenantId: ctx.tenantId } });
```

`processWithdrawal` has no nonce, timestamp, password proof or `SessionRecord` step-up marker.

### Preconditions

- The attacker holds a valid Susu administrator session (for example a stolen tab token, an unattended unlocked tab, or a session-hijack primitive).
- The attacker can call the server action directly (they do not need the UI).

### Practical impact

A stolen administrator session can move customer money (withdrawals) and reset staff credentials without the second password prompt that the product presents as a security control. The control reduces exposure to session theft only if it is enforced server-side.

### Remediation

1. Add a server-side step-up grant: after `verifyPasswordAction` succeeds for a specific module and purpose, write a short-lived, single-use grant (for example a `SessionRecord` field or a signed `stepUp` claim with `jti`, purpose `withdrawal`, 5-minute TTL).
2. Require that grant inside `processWithdrawal`, `resetStaffPassword`, `resetWorkerPassword` and `resetTenantAdminAccess`.
3. Bind the grant to the amount/account or at least to the purpose and acting session.
4. Keep the UI dialog, but treat it as a convenience only.

### Regression test

- Call `processWithdrawal` with a valid admin session and no step-up grant; assert refusal.
- Obtain a grant, use it once for a withdrawal, then assert a second withdrawal with the same grant is rejected.
- Assert an expired grant is rejected.

---

## SEC-05 — Trusted-proxy headers are trusted without a verified proxy chain

**Severity:** Medium
**Status:** suspected (needs a runtime request against the deployed origin)
**Affected files:** `src/lib/security/client-ip.ts:43-64`, `src/lib/security/same-origin.ts:37-45`, `render.yaml:13,67-72`
**OWASP mapping:** ASVS 5.0 V13 Configuration, V6 Authentication; API Top 10 2023 API4 Unrestricted Resource Consumption, API8 Security Misconfiguration; WSTG-CONF-07, WSTG-ATHN-03.

### Weakness

When `TRUSTED_PROXY_HEADERS=true` (set in `render.yaml`) or `RENDER`/`RENDER_SERVICE_ID` is present, the application trusts `True-Client-IP` and `CF-Connecting-IP` as the client address, and trusts `X-Forwarded-Host` when building the same-origin allow-list. It does not verify that the request actually arrived through Cloudflare or that the platform stripped client-supplied copies of those headers.

`render.yaml` also states that `maacash.onrender.com` remains directly reachable, so a client can bypass the Cloudflare edge while still sending these headers.

### Evidence

```ts
// src/lib/security/client-ip.ts:43
function trustedProxyEnabled(): boolean {
  if (process.env.TRUSTED_PROXY_HEADERS === "true") return true;
  ...
}
...
const trueClientIp = normalizeIp(headers.get("true-client-ip"));
if (trueClientIp) return { ip: trueClientIp, source: "true-client-ip" };
const cfConnectingIp = normalizeIp(headers.get("cf-connecting-ip"));
if (cfConnectingIp) return { ip: cfConnectingIp, source: "cf-connecting-ip" };
```

```ts
// src/lib/security/same-origin.ts:37
if (process.env.TRUSTED_PROXY_HEADERS === "true") {
  const host = request.headers.get("x-forwarded-host");
  ...
  origins.add(`${proto}://${host}`);
}
```

### Preconditions

- The attacked deployment accepts direct traffic on a hostname where the client controls these headers.
- The platform/edge does not overwrite or strip them.

### Practical impact

- Per-IP login, MFA, password-reset and offline-sync rate limits can be evaded by rotating a forged client-IP header. Per-account throttling still applies, so this is not a complete brute-force bypass, but it removes one of two dimensions and enables distributed-looking attempts from one host.
- The same-origin allow-list can be widened with a forged `X-Forwarded-Host`; current production transport is a custom header that cross-site forms cannot set, so this is defence-in-depth rather than a direct CSRF exploit today. It would become exploitable if cookie transport were reintroduced.
- Turnstile's `remoteip` (when enabled) would receive an attacker-chosen address.

### Remediation

1. Trust proxy headers only when the connection is known to come from the edge. On Render, use a platform-provided, unspoofable signal or a shared secret header injected by the edge.
2. Explicitly reject requests whose `True-Client-IP`/`CF-Connecting-IP`/`X-Forwarded-Host` differ from a verified edge value, or strip client-supplied copies at the edge.
3. Do not add `X-Forwarded-Host` to the same-origin allow-list; derive the expected origin from configured canonical hosts only.
4. Keep the direct `onrender.com` hostname disabled for browser traffic, or require a separate allow-list for it.

### Regression test

- Send a login request with `CF-Connecting-IP: 203.0.113.7` and a fixed source address; assert the limiter buckets by the real edge address, not the header.
- Send an API mutation with `Origin: https://evil.example` and `X-Forwarded-Host: evil.example`; assert 403.

---

## SEC-06 — Collector remittance accepts unvalidated amounts and has no idempotency or rate limit

**Severity:** Medium
**Status:** confirmed (code evidence)
**Affected file/route:** `src/lib/actions/susu-collector.actions.ts:384-458`
**OWASP mapping:** ASVS 5.0 V2 Validation and Business Logic; API Top 10 2023 API6; WSTG-BUSL-01, WSTG-INPV-01.

### Weakness

`recordRemittance` is a tenant-admin-only financial action. It validates only `remittedAmount <= 0`. It does not require `typeof === "number"`, `Number.isFinite`, a maximum bound, or currency precision. It has no idempotency key and no conditional insert, so a double submit creates two remittance rows. It also has no rate limit (the reversal path does). The `expectedAmount` query does not exclude reversed contributions.

### Evidence

```ts
// src/lib/actions/susu-collector.actions.ts:384
export async function recordRemittance(params: {
  collectorId: string;
  remittedAmount: number;
  notes?: string;
}): Promise<ActionResponse> {
  const ctx = await requireTenantAdminSusu();
  const { collectorId, remittedAmount, notes } = params;

  if (remittedAmount <= 0) {
    return { success: false, error: "Remitted amount must be greater than 0" };
  }
  ...
  const remittance = await db.collectorRemittance.create({
    data: { tenantId: ctx.tenantId, collectorId, expectedAmount, remittedAmount, variance, ... },
  });
```

### Preconditions

- Authenticated tenant administrator (or a stolen admin session).
- A double click, client retry, or deliberate repeated call.

### Practical impact

- Duplicate remittance rows: the second row is calculated against an almost-zero expected amount and records a large negative variance, corrupting cash-handover reporting.
- Non-numeric / non-finite input reaches Prisma and produces an unhandled action error instead of a designed validation message.
- Reversed contributions inflate `expectedAmount`, making a correct handover appear short.
- No rate limit on repeated financial writes.

### Remediation

1. Validate `typeof remittedAmount === "number"`, `Number.isFinite`, `0 < amount <= 999999.99`, and `hasCurrencyPrecision(amount)` before any query.
2. Add a client-generated idempotency key with a unique constraint (as contributions and withdrawals already do).
3. Wrap the read of the last remittance and the insert in the same transaction with `lockAccountForUpdate`/advisory lock on the collector.
4. Add `.reversedAt: null` to the unremitted-contribution query.
5. Apply a `financeMutation` rate limit.

### Regression test

- Submit a valid remittance twice with the same key; assert one row.
- Submit `NaN`, `Infinity`, a string, `0.001`, and `1000000`; assert a clear validation error and no row.
- Seed a reversed contribution and assert it is excluded from `expectedAmount`.

---

## SEC-07 — MFA recovery codes are consumed non-atomically

**Severity:** Low
**Status:** suspected (code-level race; needs concurrency proof)
**Affected files:** `src/lib/security/totp.ts:168-191`, `src/lib/security/mfa.ts:236-256`
**OWASP mapping:** ASVS 5.0 V6 Authentication (single-use recovery codes); WSTG-ATHN-05.

### Weakness

`consumeRecoveryCode` reads the stored hash list, removes the matched hash in memory, and returns the remaining list. `verifyMfaCode` then writes the whole remaining list with `updateSubject`. Two concurrent verifications both read the same list and both succeed; the last write wins. Each request can consume a different MFA challenge `jti`, so a single recovery code can mint two sessions.

### Evidence

```ts
// src/lib/security/totp.ts:182
const target = hashRecoveryCode(code);
const index = hashes.indexOf(target);
if (index === -1) return { ok: false, remaining: storedJson };
hashes.splice(index, 1);
return { ok: true, remaining: hashes.length > 0 ? JSON.stringify(hashes) : null };
```

```ts
// src/lib/security/mfa.ts:253
await updateSubject(params.subjectType, params.subjectId, {
  mfaRecoveryCodes: recovery.remaining,
  mfaLastUsedAt: new Date(now),
});
```

### Preconditions

- Attacker holds one valid recovery code.
- Two login attempts with separate MFA challenges are executed concurrently.

### Practical impact

A leaked recovery code can authenticate more than once before the list settles, weakening single-use semantics and incident-response assumptions. It does not grant access to someone who lacks the code.

### Remediation

Store recovery codes as individual rows (one per hash) and delete the matched row with a conditional `deleteMany`/`updateMany` in the same transaction as the session issuance. If the JSON array must stay, use an atomic compare-and-swap on the prior value.

### Regression test

- Fire two `verifyMfaLoginAction` calls concurrently with the same recovery code and different challenges; assert exactly one succeeds and the code is absent afterwards.

---

## SEC-08 — Session `amr` is downgraded or omitted on workspace selection and platform password re-issue

**Severity:** Low
**Status:** confirmed (code evidence)
**Affected files:** `src/lib/actions/auth.actions.ts:320-333,368`, `src/lib/actions/platform.actions.ts:342-348`, `src/lib/platform-auth.ts:257`
**OWASP mapping:** ASVS 5.0 V6 Authentication, V7 Session Management; WSTG-SESS-01.

### Weakness

`selectWorkspace` calls `issueModuleSession(selection.userId, module)` without `mfaVerified`, so the new token always carries `amr: "pwd"`. Under `MFA_ENFORCEMENT=enforce`, `isSessionCurrent` rejects it, producing an unusable session for the dual-role workspace-selection path. The selection path is normally reached only when no MFA step was required, so this is primarily an availability and consistency defect rather than an active downgrade; the risk is that the path does not re-assert the policy and can strand a selection token that outlived a policy change.

`platformChangePassword` re-issues a platform session without any `amr` field; `getPlatformSession` rejects tokens whose `amr !== "pwd+mfa"` under enforcement, so the operator is logged out immediately after changing their password.

### Evidence

```ts
// src/lib/actions/auth.actions.ts:326
const withAmr: JwtPayload = {
  ...payload,
  module,
  amr: mfaVerified ? "pwd+mfa" : "pwd",
};
...
// src/lib/actions/auth.actions.ts:368
const issued = await issueModuleSession(selection.userId, module);
```

```ts
// src/lib/actions/platform.actions.ts:342
const token = await setPlatformSession({
  adminId: admin.id,
  email: admin.email,
  fullName: admin.fullName,
  forcePasswordReset: false,
  tokenVersion: admin.tokenVersion + 1,
});                       // no amr
```

### Preconditions

- Dual-role account using `/select-workspace`, or platform administrator changing their password while enforcement is on.

### Practical impact

No privilege escalation (the weaker token is rejected under enforcement). The impact is a broken or confusing authentication flow, plus a path that does not re-assert the MFA policy when the policy changes. It signals that authentication context is not propagated consistently, which increases the risk of a future enforcement bypass.

### Remediation

Carry the source authentication context explicitly: pass the completed `amr` into `selectWorkspace` (derive it from the MFA challenge/session, never from the browser), and include `amr: "pwd+mfa"` in the platform re-issue when the current session has it.

### Regression test

- In enforce mode, complete MFA, select a workspace, and assert the new session is accepted by `isSessionCurrent` with `amr === "pwd+mfa"`.
- Change a platform password and assert the returned token remains usable.

---

## SEC-09 — Middleware asset bypass matches any path containing a dot

**Severity:** Low
**Status:** confirmed (code evidence; page-level guards still enforce)
**Affected file:** `src/middleware.ts:326`
**OWASP mapping:** ASVS 5.0 V8 Authorization, V13 Configuration; WSTG-ATHZ-01.

### Weakness

The middleware skips authentication for any path that contains a `.` anywhere, not only for static asset extensions. A protected dynamic route with a dotted segment (for example `/admin/staff/some.user`, `/admin/reports/2026.11.15`) reaches the page without middleware route gating.

### Evidence

```ts
// src/middleware.ts:326
if (pathname.startsWith("/_next") || pathname.includes(".")) {
  return next();
}
```

### Preconditions

- A protected route accepts a dynamic segment containing a dot.
- The page or server action fails to apply its own guard.

### Practical impact

The sampled admin, worker, collector, customer and platform layouts all call their own `require*` guard, and server actions re-check tenant and role. The issue is therefore defence-in-depth: middleware is no longer a reliable second layer, and a future page that relies on middleware alone would be exposed.

### Remediation

Match only known static extensions and `/_next` paths:

```ts
const STATIC_ASSET = /\.(?:css|js|mjs|map|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|txt|xml|json|webmanifest)$/i;
if (pathname.startsWith("/_next") || STATIC_ASSET.test(pathname)) return next();
```

### Regression test

- Request `/admin/staff/foo.bar` without a session; assert a redirect to login (or a 401/403), not a rendered page.
- Request a real static asset; assert it is still served.

---

## SEC-10 — Public health endpoints disclose deployed commit SHA and environment name

**Severity:** Low
**Status:** confirmed (code evidence)
**Affected files/routes:** `src/app/api/health/route.ts:29-30`, `src/app/api/health/ready/route.ts:47-52`
**OWASP mapping:** ASVS 5.0 V13 Configuration, V16 Security Logging and Error Handling; WSTG-CONF-02, WSTG-INFO-02.

### Weakness

Both public health endpoints return the deployed git commit SHA and the environment name. `/api/health/ready` also returns database reachability and latency. No secret is exposed, but the information helps an attacker correlate the deployment with public source, known advisories and schema versions.

### Evidence

```ts
// src/app/api/health/route.ts:29
env: process.env.APP_ENV || process.env.NODE_ENV || "unknown",
commit: deployedCommitSha(),
```

### Preconditions

- Network access to the public origin.

### Practical impact

Version and environment disclosure; reconnaissance aid. The readiness endpoint additionally confirms database availability to unauthenticated callers.

### Remediation

Return commit/environment only to an authenticated operator or when a configured diagnostic token is supplied. Keep the public probe to `{ status: "ok" }`. Keep `/api/health/ready` on the private network or protect it.

### Regression test

- Unauthenticated `GET /api/health` response must not contain `commit` or `env`.
- Authorized diagnostic request may still include them.

---

## SEC-11 — Turnstile is disabled in the production blueprint

**Severity:** Low
**Status:** confirmed (configuration evidence)
**Affected files:** `render.yaml:67-68`, `src/lib/security/config.ts:117`
**OWASP mapping:** ASVS 5.0 V6 Authentication; API Top 10 2023 API2, API4; WSTG-ATHN-03.

### Weakness

`render.yaml` sets `TURNSTILE_ENABLED` to `"false"` while the surrounding comment describes security hardening and the staging blueprint enables it. With Turnstile off, login, password reset and email verification rely on per-IP limits and per-account progressive cooldown only. Combined with SEC-05, the per-IP dimension is weaker than intended.

### Evidence

```yaml
# render.yaml:67
- key: TURNSTILE_ENABLED
  value: "false"
```

### Preconditions

- Production deployed from `render.yaml`.

### Practical impact

Higher exposure to credential stuffing and automated login/reset attempts. The account cooldown still limits attempts per account, so this is not an immediate takeover path.

### Remediation

Enable Turnstile in production once the site key and secret are configured, or document an explicit risk acceptance with compensating controls (WAF rate limits at the edge, alerting on failed-login volume).

### Regression test

- Deployment configuration test asserts `TURNSTILE_ENABLED=true` for the production service, or that a documented exception exists.

---

## SEC-12 — `.gitignore` does not cover `.env.*` broadly

**Severity:** Low
**Status:** confirmed (configuration evidence)
**Affected file:** `.gitignore:3-9`
**OWASP mapping:** ASVS 5.0 V14 Data Protection, V13 Configuration; WSTG-CONF-03.

### Weakness

Only `.env`, `.env.local`, `.env.pilot` and `.env.pilot.local` are ignored. A future `.env.production`, `.env.staging`, `.env.test` or provider-specific env file would be tracked unless manually excluded. No `.env` file is currently tracked at `d4e153a` (verified with `git ls-tree`).

### Evidence

```gitignore
.env
.env.local
.env.pilot
.env.pilot.local
!.env.example
!.env.pilot.example
```

### Preconditions

- A developer creates an unlisted env file and commits with `git add -A`.

### Practical impact

Potential secret leakage into version control and every clone/CI artifact.

### Remediation

```gitignore
.env
.env.*
!.env.example
!.env.*.example
```

Keep the existing explicit negations for documented examples, and add a CI secret scan.

### Regression test

- CI test creates `.env.production` and asserts `git check-ignore` succeeds.

---

## SEC-13 — High-severity advisories in Prisma CLI/config and `deepmerge-ts`

**Severity:** Low
**Status:** confirmed (`npm audit` output)
**Affected files:** `package.json`, `package-lock.json`
**OWASP mapping:** ASVS 5.0 V15 Secure Coding and Architecture; OWASP Top 10 2021 A06 Vulnerable and Outdated Components.

### Weakness

`npm audit --json --omit=dev` reports three high advisories:

- `prisma` (direct, `^6.19.3`) via `@prisma/config`
- `@prisma/config` via `deepmerge-ts`
- `deepmerge-ts < 8.0.0` — stack exhaustion when merging recursive object graphs

No critical advisories. The vulnerable path is the Prisma CLI/config layer used for `prisma generate` and migrations during build/deploy, not the Next.js request runtime. `package-lock.json` is present, so installs are reproducible.

### Practical impact

Build-time denial of service or compromised build if an attacker can supply a malicious recursive config object. Not reachable from normal user requests in the reviewed code.

### Remediation

Upgrade to the patched Prisma release (`7.10.1` per the advisory, a semver-major upgrade) and re-run `prisma generate` plus the migration tests. If the major upgrade is deferred, isolate build credentials and ensure only trusted configuration is parsed.

### Regression test

- `npm audit --omit=dev` returns zero high advisories.
- Build and `prisma generate --schema=prisma/schema-pg.prisma` still succeed.

---

## SEC-14 — Email-verification token is not bound to the email address it was issued for

**Severity:** Low
**Status:** confirmed (code evidence)
**Affected files:** `src/lib/actions/staff.actions.ts:187-203`, `src/lib/security/account-tokens.ts:141-156`
**OWASP mapping:** ASVS 5.0 V6 Authentication, V14 Data Protection; WSTG-ATHN-02.

### Weakness

`EmailVerificationToken` stores `userId` and a hash, but not the target email address. `consumeEmailVerification` marks the user's **current** email verified. A tenant administrator can change a staff member's email after a token was issued; the still-valid token then verifies the new address without any proof of control over it.

### Evidence

```ts
// src/lib/security/account-tokens.ts:147
await tx.user.update({
  where: { id: record.userId },
  data: { emailVerified: true, emailVerifiedAt: new Date() },
});
```

```ts
// src/lib/actions/staff.actions.ts:187
const user = await db.user.update({
  where: { id: staffId },
  data: { fullName: raw.fullName, email: raw.email, phone: raw.phone, status: raw.status },
});
```

### Preconditions

- A verification token is outstanding.
- A tenant administrator changes the staff email (or an equivalent admin path does).

### Practical impact

The verified-email invariant can be satisfied for an address that never received the link. A tenant administrator already controls staff accounts, so the practical escalation is limited; the integrity of the verification claim is still weakened and the audit trail becomes misleading.

### Remediation

Store the target email (or a hash of it) on the token and require it to equal the current user email at consumption. Invalidate outstanding tokens when `email` changes.

### Regression test

- Issue a token for `a@example.com`, change the user to `b@example.com`, consume the token; assert refusal and that `emailVerified` stays false.

---

## SEC-15 — Self-service MFA enroll/confirm/disable actions lack per-subject rate limits

**Severity:** Informational
**Status:** confirmed (code evidence)
**Affected files:** `src/lib/security/mfa.actions.ts:390-522`
**OWASP mapping:** ASVS 5.0 V6 Authentication; WSTG-ATHN-05.

### Weakness

`selfEnrollmentAction` rate-limits the admin path but not the platform path. `selfConfirmAction` and `selfDisableAction` do not rate-limit code attempts. `startMfaEnrollmentAction` can be called repeatedly with a valid enrollment challenge, replacing the pending secret each time.

### Practical impact

An authenticated attacker who already holds a session and the account password could brute-force the 6-digit code to disable MFA over a long session, or repeatedly reset a pending enrollment to deny it. Both require a session and, for disable, the password; no direct bypass of an active factor was found.

### Remediation

Apply `mfaSubject` rate limits to self-service confirm/disable, require a fresh step-up for disable, and make enrollment start idempotent (reuse the pending secret until it expires) instead of overwriting it.

### Regression test

- Seven wrong codes in the disable flow return a cooldown error and do not disable MFA.

---

## SEC-16 — New accounts are unusable if transactional email is disabled or misconfigured

**Severity:** Informational
**Status:** confirmed (code evidence)
**Affected files:** `src/lib/actions/staff.actions.ts:105`, `src/lib/actions/auth.actions.ts:191,926,1205`, `src/lib/email/resend.ts:88-93`
**OWASP mapping:** Availability / operational resilience; not a confidentiality or integrity weakness.

### Weakness

Every new staff, collector and tenant-administrator account is created with `emailVerified: false`, and every login path refuses to proceed until the address is verified. If `RESEND_API_KEY`/sender identity is missing, `EMAIL_DELIVERY=disabled`, or `RESEND_DISABLED=true`, `sendTransactionalEmail` fails or silently skips, and the account cannot reach a workspace.

### Practical impact

A configuration mistake during rollout locks out new users, including a newly enrolled tenant administrator. This is an availability and operational risk, not an attacker-controlled vulnerability (unless an operator is tricked into disabling delivery).

### Remediation

Add a deployment preflight that fails when email delivery is disabled in production, or provide a documented, audited platform-admin verification override. Alert on `send_failed` audit events.

### Regression test

- Production configuration test asserts an email provider is configured and delivery is not disabled.

---

## 5. Areas checked and found sound (explicit no-findings statement)

The following scope areas were reviewed and no vulnerability was found beyond the findings above. This list exists so coverage can be audited.

1. **MFA-before-password-upgrade ordering.** Every staff, customer, admin, platform and SSO path calls `beginMfaStepIfRequired` before issuing a password-change challenge. `verifyMfaLoginAction` and `finishMfaEnrollmentAction` consume a single-use challenge row and re-read the database before returning a challenge or session. SSO refuses a platform session when `forcePasswordReset` is true. Tests in `tests/auth-email-password.test.ts:321-434` exercise the ordering. No bypass of the ordering itself was found (SEC-02 concerns pre-existing sessions, not the ordering).
2. **Password-change challenge scope and replay.** The JWT is audience-bound (`bloomcore-one:password-change`), purpose-bound, 10-minute TTL, and split by subject type. It is not accepted by any module guard. Reuse after a successful change fails because the conditional update requires `forcePasswordReset = true`; concurrent submissions are safe. The token is stored in `sessionStorage`, never in a URL or cookie.
3. **Tenant isolation / IDOR / BOLA.** Sampled every action file. Tenant identity is resolved from the session through `getTenantContext`; browser-supplied tenant ids are ignored; `assertTenantEntity` is used on cross-entity references; customer-portal queries are scoped by both `ctx.userId` and `ctx.tenantId`. No cross-tenant read or write was found in the reviewed actions.
4. **Role escalation.** Tenant admins cannot create or promote to `admin` (`createStaffSchema` role enum); platform and tenant identities live in separate tables and cookies; a tenant JWT is rejected on `/platform` by the `kind: "platform"` check; a platform token is rejected by tenant readers.
5. **Financial authorization.** Withdrawals, reversals, corrections, reviews and handover confirmation require a tenant administrator. Workers can only edit/submit their own daily account at their assigned location, with conditional state transitions. Contributions require an active collector assigned to the customer. Integer-pesewa arithmetic and server-side expense totals prevent float/aggregate tampering.
6. **Idempotency and duplicate submit (online).** Withdrawals and contributions use unique client reference ids, advisory locks and conditional updates; handover confirmation and daily-account review are conditional. The offline path is the exception (SEC-03).
7. **TOTP replay.** `claimTotpStep` performs a single conditional `updateMany` that only advances `mfaLastTotpStep`; replay of the same or an older step matches zero rows.
8. **Session lifecycle.** Sessions are server-registered, revoked on logout/password change/recovery, and validated against `tokenVersion`; tab proof uses a non-extractable P-256 key, a per-request nonce and a request-id cache; assertions are route-gating only.
9. **Token storage.** Verification and reset tokens are stored as SHA-256 hashes; recovery codes as hashes; TOTP secrets encrypted with AES-256-GCM; SSO refresh tokens encrypted.
10. **Input validation and injection.** Zod schemas cover login, staff, worker, location, daily account and expenses. No user-controlled raw SQL was found; the only `$queryRawUnsafe` is a parameterised advisory lock, and other raw SQL is `SELECT 1`.
11. **CSRF, XSS, SSRF, open redirect.** No `dangerouslySetInnerHTML` with user data (the only use renders a locally generated QR SVG). No outbound fetch to a user-controlled URL (Resend, Paystack, DeepSeek and OIDC endpoints are fixed/configured). Redirect targets returned by actions are server constants; the SSO handoff destination is constrained to `/platform/`.
12. **Secrets and logging.** Security logs allow-list fields and drop forbidden keys; IP addresses are keyed hashes; no token, password or code is logged. `.env` files are not tracked. Secrets are `sync: false` in `render.yaml`.
13. **Dependency integrity.** A lockfile exists; no critical advisory affects the runtime; the three high advisories are in the Prisma CLI/config build path (SEC-13).
14. **Migration safety.** The migration is additive, uses constant defaults (`true`, `0`) so PostgreSQL does not rewrite the tables, drops nothing, changes no password hash or role, and performs bounded backfills. No privilege grants. Existing sessions are not revoked (see SEC-02).
15. **Production headers and error handling.** `next.config.ts` sets HSTS, `X-Frame-Options: DENY`, `nosniff`, referrer and permissions policies; middleware emits a per-request nonce CSP with `strict-dynamic`, `frame-ancestors 'none'`, `object-src 'none'` and `form-action 'self'`; `poweredByHeader` is false. No stack trace was found in a client response; action errors are authored strings.

## 6. Residual risks that static review cannot settle

1. **SEC-01 action-ID reachability.** The code weakness is certain; whether the action ID is discoverable from the deployed client bundle or server manifest needs runtime inspection. It must be treated as exploitable until proven otherwise.
2. **SEC-03 and SEC-07 concurrency.** Both require a real PostgreSQL concurrency test to demonstrate the duplicate allocation or double recovery-code use.
3. **SEC-05 proxy behaviour.** Whether Render/Cloudflare overwrite the trusted headers on every path (including the direct `onrender.com` hostname) requires a controlled request test. Do not use attack traffic; use the platform's documented header behaviour or a staging host.
4. **SIEM and alerting.** The code writes structured security events, but retention, alert routing and tamper resistance are deployment concerns not visible here.
5. **Email and identity-provider trust.** Account recovery, email verification and SSO all depend on external delivery/identity providers. A compromised mailbox or IdP defeats the corresponding control; this is outside the application code.
6. **Break-glass power.** A platform super admin can issue recovery codes, reset MFA and reset tenant-admin access. This is deliberate and audited, but it is a high-impact concentration of authority with no second approver. The same administrator can review, confirm handover, correct and reverse financial records; dual control is not enforced.
7. **First MFA enrollment.** Under `enforce`, an account that has never enrolled can enroll a new authenticator after proving only the password. That is the standard bootstrap trade-off, but a password-only compromise of a not-yet-enrolled account becomes a full compromise.
8. **Offline local protection.** AES-GCM with PBKDF2-SHA-256 (600,000 iterations) and a 15-minute idle / 5-minute background lock are implemented client-side. A compromised browser, malicious extension or unlocked device can defeat them; only the passphrase strength limits offline brute force.
9. **Service-worker dependency.** Production authentication depends on the tab-scoped service worker injecting the proof header. A browser or policy that blocks the worker breaks authentication (availability), and any future fallback to cookies would invalidate the CSRF reasoning in SEC-05.
10. **No DAST or human review.** Business-logic abuse that requires a running UI, multi-step timing, or social engineering was not tested.

## 7. Release recommendation

**BLOCK.** SEC-01 is a confirmed Critical authentication bypass, and SEC-02 is a confirmed High bypass of the release's central mandatory-upgrade control. SEC-03 (High, suspected) must be closed or proven non-reproducible before financial go-live. Re-assess after the fixes; do not treat this document as approval.

---

# Remediation status (added 2026-11-16)

This section is additive. The original findings above are preserved unchanged as historical
evidence, including the assessment subject commit `d4e153a`.

Remediation branch: `security/comprehensive-hardening-sec-01-to-sec-16`, based on `main` at
`d6d1577`. Reviewed against the live code, not against the release report.

| ID | Original severity | Disposition | Evidence |
| --- | --- | --- | --- |
| SEC-01 | Critical | **FIXED** (verified in current code) | `issueModuleSession`/`buildSessionPayload` live in `src/lib/session-issuance.ts` with no `"use server"` directive; `tests/security-release-fixes.test.ts` asserts they are absent from the action module's exports |
| SEC-02 | High | **FIXED** (verified in current code) | `isSessionCurrent`, `getTenantContext` and `requirePlatformAdmin` refuse a session whose account carries the upgrade flag (`src/lib/auth.ts`, `src/lib/tenant.ts`, `src/lib/platform-auth.ts`); regression tests in `tests/auth-email-password.test.ts` and `tests/security-release-fixes.test.ts` |
| SEC-03 | High | **FIXED** (verified in current code) | Offline sync takes `lockAccountForUpdate(tx, accountId)` inside its transaction (`src/app/api/offline/sync-contribution/route.ts`); assertion in `tests/security-release-fixes.test.ts` |
| SEC-04 | High | **UNRESOLVED** | No server-side single-use step-up grant exists; sensitive actions rely on the active session, and the dialog verifies a password only client-side. Needs a grant model with purpose and target binding, atomic consumption and per-action wiring |
| SEC-05 | High | **FIXED (code), residual documented** | `src/lib/security/client-ip.ts`: `CF-Connecting-IP` is authoritative, `True-Client-IP` only with explicit `TRUST_TRUE_CLIENT_IP=true`, no XFF/X-Real fallback. `src/lib/security/same-origin.ts`: `X-Forwarded-Host` can no longer widen the allow-list. Tests: `tests/security-hardening-round2.test.ts`. Residual: edge trust is structural, not cryptographically proven from code |
| SEC-06 | High | **PARTIALLY FIXED** | `src/lib/finance/remittance.ts` validates finite/positive/two-decimal/bounded amounts (NaN previously passed), excludes reversed contributions, and `recordRemittance` now runs inside a collector-scoped advisory lock with a finance rate limit. **Still open:** client idempotency key plus a unique constraint, so a double submit can still create two rows |
| SEC-07 | High | **UNRESOLVED** | Recovery codes remain a JSON array on the subject row; consumption is not a dedicated conditional row mutation. Needs hashed recovery-code rows and atomic consumption with an additive migration |
| SEC-08 | Medium | **PARTIALLY FIXED** | Session re-issuance derives `amr` server-side and workspace selection re-checks persisted state; a dedicated regression test for forged `amr` on every re-issuance path is still missing |
| SEC-09 | High | **FIXED** | `src/lib/security/static-assets.ts` replaces `pathname.includes(".")` with a closed path/extension allow-list used by the middleware. Tests assert `/admin/staff/foo.bar` and `/admin/reports/2026.11.15` redirect while `/_next/static/*` and `/favicon.ico` still serve |
| SEC-10 | Medium | **FIXED** | `/api/health` returns `{status:"ok"}` only; `/api/health/ready` returns `{status:"ready"}` or `503 {status:"not_ready"}` with the reason logged server-side. No commit, environment or latency exposed. Tests: `tests/security-hardening-round2.test.ts` |
| SEC-11 | Medium | **CONFIGURED, acceptance pending** | Production runs `TURNSTILE_ENABLED=true` with site and secret keys present and hostname binding; server-side verification covered by `tests/security-hardening.test.ts`. `render.yaml` drift (`false`) is documentation-level. No production dynamic test performed |
| SEC-12 | Medium | **FIXED** | `.gitignore` ignores `.env*`, `.secrets/`, key material and credential files while keeping `!.env.example` and `!.env.*.example`. Test proves `git check-ignore` matches `.env.production`, `.env.staging`, `.env.test` and rejects templates. Full history scan not performed in this pass |
| SEC-13 | High (dependency) | **DOCUMENTED, not upgraded** | `npm audit`: 6 high, 0 critical. All three production-tree highs are the Prisma chain (`prisma`, `@prisma/config`, `deepmerge-ts`) and only clear with Prisma 7 (major). `brace-expansion`, `js-yaml` and `vite` are dev/build-time. Reachability: build and migration tooling, not the Next.js runtime bundle; the build runs from a pinned lockfile |
| SEC-14 | Medium | **UNRESOLVED** | `EmailVerificationToken` has no destination-email snapshot, so a token issued before an email change can verify the new address. Needs an additive column plus invalidation on every email-change pathway |
| SEC-15 | Medium | **PARTIALLY FIXED** | Login and MFA verification are rate limited per IP and per subject; self-service enrolment and disable paths are not uniformly limited, and pending enrolment secrets are regenerated on each call |
| SEC-16 | Medium | **PARTIALLY FIXED** | Resend configuration and verified sender domains are present in production; failed delivery removes the undelivered token and the account stays pending and resendable. Missing: durable outbox and bounded retries, deployment preflight, operator alerting |

## Residual risks A–I

| Item | Status |
| --- | --- |
| A. Runtime reachability of SEC-01 | Not tested dynamically against a staging deployment in this pass; the static proof is strong but runtime confirmation remains outstanding |
| B. Financial and MFA concurrency on PostgreSQL | SEC-03 lock verified; SEC-06/07/step-up concurrency cannot be demonstrated until those models exist. Note: `tests/pg-financial-corrections.test.ts > allows only one concurrent daily-account correction` has been failing on `main` since 2026-11-16 and needs its own investigation |
| C. Security-event retention and alerting | Events persist in `AuditLog`/`PlatformAuditLog`; retention, immutability and operator alerting are not implemented |
| D. Break-glass platform recovery | Step-up, reason capture and audit exist for recovery actions; second-person approval and notification fan-out are not implemented |
| E. Financial dual control | Not implemented; single-administrator tenants rely on step-up and audit |
| F. First MFA enrolment | Enrolment is bound to a login challenge with a consumed server-side proof; enrol/disable notification is not implemented |
| G. Offline device protection | Existing AES-GCM/PBKDF2 protection and unlock gates unchanged; the tamper/replay/cross-tenant test expansion was not performed |
| H. Service worker and tab proof | Fail-closed tab assertions unchanged; blocked-service-worker UX and replay tests were not re-run |
| I. Dynamic testing | No ZAP/Semgrep/Trivy run in this pass, and no production scanning, per instruction |

## Release position

This branch is **not** ready to merge under the stated definition of done. SEC-04, SEC-07,
SEC-14 and the SEC-06 idempotency half remain open, and several residual items are
unaddressed. The branch improves the baseline (SEC-05 code, SEC-06 validation and
integrity, SEC-09, SEC-10, SEC-12) without regressing existing behaviour.
