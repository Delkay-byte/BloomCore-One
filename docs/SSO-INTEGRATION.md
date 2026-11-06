# Platform SSO Integration (BloomCore Identity)

Single sign-on for the **platform super admin** (the BloomCore owner) against the
central identity provider (Control Center / Authentik). Local password login for
the platform console keeps working unchanged; every other login surface
(tenant/worker/collector/customer) is untouched.

**Status: feature-flagged, default OFF.** With `PLATFORM_OIDC_ENABLED=false`
(this is the default) the SSO routes return 404, the login page shows no SSO
button, and behaviour is byte-identical to before this feature existed.

---

## 1. Design

```
Browser                     BloomCore One                     Authentik          Control Center
   │  GET /platform/login/sso/start   │                            │                    │
   │─────────────────────────────────>│  discovery (cached)        │                    │
   │  303 → authorize URL             │───────────────────────────>│                    │
   │  <─ flow cookie (state/nonce/    │                            │                    │
   │      PKCE verifier, HMAC-signed) │                            │                    │
   │  user authenticates at the IdP   │───────────────────────────>│                    │
   │  303 → /platform/login/sso/      │<── code + state ───────────│                    │
   │      callback?code&state         │                            │                    │
   │─────────────────────────────────>│  token exchange (PKCE)     │                    │
   │                                  │───────────────────────────>│                    │
   │                                  │  validate ID token (JWKS:  │                    │
   │                                  │  exact iss, aud==client_id,│                    │
   │                                  │  exp/iat ±30s, single-use  │                    │
   │                                  │  nonce, verified email)    │                    │
   │                                  │  GET {CC}/api/v1/products/ │                    │
   │                                  │  bloomcore-one/linking/    │                    │
   │                                  │  resolve?email=…  ────────>│  none | pending |  │
   │                                  │                            │  verified          │
   │  none     → login?error=sso_not_authorised (audited, no session) │                   │
   │  pending  → /platform/login/sso/confirm?attempt=… (password proof)                   │
   │  verified → native platform session minted via setPlatformSession()                  │
```

Key properties:

* **Authorization Code + PKCE (S256)**. No implicit flow; tokens never touch the
  browser.
* **Single-use flow.** `state`, `nonce` and the PKCE verifier travel in an
  HMAC-SHA256-signed cookie (`bik-platform-oidc-flow`, HttpOnly,
  SameSite=strict, Secure in production, path-scoped to `/platform/login/sso`,
  10-minute TTL). The callback deletes it on every response, so a replayed
  callback cannot reuse the nonce or verifier.
* **Strict ID-token validation** (Node runtime only): exact issuer match,
  `aud == client_id`, 30-second clock leeway, RS/PS/ES algorithms only (never
  HS/shared-secret), nonce single-use, and a present, non-`false`
  `email_verified` claim.
* **Native sessions.** Sign-in mints the platform JWT through
  `setPlatformSession()` — same claims (`kind:"platform"`, `tokenUse:"platform"`,
  `amr`, `jti`, `tokenVersion`), same cookie, same `SessionRecord` registry row
  as a local login. Middleware, `getPlatformSession()` and every platform guard
  work unchanged.
* **amr mapping.** The IdP-attested `amr` array is mapped onto the platform
  token's `amr` literal: any IdP second factor (mfa/otp/totp/webauthn) →
  `"pwd+mfa"`, password-only → `"pwd"`. The raw IdP list is carried in an extra
  `idpAmr` claim for auditability. When `MFA_ENFORCEMENT=enforce`, a
  password-only IdP session is refused (`platform.sso_denied`,
  reason `mfa_required`), exactly like the local path.
* **Suspended admins are denied** (`status !== "active"`) even with a verified
  link.
* **Auditing.** `PlatformAuditLog` events: `platform.sso_start`,
  `platform.sso_success`, `platform.sso_denied`, `platform.sso_link_created`,
  `platform.sso_link_failed`. No tokens or secrets are logged.

### Linking model

`PlatformOidcLink` (additive; both `prisma/schema.prisma` and
`prisma/schema-pg.prisma`) binds one IdP subject (`idpSub`, unique) to one
`PlatformSuperAdmin`:

