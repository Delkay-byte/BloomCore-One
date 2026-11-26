# Retired Render hostname compatibility report

Date: 26 November 2026. Live read-only checks only.

## Verification (`Verified live`)

- `https://maacash.bloomcoretech.com/` → 200.
- `/api/health` → 200 `{"status":"ok"}`; `/api/health/ready` → 200
  `{"status":"ready"}`.
- `/privacy`, `/login`, `/tab-session-sw.js` → 200.
- `https://maacash.onrender.com/api/health` → **404** (retired).
- Live deployment smoke: 4 canonical-origin checks passed; 2 legacy-host checks
  skipped by design.

Cloudflare response headers (`Server: cloudflare`, `CF-RAY`,
`cf-cache-status: DYNAMIC`, strict CSP/HSTS) were observed. They prove the edge
is in path, not that WAF/bot rules are configured.

## Compatibility conclusion

Ordinary application and offline-sync code no longer depends on the old host.
The deprecated link was removed from active UI. No Render setting was changed,
disabled or re-enabled. The old host is not an active fallback.

If an installed browser still holds unsynchronised offline records under the
retired origin, those records cannot be read from the custom origin. Recovery
would require a temporary authenticated migration bridge on the old origin.
That is a production infrastructure change and is **not authorised** in this
task; it remains an owner decision. No queued financial record was deleted,
rewritten or marked complete.
