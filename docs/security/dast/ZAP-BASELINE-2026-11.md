# DAST Baseline Result — OWASP ZAP

**Date:** 2 November 2026
**Target:** local production build of this branch (`next start`, isolated test database)
**Tool:** `ghcr.io/zaproxy/zaproxy:stable` `zap-baseline.py`
**Mode:** unauthenticated baseline, 1-minute spider, 2-minute passive limit, `-I`
**Raw reports:** `zap-baseline.html`, `zap-baseline.json` (this directory)

## Result

| Outcome | Count |
|---|---|
| FAIL | 0 |
| WARN | 7 |
| PASS | 61 |

The scan does not replace an authenticated assessment or an independent
penetration test. It covered the public surface only: marketing pages, login,
recovery routes and unauthenticated redirects.

## Warnings and disposition

| Rule | Finding | Disposition |
|---|---|---|
| 10055 | CSP allows `'unsafe-inline'` in `script-src` | Known residual risk. Nonce migration assessed in `../CSP-ASSESSMENT.md`; `'unsafe-eval'` was removed from production. |
| 10024 | Sensitive information in URL | Scanner-injected form fields appended as query parameters to `/reset-password` and `/recover-account`; the application does not put tokens in URLs. No change. |
| 10031 | User-controllable HTML attribute | `?role=` is validated against the four allowed role keys before use. The reflected value is a fixed enum. False positive, verified in `UnifiedLoginClient`. |
| 10019 | Content-Type missing on 307 redirects | Proxy-generated redirects have no body. Cosmetic; no data exposure. |
| 10049 | Non-storable content | Expected: authenticated and login responses use `no-store`; marketing assets are immutable. |
| 10109 | Modern web application | Informational (client-side routing). |
| 90004 | COEP header missing | Intentional; COOP and CORP are set. Adding COEP would require every cross-origin resource to opt in and is not needed for this app. |

## Not covered

- Authenticated routes and role-based access control.
- Financial actions, idempotency or offline synchronization.
- MFA enrolment/verification flows.
- High-volume or destructive payloads.

Those require the controlled staging environment and test accounts described in
`../PENTEST-READINESS.md`. No scan was run against production.