| linkedVia                 | how it is created                                                            |
|---------------------------|------------------------------------------------------------------------------|
| `cc_verified`             | Control Center reports `verified` (the owner already confirmed it centrally). The product mirrors the link automatically. |
| `local_credential_proof`  | Control Center reports `pending`; the admin completes `/platform/login/sso/confirm` by entering their **current local platform password**. |

The `pending` confirm step:

1. Callback redirects to `/platform/login/sso/confirm?attempt=<HMAC token>`
   (10-minute TTL) carrying the IdP subject + emails — no secrets.
2. The confirm page (server action) verifies the password against the
   `PlatformSuperAdmin` matched by the IdP-asserted email, with a progressive
   cooldown (`AuthThrottle`) on failure.
3. On success the link is created and a signed proof is sent to the Control
   Center: `POST {CC}/api/v1/products/bloomcore-one/linking/confirm` with
   `{payload, signature}` where `payload` is the exact JSON
   `{"product":"bloomcore-one","identity_sub":…,"email":…,"product_admin_email":…,"ts":…}`
   and `signature` is `HMAC-SHA256(payload, product API key)` (hex). The CC
   enforces a ±300 s window.
4. No session is minted at confirm time; the admin completes sign-in via SSO
   afterwards (the "Account linked" notice is shown on the login page).

### Logout

`platformLogout` already revokes the `SessionRecord` and clears the cookie.
Additionally, the SSO session's IdP refresh token (if the IdP issued one, i.e.
the `offline_access` scope was granted) is stored **encrypted (AES-256-GCM) in
`PlatformOidcSession`** keyed by the session `jti` — never in cookies. On
logout the row is deleted and a best-effort revocation request is sent to the
IdP's `revocation_endpoint`. Central revocation failure never blocks local
logout.

### CSP

No CSP change was required. The SSO redirect is a **top-level navigation** to
the IdP, which CSP does not restrict (`form-action 'self'` only governs form
submissions; the entry point is a plain link), and the token exchange happens
server-side (Node fetch), outside the browser.

---

## 2. Configuration

All env-prefixed, all default OFF (see `.env.example`):

| Variable                      | Meaning                                                       |
|-------------------------------|---------------------------------------------------------------|
| `PLATFORM_OIDC_ENABLED`       | `false` by default. Master switch.                            |
| `PLATFORM_OIDC_ISSUER`        | Exact IdP issuer, e.g. `http://localhost:9000/application/o/bloomcore-one/` (trailing slash matters — it must equal the `iss` claim byte-for-byte). |
| `PLATFORM_OIDC_CLIENT_ID`     | OAuth2 client id (`bloomcore-one-sso`).                       |
| `PLATFORM_OIDC_CLIENT_SECRET` | OAuth2 client secret. Never commit.                           |
| `PLATFORM_OIDC_CC_BASE`       | Control Center base URL, e.g. `http://localhost:8400`.        |
| `PLATFORM_OIDC_CC_API_KEY`    | Per-product key for `bloomcore-one` (`CC_PRODUCT_API_KEYS` in the CC env). Never leaves the server. |
| `PLATFORM_OIDC_REDIRECT_URI`  | Optional override when behind a rewriting proxy (default `<origin>/platform/login/sso/callback`). |
| `PLATFORM_OIDC_SCOPES`        | Optional; default `openid email profile`. Add `offline_access` if central refresh-token revocation is wanted. |
| `PLATFORM_OIDC_DEBUG`         | Optional; logs validation failure details (claim keys, header alg — no token values) to stderr. |

The routes are live only when the flag is on **and** all five core values are
present.

### Registered redirect URI

Strict match: `http://localhost:3100/platform/login/sso/callback` for local
runs; the production equivalent must be registered in Authentik
(`Providers → bloomcore-one-sso → Redirect URIs`).

### Identity provider requirements

* RS256 (asymmetric) signing key on the provider — HS256 is deliberately not
  accepted. In Authentik set *Signing Key* to a certificate key pair.
* The `email` scope must produce a **verified** email. Note: some Authentik
  versions ship a default email mapping with `email_verified: False`; use a
  mapping that asserts verification (e.g. `BloomCore Identity email (verified)`)
  once the owner's address is confirmed in the IdP.

---

## 3. Operating procedure (first-time linking)

