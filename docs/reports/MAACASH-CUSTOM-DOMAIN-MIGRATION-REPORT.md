# MaaCash Custom Domain Migration Report

**Date:** 9 November 2026
**PR:** [#33](https://github.com/Delkay-byte/BloomCore-One/pull/33)
**Merged commit:** `aeaefa56deb1be93d3924187b72ab1a926b932ff`
**Primary deployment:** `dep-dbp182mtlv9c73f5tvg0` — **live**
**Canonical public URL:** `https://maacash.bloomcoretech.com`
**Previous Render URL:** `https://maacash.onrender.com`
**Fallback URL:** `https://bloomcore-one.onrender.com`

---

## 1. Outcome

`https://maacash.bloomcoretech.com` is the canonical MaaCash origin. Public
metadata, Open Graph/Twitter URLs, `sitemap.xml` and `robots.txt` use that
origin. The primary `maacash` Render service serves the reviewed merge commit.

The old Render hosts remain reachable and are not redirected. They serve the
same application with a visible transition notice, so a device can synchronize
financial records that were queued on the previous origin. No offline storage,
cookie or service-worker cache was moved between origins.

## 2. Verified state before the change

| Item | Value |
|---|---|
| Git branch | `docs/maacash-release-evidence-final` (clean) |
| `origin/main` | `31b947083da72659c49282ba31823e8b8997e5d4` |
| Primary service | `maacash` — `srv-dbnaciff3r2c7382tjgg` |
| Primary live deployment | `dep-dbp0cpbl550s73eokgh0` — `5c3888b988c754b8ae414586815f88ea8845800e` |
| Custom domain | `maacash.bloomcoretech.com` — `cdm-dboefs6c6qcc73de4ijg`, verification status **verified** |
| Fallback service | `bloomcore-one` — `srv-dbjalrk9v7es739ifkp0`, live at `31b9470` |
| Production `SITE_URL` | `https://maacash.onrender.com` |
| Production `NEXT_PUBLIC_SITE_URL` | `https://maacash.onrender.com` |
| Production `NEXTAUTH_URL` | `https://maacash.onrender.com` |
| Turnstile hosts | `bloomcore-one.onrender.com,maacash.onrender.com` |

The custom domain was already attached and verified, but the production
environment still named the Render hostname as the public origin. The live
page therefore emitted:

```html
<link rel="canonical" href="https://maacash.onrender.com"/>
<meta property="og:url" content="https://maacash.onrender.com"/>
```

The sitemap and robots file did the same. The cause was application
configuration, not a missing Render custom domain or a redirect loop.

## 3. DNS and TLS

| Check | Result |
|---|---|
| Public DNS | `maacash.bloomcoretech.com` resolves to Cloudflare edge addresses `104.21.54.112` and `172.67.138.55` |
| Authoritative nameservers | `rudy.ns.cloudflare.com`, `arya.ns.cloudflare.com` |
| Record mode | Proxied Cloudflare record; authoritative answers return A records at the edge |
| Render verification | **verified** for custom domain `cdm-dboefs6c6qcc73de4ijg` |
| HTTPS through Cloudflare | HTTP 200, TLS verification result `0`, no redirects |
| HTTPS direct to Render origin | HTTP 200 through `216.24.57.16` with SNI `maacash.bloomcoretech.com` |
| Certificate subject | `CN=maacash.bloomcoretech.com` |
| Certificate SAN | `DNS:maacash.bloomcoretech.com` only |
| Issuer | `CN=WE1, O=Google Trust Services, C=US` |
| Validity | 2026-11-08T20:22:12Z to 2027-02-06T21:22:10Z |
| Redirect loop | None; custom domain returns 200 without a redirect |

No DNS record was created or changed during this task. The Cloudflare API token
available to this session can read the zone but does not have DNS-record read
permission, so the literal proxied CNAME target could not be printed. That value
was not guessed. The operational proof is stronger: Render reports the domain
verified, the custom hostname reaches the primary Render service, and that
service reports the intended commit. If the owner wants the literal target
recorded in future evidence, grant the automation token `Zone.DNS:Read`.

The certificate is managed at the Cloudflare/Render edge. Its current lifetime
and valid chain were verified. No certificate-renewal event was waited for, so
this report does not claim to have observed an automatic renewal.

## 4. Production environment changes

Only the primary `maacash` service (`srv-dbnaciff3r2c7382tjgg`) was changed.

| Variable | Before | After |
|---|---|---|
| `SITE_URL` | `https://maacash.onrender.com` | `https://maacash.bloomcoretech.com` |
| `NEXT_PUBLIC_SITE_URL` | `https://maacash.onrender.com` | `https://maacash.bloomcoretech.com` |
| `NEXTAUTH_URL` | `https://maacash.onrender.com` | `https://maacash.bloomcoretech.com` |
| `TURNSTILE_ALLOWED_HOSTNAMES` | `bloomcore-one.onrender.com,maacash.onrender.com` | `maacash.bloomcoretech.com,maacash.onrender.com,bloomcore-one.onrender.com` |

No secret, database URL, payment key or credential was read into Git, printed
in this report, or changed.

The fallback service configuration was left untouched. It remains an independent
recovery service on `bloomcore-one.onrender.com` with its existing settings.

## 5. Application changes

- `src/lib/site.ts`
  - Canonical production origin is `https://maacash.bloomcoretech.com`.
  - Render deployments default to the custom domain if `SITE_URL` is missing.
  - Local development defaults to `http://localhost:3000` and suppresses
    canonical metadata.
  - Staging keeps its dedicated staging base URL and stays non-canonical.
  - Old Render hostnames are recognised for the transition notice.
- `src/app/layout.tsx` + `src/components/LegacyHostNotice.tsx`
  - Old-host requests receive a server-rendered migration notice.
  - The notice tells users to synchronize unsynchronized offline records on the
    old address, sign in again on the new address, prepare offline access again,
    and keep local records until server synchronization is confirmed.
  - No redirect, storage copy, cookie copy or cache deletion was added.
- Metadata, sitemap and robots follow `SITE_URL`, so production now emits the
  custom domain.
- The Turnstile default host list includes the custom domain and both transition
  hosts. Production also sets the explicit environment value.
- `NEXTAUTH_URL` remains the source for application-generated payment return
  URLs and the trusted same-origin check. The same-origin rule still rejects
  untrusted origins; no wildcard was added.
- Payment webhook signature verification, reconciliation rules and provider
  secrets were not changed.
- Cookie names, host-only cookie scope, tab-session proof-of-possession and
  offline authorization were not changed.

No Paystack dashboard setting, Turnstile widget setting, OIDC provider
registration or Cloudflare DNS record was changed. Those external dashboards
were not accessed.

## 6. Tests

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS — 0 errors, existing warnings only |
| `npm test` | PASS — 73 files, 736 tests |
| `npm run build` | PASS |
| Playwright `security-headers` + `maacash-landing` | PASS — 9 tests |
| Playwright mobile/offline project | PASS — 3 tests, including collector offline prepare/reload/restore |
| Live custom-domain spec | PASS — 6 read-only tests |
| GitHub CI | PASS on merged commit `aeaefa5`; an initial mobile job failed during `npm ci` with a network `ECONNRESET`, then passed on rerun |

New tests cover:

- Production canonical metadata, Open Graph and Twitter images on the custom
  domain.
- Render default and local-development default behaviour.
- Staging remaining on its own origin and non-canonical.
- Sitemap and robots using the custom domain only.
- Absolute URL generation.
- Old-host detection, notice eligibility and staging exclusion.
- Same-origin acceptance of the custom domain and both transition hosts, and
  rejection of an untrusted origin.
- Render blueprint values for the canonical origin and transition hostnames.
- Opt-in live checks for metadata, sitemap, robots, health, readiness, routes,
  authentication boundaries, manifest, service-worker registration, old-host
  reachability and the transition notice.

## 7. Production verification

Verified against `https://maacash.bloomcoretech.com` after deployment:

| Route / check | Result |
|---|---|
| `/api/health` | 200 — `status: ok`, `env: production`, commit `aeaefa5` |
| `/api/health/ready` | 200 — `status: ready`, `database: ok` |
| `/` | 200 |
| `/login` | 200 |
| `/admin/login` | 200 |
| `/privacy` | 200 |
| `/terms` | 200 |
| `/features` | 200 |
| `/solutions` | 200 |
| `/sitemap.xml` | 200, all URLs on the custom domain |
| `/robots.txt` | 200, sitemap on the custom domain |
| Unauthenticated `/api/auth/me` | 401 |
| Unauthenticated `/admin/dashboard` | 307 redirect to `/login` |
| Redirect loop | None |
| `maacash.onrender.com` in public HTML | 0 occurrences on all checked public pages |
| Canonical link | `https://maacash.bloomcoretech.com` and path-specific canonical URLs |

### Old-host transition

Verified against `https://maacash.onrender.com`:

| Check | Result |
|---|---|
| `/` | 200, no redirect |
| `/login`, `/admin/login`, `/privacy`, `/terms`, `/features`, `/solutions` | 200 |
| `/api/health` | 200, commit `aeaefa5` |
| `/api/offline/sync-contribution` | 405 to GET; route exists and keeps its method/auth contract |
| Transition notice | Present (`data-maacash-legacy-host-notice="true"`) |
| Old-host canonical link | Points to `https://maacash.bloomcoretech.com` |
| Blanket redirect | None |

Notice text rendered on the old host:

> MaaCash has moved to maacash.bloomcoretech.com. Before you switch:
> synchronize any unsynchronized offline records on this old address while it is
> still available. Then sign in online again on the new address and prepare the
> device for offline use there. Locally saved financial records stay on this
> device until server synchronization is confirmed.

### PWA and offline

| Check | Result |
|---|---|
| `/manifest.json` | 200; `id` and `start_url` are `/workspace`, `scope` is `/`, icons present |
| `/tab-session-sw.js` | 200; fetch handler present |
| Service-worker registration on the custom origin | Registered and active in a live Chromium session; scope `https://maacash.bloomcoretech.com/` |
| Local offline shell test | PASS — online preparation, offline reload, cached session restore |
| New-origin login and offline preparation with a real operator account | Not performed in this task; no production credential was used |
| Physical Android installation | Not performed; no Android device or emulator was tested |

The repository's automated mobile test proves the worker's prepare/reload/restore
flow in Chromium. It does not prove a physical-device installation, and this
report does not claim one.

## 8. Offline financial-record protection

Cookies, IndexedDB, Cache Storage and PWA installation are origin-scoped. The
old and new hostnames are different origins, so nothing moved automatically.

- There is no 301/308 redirect from `maacash.onrender.com`.
- The old host remains live and signed-in users can still reach synchronization
  routes.
- The old-origin service worker and caches were not deleted.
- The new origin requires a fresh online sign-in and fresh offline preparation.
- Pending financial records remain on the old device until server
  synchronization confirms them.
- No authentication cookie, session token, IndexedDB record or key was copied
  across origins.
- No claim is made that existing offline data was migrated.

The old hostname may be retired only after the owner confirms affected users'
pending records have synchronized.

## 9. Remaining owner actions

1. Tell operators and field users to synchronize pending offline records on the
   old address before switching to the custom domain.
2. Confirm each affected device has signed in online and prepared offline access
   again on `https://maacash.bloomcoretech.com`.
3. Approve removal of the old hostname only after that confirmation.
4. If a physical Android installation must be accepted, test it on an actual
   device or emulator.
5. Optionally grant `Zone.DNS:Read` to the Cloudflare automation token if the
   literal proxied DNS target must be recorded.

## 10. Definition-of-done status

- [x] Custom domain verified on the primary Render service
- [x] DNS resolves and HTTPS/TLS works
- [x] Production canonical URL configuration corrected
- [x] Public metadata, sitemap and robots use the custom domain
- [x] Payment return URL and same-origin origin use the custom domain
- [x] Trusted-origin allow-lists include only the custom domain and transition hosts
- [x] Service-worker registration works on the new origin
- [x] Offline authorization and synchronization security unchanged
- [x] Old-origin records protected by a no-redirect transition
- [x] Old hostname remains usable
- [x] Typecheck, lint, tests, build and CI pass
- [x] Focused PR merged
- [x] Primary Render service deployed with `aeaefa5`
- [x] Production routes, health and readiness verified
- [ ] Physical Android installation explicitly tested (not performed)
- [x] Migration report records actual evidence
