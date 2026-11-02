# Authenticated ZAP Passive Baseline — 2026-11

**Target:** local production-mode staging (`http://localhost:3012`)
**Tool:** `ghcr.io/zaproxy/zaproxy:stable` `zap-baseline.py`
**Mode:** spider + passive scan, 1-minute spider, 2-minute passive limit, `-I`
**Session:** a server-minted admin test session (`bik-admin-session` JWT plus a
matching `SessionRecord`) injected through ZAP's header replacer. The minting
helper was used only for the scanner and is not committed.
**Raw reports:** `zap-auth-baseline.html`, `zap-auth-baseline.json`

## Result

| Outcome | Count |
|---|---|
| FAIL | 0 |
| WARN | 8 |
| PASS | 60 |

Authenticated pages were reached (`/admin/dashboard`, `/admin/settings` returned
200), so the session injection worked.

## Warnings and disposition

| Rule | Finding | Disposition |
|---|---|---|
| 10055 / 10038 | CSP `script-src` / `style-src` `'unsafe-inline'` | Known residual, assessed in `../CSP-ASSESSMENT.md`; nonce migration not applied. |
| 10024 | Sensitive information in URL | Scanner-injected `code`/`password`/`token` query values on recovery pages; the application does not place real secrets in URLs. |
| 10031 | User-controllable HTML attribute | `?role=` is validated against a fixed enum before use. False positive. |
| 10019 | Content-Type missing on redirects | Proxy redirects have no body; no data exposure. |
| 10049 / 10050 | Storable/cacheable content | `_next` immutable assets are cacheable; authenticated HTML is `no-store`. Intended. |
| 10040 | Big redirect | Authenticated visit to `/admin/login` redirects to the dashboard with a normal page body. No sensitive data. |
| 10109 | Modern web application | Informational (client routing). |
| 90004 | COEP missing | Intentional; COOP/CORP are set. |

## Not run

Active authenticated scanning was deliberately not run. ZAP's active rules
submit forms; on this application that could create customers, post
contributions or trigger reversals. Manual controlled probes covered the
business-logic surface. Active scanning remains an external-test activity on a
disposable staging copy.

No scan was run against production.
