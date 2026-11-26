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

## Edge proof mechanism (`Owner action`; Worker code prepared locally)

Standard Cloudflare proxying does **not** generate a custom HMAC header. A
Cloudflare Worker bound to the canonical route must add it, and the same secret
must be set in Render:

```js
export default {
  async fetch(request, env) {
    const ip = request.headers.get("cf-connecting-ip") || "";
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(env.EDGE_PROXY_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const headers = new Headers(request.headers);
    headers.set("x-bloomcore-edge-auth", hex);
    return fetch(new Request(request, { headers }));
  },
};
```

Requirements: secret stored as a Workers secret (never in Routing or source),
Worker route limited to the canonical host, no header forwarding from clients,
`log-mode` validation first, then verify that forged direct-origin headers are
rejected. The Worker was not deployed or bound to a secret in this task.

Status: **Owner action required**; residual risk accepted pending migration.
