# CSP Assessment — Nonce Feasibility

**Date:** 2 November 2026
**Branch:** `feat/bloomcore-ux-offline-reliability`
**Decision:** Keep enforced CSP with `'unsafe-inline'` in `script-src`; remove
`'unsafe-eval'` from production. A nonce migration is documented but not applied.

## Current policy

`next.config.ts` sends an enforced `Content-Security-Policy` with:

- `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com`
- `'unsafe-eval'` only when `NODE_ENV=development`
- `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`
- `frame-src https://challenges.cloudflare.com`
- `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
  `frame-ancestors 'none'`

`'unsafe-eval'` was previously shipped in production. Next.js documentation is
explicit that React/Next.js do not use `eval` in production; it is needed only
for development error reconstruction. Removing it in production narrows the
policy without changing rendering.

## Why a nonce was not applied now

Next.js 16 applies nonces only during server-side rendering of dynamically
rendered pages. The proxy must generate a nonce, set it in the request CSP
header and optionally `x-nonce`, and every page must render per request.
Consequences measured against this repository:

1. **Static pages would become dynamic.** The production build currently emits
   static pages for the marketing site and several authenticated entry screens
   (`/`, `/features`, `/solutions`, `/privacy`, `/terms`, `/login`,
   `/recover-account`, `/reset-password`, `/select-workspace`, `/susu/admin/*`,
   `/worker/dashboard`, and others). Nonce CSP disables static optimisation and
   ISR for all of them.
2. **Caching changes.** Static assets/pages can no longer be served from the CDN
   cache as they are today; every HTML response is generated per request. Render
   cost and latency increase on the Render instance.
3. **Partial Prerendering is incompatible** with nonce-based CSP; the static
   shell cannot carry the request nonce.
4. **Middleware is the app's authorization boundary.** It already parses
   sessions for every protected path. Adding CSP generation there is possible,
   but the matcher must exclude `api`, `_next/static`, `_next/image` and
   prefetches; the current middleware matcher covers the whole app.
5. **Turnstile** loads from `https://challenges.cloudflare.com`. With
   `'strict-dynamic'`, the loader must be nonce-tagged and allowed to inject the
   widget script. Current code uses the documented implicit loader, which works
   under host allow-listing. A nonce migration needs a Turnstile regression test
   in production-like conditions.
6. **Inline styles** come from Tailwind's generated stylesheet and a small
   number of inline `style` attributes (skeleton sizes, chart sizing). A
   nonce-only `style-src` would fail unless those attributes are removed or
   hashed. That is a wider UI refactor than this assignment allows.

## Options

| Option | Security gain | Cost / risk | Recommendation |
|---|---|---|---|
| Keep `'unsafe-inline'`, drop `'unsafe-eval'` in production | Removes `eval` execution; keeps enforced host allow-list | None observed; build and tests pass | **Applied** |
| Nonce + `'strict-dynamic'` for all pages | Blocks injected inline script even with an HTML injection | Every page dynamic, CDN caching lost, Turnstile and inline-style work, PPR disabled | Separate, planned migration |
| Nonce only for authenticated app routes, static marketing unchanged | Medium | Two policies; marketing pages keep `'unsafe-inline'`; proxy complexity; inconsistent coverage | Not worth the split |
| Experimental SRI hashes | Static generation preserved | Next.js experimental feature; hashes cannot cover dynamically injected scripts; not production-proven here | Monitor upstream |
| Hash allow-list for inline bootstrap scripts | Removes `'unsafe-inline'` | Next.js bootstrap script content/order changes per build and route; brittle; requires build-time integration | Not viable now |

## Recommended migration path

1. Confirm the business accepts loss of static rendering for public pages.
2. Add a proxy (middleware) branch that generates a per-request nonce only for
   HTML navigations, excluding APIs, `_next` assets and prefetches.
3. Read `x-nonce` in the root layout for any manually rendered `<Script>`.
4. Replace inline `style` attributes with classes or nonce-tagged styles.
5. Verify Turnstile in a staging environment, including the challenge iframe
   and `connect-src` probes.
6. Add CSP violation reporting to a protected endpoint.
7. Roll out in report-only first, then enforce, with a rollback flag.

## Verification

- `npm run build` passes with the production policy (no `'unsafe-eval'`).
- No CSP relaxation was introduced; the enforced host allow-list is unchanged.
- This document does not claim that `'unsafe-inline'` is harmless. It is a
  documented residual weakness.

## Closeout recheck — 2 November 2026

The policy was rechecked after the production rendering fix. A nonce still
requires every statically prerendered page to become dynamic, and inline style
attributes used by the UI would fail a nonce-only `style-src`. No safe partial
removal was found. `script-src 'unsafe-inline'` remains an accepted residual;
`'unsafe-eval'` is still development-only. Production build and authenticated
pages were re-tested and render correctly under the enforced policy.
