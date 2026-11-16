# MaaCash maintenance guard

A temporary, environment-driven guard that refuses all public application traffic while a production schema migration and its matching application deployment are in flight.

## Why it exists

Render's native Maintenance Mode is only available on paid web services, and suspending this service blocks deployments. Suspending during a build cancels the build. The guard gives the same protection without either limitation: the service stays running and deployable, but no request that could authenticate, issue a session or mutate data is served.

## Behaviour

| `MAINTENANCE_MODE` | Result |
| --- | --- |
| unset, empty, `false`, `0`, `off`, `no`, `disabled` | Guard off. Normal application. |
| `true`, `1`, `on`, `yes`, `enabled` | Guard on. Everything except the exemptions returns `503`. |
| any other non-empty value | Guard **on** (fail closed) |

While the guard is on, every method and every path returns `503` with `Retry-After`, `Cache-Control: no-store` and a locked-down CSP, except:

- `/api/health`
- `/api/health/ready`
- `/_next/static/*`, `/_next/image`, `/favicon.ico` (immutable assets, no authority)

The guard runs in `src/middleware.ts` before CSP setup, session resolution, route rules, API handlers and server actions. Paths are normalised first, so duplicate slashes, dot segments, percent-encoding, trailing slashes and query strings cannot be used to reach a blocked path.

## Deliberately blocked while on

Logins (`/login`, `/admin/login`, `/platform/login`, `/customer/login`), MFA verification and enrolment, email verification, password reset, password upgrade, every workspace page, every `/api/*` route including session, tab-assertion and offline sync endpoints, the platform SSO callback and the Paystack webhook.

### Paystack webhook

Live payments are enabled in production (`PAYSTACK_ENABLED=true`, `PAYSTACK_MODE=live`), so the webhook is blocked only for the duration of the maintenance window. This is safe because the handler verifies the HMAC signature and is idempotent on the provider event id, and Paystack retries undelivered events. Any event that arrives during the window is redelivered after the guard is switched off. Payment records are never written by the guard.

### Zeli provider events

Zeli provider gateway events are pulled and reconciled by the application rather than pushed to a public endpoint, so the guard does not interrupt ingestion.

## Operating procedure

1. Deploy the guard code with `MAINTENANCE_MODE` unset. It is inert.
2. Set `MAINTENANCE_MODE=true` in the Render environment and let the service restart.
3. Confirm every public route returns `503` and both health endpoints still answer.
4. Run the migration, then deploy the application release that matches the new schema.
5. Verify the new release with the guard still on.
6. Set `MAINTENANCE_MODE=false` and confirm normal access.

## Tests

`tests/maintenance-guard.test.ts` covers the state matrix, the exemption matrix, bypass attempts, response headers, JSON negotiation, method coverage and the middleware ordering guarantee.
