# MaaCash Rebrand — System Inventory

**Date:** 2026-11-06
**Repository:** `https://github.com/Delkay-byte/BloomCore-One`
**Working branch:** `feat/maacash-rebrand`
**Base commit:** `e890cf9` (`origin/main`, merge of PR #15 / tab-session hardening)
**Product:** BloomCore One → **MaaCash**
**Parent company:** BloomCore Technologies (unchanged)

This inventory was completed before destructive or production-facing changes.
It classifies every known occurrence of the old product identity. It is not a
blanket text-replacement plan: identifiers that are technical contracts are
preserved deliberately.

---

## 1. Source control and branches

| Item | Value | Action |
| --- | --- | --- |
| GitHub repository | `Delkay-byte/BloomCore-One` | Rename requires owner approval (see migration report) |
| Production branch | `main` | Unchanged |
| Base SHA used for rebrand | `e890cf9` | Contains PR #14 + #15 independent tab sessions |
| Staging branch | `main`, manual deploys only | Unchanged |
| Commit history | Preserved | No history rewrite |
| CI workflow | `.github/workflows/ci.yml` | Reviewed; no product-name coupling |
| Repository secrets | GitHub Actions secrets | Not read, not printed, not rotated |

**Classification:** infrastructure identifier. A repository rename is safe for
Git history and Render's GitHub integration in principle, but it is an
owner-level action and is not performed by this branch.

---

## 2. Hosting — Render

| Environment | Service name | Public URL | Auto-Deploy | Action |
| --- | --- | --- | --- | --- |
| Production | `bloomcore-one` | `https://bloomcore-one.onrender.com` | **ON — After CI Checks Pass** | Preserve for now |
| Staging | `bloomcore-one-staging` | `https://bloomcore-one-staging.onrender.com` | **OFF** | Preserve for now |

- Region: Oregon. Plan: free. Cold starts accepted; no keep-alive added.
- Service IDs are intentionally omitted from this document.
- The service name controls the default `onrender.com` hostname. Renaming a
  Render service is not a display-only change: it changes that hostname.
- The following are bound to the current hostname:
  - Paystack webhook: `https://bloomcore-one.onrender.com/api/payments/paystack/webhook`
  - Turnstile host allow-list (`TURNSTILE_ALLOWED_HOSTNAMES`)
  - OIDC redirect URI (defaults to the request origin)
  - `NEXTAUTH_URL` / `SITE_URL` values in the dashboard
- **Decision:** keep `bloomcore-one` and `bloomcore-one-staging` until an
  owner-approved domain migration exists. Product identity changes in the UI,
  metadata, PWA and documentation now. Hostname migration is a separate,
  reversible change.

**Classification:** infrastructure identifier. Risk: high if renamed now.
Approval: owner required.

---

## 3. Databases

| Environment | Provider | Access | Schema | Action |
| --- | --- | --- | --- | --- |
| Production | Neon PostgreSQL | `DATABASE_URL` / `DIRECT_URL` (values not read) | `prisma/schema-pg.prisma` | No change |
| Staging | Separate Neon PostgreSQL database | separate secrets | `prisma/schema-pg.prisma` | No change |
| Local/test | SQLite | `DATABASE_URL` | `prisma/schema.prisma` | No change |

- No table, column, enum, index or tenant identifier contains active product
  branding that must change.
- `prisma/schema.prisma` and `prisma/schema-pg.prisma` only mention BloomCore in
  descriptive comments about the platform operator identity and the OIDC link.
- The first tenant remains **BIK Prestige Enterprise** (`BIK-HQ-001`). It is a
  customer business, not the product name. It must not be renamed.
- No migration is authorised by this rebrand. No data was copied, reset or
  rewritten.

**Classification:** database/historical identifiers. Risk: critical if changed.
Approval: separate migration plan required.

---

## 4. Environment variable names

Names only. No values were printed, exported or committed.

`APP_ENV`, `NODE_ENV`, `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`,
`NEXTAUTH_URL`, `APP_URL`, `RATE_LIMIT_HMAC_SECRET`, `MFA_ENCRYPTION_KEY`,
`MFA_ENFORCEMENT`, `SESSION_IDLE_TIMEOUT_SECONDS`,
`SESSION_BACKGROUND_TIMEOUT_SECONDS`, `SESSION_ABSOLUTE_TIMEOUT_SECONDS`,
`TURNSTILE_ENABLED`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`,
`TURNSTILE_ALLOWED_HOSTNAMES`, `TRUSTED_PROXY_HEADERS`, `ALLOWED_ORIGINS`,
`PLATFORM_OIDC_ENABLED`, `PLATFORM_OIDC_ISSUER`, `PLATFORM_OIDC_CLIENT_ID`,
`PLATFORM_OIDC_CLIENT_SECRET`, `PLATFORM_OIDC_CC_BASE`,
`PLATFORM_OIDC_CC_API_KEY`, `PLATFORM_OIDC_REDIRECT_URI`,
`PLATFORM_OIDC_SCOPES`, `PAYSTACK_SECRET_KEY`, `DEEPSEEK_API_KEY`,
`DEEPSEEK_MODEL`, `ZELI_*`, `OFFLINE_COLLECTIONS_ENABLED`,
`OFFLINE_MOMO_ENABLED`, `SITE_URL`, `NEXT_PUBLIC_SITE_URL`, `CONTACT_EMAIL`,
`CONTACT_PHONE`.

**Decision:** no variable is renamed. None contains "BloomCore One". Values
that reference `bloomcore-one.onrender.com` are hostname contracts and are
preserved. A future domain change updates values in the provider dashboard,
not the variable names.

---

## 5. Authentication, sessions and security contracts — DO NOT RENAME

| Identifier | Location | Why preserved |
| --- | --- | --- |
| `bloomcore-one` JWT issuer | `src/lib/auth.ts`, `src/lib/platform-auth.ts`, `src/lib/security/tab-assertion.ts` | Changes invalidate every issued session and tab credential |
| `bloomcore-one:session` | `src/lib/auth.ts` | JWT audience contract |
| `bloomcore-one:workspace-selection` | `src/lib/auth.ts` | JWT audience contract |
| `bloomcore-one:platform` | `src/lib/auth.ts`, `src/lib/platform-auth.ts` | Platform boundary contract |
| `bloomcore-one:mfa-challenge` | `src/lib/security/mfa-challenge.ts`, `src/middleware.ts` | MFA challenge audience |
| `bloomcore-one:tab-assertion` | `src/lib/security/tab-assertion.ts` | Per-tab assertion audience |
| `x-bloomcore-tab-*` headers | `public/tab-session-sw.js`, `src/lib/security/tab-assertion.ts`, `src/lib/auth.ts` | Browser ↔ server tab protocol |
| `bloomcore-tab-sessions` IndexedDB | `public/tab-session-sw.js` | Existing per-tab keys live here |
| `bik-prestige-token` legacy cookie | `src/lib/auth.ts`, `src/middleware.ts` | Cleanup compatibility for old cookies |
| `bik-prestige-offline` IndexedDB + salt | `src/lib/offline/*` | Existing offline drafts must survive |
| `PRODUCT_SLUG = "bloomcore-one"` | `src/lib/security/oidc.ts` | Control Center product registry contract |
| `bik-platform-oidc-flow` cookie | `src/lib/security/oidc.ts` | In-flight SSO flow compatibility |

Display changes that are safe and were made:

- TOTP issuer display name: `BloomCore One` → `MaaCash`. Existing secrets and
  codes still validate; the issuer label is not part of the HMAC.
- All user-facing session/security copy now names MaaCash.

---

## 6. Occurrence classification

Total legacy-name matches in tracked source, docs and scripts (excluding
`node_modules`, `.next`, build output): **526**.

| Class | Examples | Count (approx.) | Action |
| --- | --- | --- | --- |
| 1. Active product branding | UI headings, footers, marketing copy, emails-in-UI, Zeli prompts | 158 `BloomCore One` occurrences | Replaced with **MaaCash** |
| 2. Infrastructure identifier | Render service names, `onrender.com` hostnames, health payload `app` id, Turnstile host, OIDC product slug | 167 `bloomcore-one` occurrences | **Preserved**; documented |
| 3. Authentication/security identifier | JWT issuer/audiences, tab headers, cookie names, IndexedDB names | see §5 | **Preserved** |
| 4. Database/historical identifier | Prisma comments, tenant `BIK Prestige Enterprise`, legacy DB names | 12 | **Preserved** |
| 5. Financial/audit history | Audit records, transaction references, receipts already issued | runtime data | **Never rewritten** |
| 6. Migration compatibility | Legacy cookie cleanup, offline database migration, old `bloomcore-one` DB names | see §5 | **Preserved** |
| 7. Documentation/test fixture | Historical reports, pentest evidence, tests | ~120 | Historical kept; active docs updated; fixtures preserved |
| 8. External integration | Control Center product slug, Paystack webhook URL, OIDC client id | see §2, §5 | **Preserved** until coordinated migration |

### Files changed for active branding

- **App shell and navigation:** `src/components/AppShell.tsx`,
  `src/components/brand/AppBrand.tsx`, `src/components/brand/Brand.tsx`,
  `src/components/marketing/MarketingNav.tsx`,
  `src/components/FirstLoginPasswordForm.tsx`,
  `src/components/OfflineDataSettings.tsx`, `src/components/zeli/ZeliUnavailable.tsx`
- **Auth surfaces:** `src/app/login/UnifiedLoginClient.tsx`,
  `src/app/admin/login/AdminLoginForm.tsx`, `src/app/access/page.tsx`,
  `src/app/forgot-password/page.tsx`,
  `src/app/customer/forgot-password/page.tsx`,
  `src/app/recover-account/page.tsx`, `src/app/select-workspace/page.tsx`
- **Role shells:** `src/app/admin/(workspace)/layout.tsx`,
  `src/app/worker/(workspace)/layout.tsx`,
  `src/app/collector/(workspace)/layout.tsx`,
  `src/app/customer/(portal)/layout.tsx`, `src/app/platform/PlatformShell.tsx`
- **Public site:** `src/app/(marketing)/page.tsx`,
  `src/app/(marketing)/features/page.tsx`,
  `src/app/(marketing)/solutions/page.tsx`,
  `src/app/(marketing)/contact/page.tsx`,
  `src/app/not-found.tsx`
- **Zeli assistant:** `src/lib/zeli/**` display prompts and labels
- **Exports:** CSV download filenames in MoMo/Susu report pages
  (`bik-prestige-*` → `maacash-*`)
- **Metadata/PWA:** `src/app/layout.tsx`, `src/lib/metadata.ts`,
  `src/lib/site.ts`, `public/manifest.json`, `src/app/icon.svg`,
  `public/tab-session-sw.js` comment
- **Brand assets:** `public/branding/maacash-*`, `src/app/apple-icon.png`,
  `src/app/favicon.ico`
- **Build tooling:** `scripts/build-brand-assets.py`,
  `scripts/build-brand-raster.mjs`
- **Config:** `package.json`, `package-lock.json`, `.env.example`,
  `.env.pilot.example`, `render.yaml`, `render.staging.yaml`
- **Tests:** `tests/public-routes.test.ts`, `tests/zeli-conversation.test.ts`,
  `e2e/zeli.spec.ts`

---

## 7. Paystack

- Integration: `src/lib/payments/paystack.ts`,
  `src/lib/payments/zeli-subscriptions.ts`,
  `src/app/api/payments/paystack/webhook/route.ts`.
- Signature verification: HMAC SHA-512 over the raw body.
- Callback URL is derived from `NEXTAUTH_URL` / `APP_URL`; no hostname is
  hard-coded in application code.
- Webhook path is host-relative: `/api/payments/paystack/webhook`.
- Production webhook currently points at the preserved production hostname.
- No key, reference or customer transaction was read or triggered.
- **Action:** none now. Re-point only during an approved domain cutover, after
  the new route is proven.

---

## 8. OIDC / SSO / Control Center

- Module: `src/lib/security/oidc.ts`; routes under
  `src/app/platform/login/sso/`.
- Issuer, client ID, secret and redirect URI come from environment variables.
- The Control Center product slug is the external identity contract
  `bloomcore-one`. It is **not** renamed.
- Existing user identity is based on the immutable `sub`, not email.
- Feature flag `PLATFORM_OIDC_ENABLED` remains in its current approved state.
- **Action:** none now. Redirect URI updates require owner approval and a
  coordinated Control Center change after a custom domain exists.

---

## 9. Email and communications

- **Finding:** this repository contains no email-sending integration
  (no SMTP, Resend, SendGrid, Mailgun or Postmark dependency).
- Password recovery is administrator-assisted; no outbound email template
  exists to rebrand.
- **Action:** none now. If email is added later, sender identity must be
  `MaaCash by BloomCore Technologies` and the domain's SPF/DKIM/DMARC must be
  configured before sending. Verified sender addresses are not changed here.

---

## 10. PWA and service worker

- Manifest: `public/manifest.json` — name, short name, description, icon paths
  updated to MaaCash.
- Icons and maskable icon regenerated under `public/branding/maacash-*`.
- Per-tab authentication worker: `public/tab-session-sw.js`.
  - Scope and registration unchanged.
  - Header names, database name and protocol unchanged.
  - Only the comment header was rebranded.
- No cache-busting change was necessary because the manifest and icon URLs
  changed. Service-worker scope was not altered.
- Domain changes later will be a new browser origin: IndexedDB, service-worker
  registrations and sessions do not migrate automatically. Reauthentication is
  expected at that point.

---

## 11. Documentation classification

**Active documents updated:** `README.md`,
`docs/NEON-RENDER-DEPLOYMENT.md`, `docs/TAB-SESSION-ARCHITECTURE.md`,
`docs/SSO-INTEGRATION.md`, `docs/OFFLINE-RELIABILITY.md`,
`docs/UX-PLATFORM-PATTERNS.md`,
`docs/security/CLOUDFLARE-TURNSTILE-SETUP.md`,
`docs/security/ADMIN-ASSISTED-RECOVERY.md`,
`docs/security/SECURITY-ARCHITECTURE.md`, `docs/security/THREAT-MODEL.md`,
`PRODUCTION-RELEASE-RUNBOOK.md`, `MIGRATION.md`, `SECURITY.md`,
`ADMIN-ACCOUNT-RECOVERY.md`, `.env.example`, `.env.pilot.example`.

**Historical documents preserved with a historical label:**
`docs/BLOOMCORE-ONE-BRAND-AND-WEBSITE.md`, `docs/BRANCH-REVIEW-BLOOMCORE-ONE.md`,
`docs/security/**` pentest and audit evidence, `PILOT-*.md`,
`OFFLINE-*.md`, dated release reports. These describe events that occurred under
the old product name. Rewriting them would falsify the record.

**New documents:**
`docs/branding/MAACASH-REBRAND-INVENTORY.md` (this file),
`docs/branding/MAACASH-DOMAIN-OPTIONS.md`,
`docs/branding/MAACASH-REBRAND-MIGRATION-REPORT.md`.

---

## 12. Risk and approval matrix

| Change | Risk | Approval | Status in this branch |
| --- | --- | --- | --- |
| UI/metadata/PWA rebrand | Low | None beyond normal review | Done |
| Brand asset regeneration | Low | None | Done |
| CSV export filename rebrand | Low | None | Done |
| Test expectation updates | Low | None | Done |
| Package name change | Low | None (private package) | Done |
| Render service rename | High | Owner | **Not done** |
| GitHub repository rename | Medium | Owner | **Not done** |
| Custom domain purchase/DNS | High | Owner | **Not done** |
| Paystack webhook change | High | Owner | **Not done** |
| OIDC redirect URI change | High | Owner | **Not done** |
| Database changes | Critical | Owner + migration plan | **Not done; not needed** |
| Secret rotation | High | Owner | **Not done; not needed** |

---

## 13. Preserved historical facts

- Historical audit logs and transaction records may contain "BloomCore One".
  They are not rewritten.
- Old receipts and exported documents already delivered to customers remain
  valid and unchanged.
- The first business tenant remains **BIK Prestige Enterprise**.
- The parent company remains **BloomCore Technologies**.
- Third-party records (Paystack, Control Center, Render, GitHub) retain old
  identifiers until separately migrated with approval.