1. Control Center owner declares the association for the product
   (`POST /api/linking/declare` with their identity) — association status
   becomes `pending`.
2. Administrator opens `/platform/login`, clicks **Sign in with BloomCore
   Identity** and authenticates at the IdP.
3. Adapter resolves → `pending` → confirm page. The admin enters the **current
   local platform password** for the console account that matches the IdP email.
4. Adapter creates `PlatformOidcLink` and sends the HMAC proof; CC flips the
   association to `verified`.
5. Subsequent SSO logins resolve `verified` and mint the session directly.

Rollback: set `PLATFORM_OIDC_ENABLED=false` and redeploy. Routes 404, the
button disappears, local login is unaffected. The link/session tables are inert
and can be dropped later.

---

## 4. Testing

`tests/platform-oidc.test.ts` (vitest, synthetic RSA keys, fake IdP + fake CC):

* ID-token validation: valid, bad signature, wrong issuer, wrong audience,
  expired, nonce mismatch, unverified email; amr second-factor classification.
* Flow-cookie HMAC tamper rejection; state mismatch; unsigned cookie.
* Flag off → 404 on start and callback.
* Verified link → native session (claims verified) + `SessionRecord` + refresh
  companion + `sso_success` audit; second-factor mapping to `pwd+mfa` under
  enforcement; password-only + `MFA_ENFORCEMENT=enforce` → denied.
* Unlinked → denied with audit, zero sessions; suspended admin → denied.
* Pending → confirm routing; confirm success (link + CC HMAC proof verified
  byte-for-byte); wrong password; unknown IdP email; expired attempt.
* Local platform login regression (`tests/platform-auth.test.ts`) still passes.

## 5. Live verification record (2026-11-03, local)

* Stack: Authentik `http://localhost:9000` (provider `bloomcore-one-sso`),
  Control Center `http://localhost:8400` (real linking API), app built from this
  branch and served with `next start -p 3100`, SQLite `dev.db`.
* Configured via Authentik admin API: random client secret PATCHed onto the
  provider, RSA signing key selected, strict redirect URI confirmed, verified
  email scope mapping attached, test user `sso-owner-test` created.
* **Deny path (all real):** browser SSO → real IdP login → real code exchange →
  real RS256 ID token validated via JWKS → real CC resolve (product key) →
  `none` → `303 /platform/login?error=sso_not_authorised`; audit rows
  `platform.sso_start` + `platform.sso_denied (not_authorised,
  actorEmail=sso-owner@bloomcore.test)`; 0 `SessionRecord`, 0 links.
* **Session-mint path (real IdP; CC resolve stubbed to `verified` locally):**
  browser SSO → dashboard (`/platform/dashboard` rendered, "Signed in as
  sso-owner@bloomcore.test"); DB rows: `PlatformOidcLink (cc_verified)`,
  `SessionRecord (platform, unrevoked)`, `PlatformOidcSession` companion;
  audits `platform.sso_link_created` + `platform.sso_success`.
* **Logout:** Sign out → SessionRecord revoked (`platform_logout`), companion
  row deleted, `platform.logout` audit.
* **Repeat login:** second SSO run re-used the single link (`link count` stayed
  1) and landed on the dashboard.

## 6. Tab-session handoff

The callback does not write a platform authentication cookie. It puts the
freshly minted session in a 60-second, HttpOnly `bik-sso-handoff` cookie scoped
to `/platform/login/sso`, redirects to `/platform/login/sso/complete`, and the
claim action consumes the cookie exactly once and returns the handle to that
tab's service worker. A copied URL cannot replay it after the claim, and no
other tab inherits the platform session. See `TAB-SESSION-ARCHITECTURE.md`.

## 7. Limitations

* The `pending → confirm` step intentionally does **not** mint a session; one
  more SSO click is required after linking.
* If the Control Center reports `verified` but the local link is missing
  (e.g. database restore), the product re-creates the link automatically,
  trusting the CC status (which itself implies a prior local credential proof).
* Refresh-token revocation only applies when the IdP issues refresh tokens
  (`offline_access` scope); without it, central session lifetime is governed by
  the IdP access-token TTL.
* `PLATFORM_OIDC_DEBUG` logging is for troubleshooting only; it prints claim
  keys and the token header alg, never token values.
