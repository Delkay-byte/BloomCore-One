# Render origin and trusted-proxy remediation

Date: 25 November 2026. Release remains **HELD**. No live provider setting was
changed.

## 1. Verified request path and pre-change defect

`Verified in config` / `Verified in code`:

- `render.yaml:13-15` keeps `maacash.onrender.com` reachable for offline-device
  sync; `render.yaml:79-80` sets `TRUSTED_PROXY_HEADERS=true`.
- `src/lib/security/client-ip.ts` previously accepted a raw
  `cf-connecting-ip` header whenever proxy mode was on. A direct request to the
  Render origin could choose and rotate its own IP bucket.
- `X-Forwarded-For` and `X-Real-IP` were already ignored; `True-Client-IP`
  required explicit opt-in.

The structural defect was that a header name was treated as proof of a trusted
edge. Live direct-origin reachability was not tested and is `Unverified`.

## 2. Implemented design (`Verified in code`)

`getClientIp()` now trusts `CF-Connecting-IP` only when the same request carries
`x-bloomcore-edge-auth`, an HMAC-SHA256 over that exact IP using `EDGE_PROXY_SECRET`.
The secret is server-side and is never sent to the browser. Comparison is
constant-time. A missing, malformed or wrong proof fails closed to a shared
`unknown` bucket. `True-Client-IP` still requires `TRUST_TRUE_CLIENT_IP=true`
and its own proof over that IP.

Consequences:

- A direct-origin caller cannot select or rotate its rate-limit identity with
  client-supplied headers.
- Account-keyed throttles, Turnstile and tenant/session authorisation remain
  the primary abuse controls for unauthenticated routes.
- Until the Cloudflare edge is configured to add the proof header, per-IP
  buckets collapse to `unknown`. This is a deliberate fail-closed degradation,
  not a claim that per-IP throttling is active.

Regression tests in `tests/security-hardening-round2.test.ts` and
`tests/security-hardening.test.ts` prove forged `CF-Connecting-IP`, mismatched
proofs, missing secrets, `X-Forwarded-For`, `X-Real-IP` and `True-Client-IP`
cannot choose the caller's IP. Result: **all passed**.

## 3. Render default subdomain (`Owner action`)

`renderSubdomainPolicy: disabled` was NOT added to the blueprint. The blueprint
deliberately keeps `maacash.onrender.com` reachable for legacy offline-device
sync, and no migration of those devices was verified. Disabling it now could
break legitimate field traffic and provider callbacks.

Owner action before disabling:

1. Confirm no callback, health check, webhook, offline sync device or customer
   integration uses `maacash.onrender.com`.
2. Add `renderSubdomainPolicy: disabled` to the Render service in
   `render.yaml` and apply through the Render dashboard/API during an approved
   change window.
3. Verify the custom domain still serves `200` and the default subdomain
   returns `404`.
4. Keep `autoDeploy` disabled while the release is held.

Status: **Unverified live**; source config unchanged by design.

## 4. Cloudflare edge proof (`Owner action`)

Add an edge rule/Worker on the zone that sets
`x-bloomcore-edge-auth: HMAC_SHA256(EDGE_PROXY_SECRET, cf_connecting_ip)` for
requests to the custom domain, and configure the same `EDGE_PROXY_SECRET` in
the Render service environment. Use log/simulate mode first and verify that
login, onboarding, MoMo/Susu journeys, customer portal, callbacks and exports
still work. Do not enable a blanket challenge. Until verified, the application
uses the `unknown` bucket.
