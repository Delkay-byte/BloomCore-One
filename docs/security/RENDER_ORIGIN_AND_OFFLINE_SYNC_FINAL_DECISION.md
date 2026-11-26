# Render origin and offline-sync final decision

Date: 25 November 2026. Live Render setting **not changed**.

Trace (`Verified in code`): offline client state and cached page requests are
origin-bound; `render.yaml:13-15` explicitly keeps `maacash.onrender.com`
reachable for legacy offline-device sync. The custom domain is canonical in
`same-origin.ts`, Turnstile allow-list and sitemap/robots metadata.

Decision: do **not** disable the default Render subdomain yet. The custom domain
can serve current application code and tab-session transport, but installed
offline clients and cached requests may still reference the old host. No live
probe of those installed devices was possible.

Required transition before disabling:

1. Confirm no queued offline record, cached page or installed client targets
   `maacash.onrender.com`.
2. Run a compatibility period with both hosts reachable and log requests by host.
3. Migrate remaining devices to `https://maacash.bloomcoretech.com`.
4. Only then add `renderSubdomainPolicy: disabled` in an approved change window
   and verify custom-domain `200` and default-host `404`.

Edge proof (`EDGE_PROXY_SECRET`) must be configured at Cloudflare before
per-IP identity is trusted; currently identity fails closed to `unknown`.

Status: **Owner action required**; residual risk accepted pending migration.
