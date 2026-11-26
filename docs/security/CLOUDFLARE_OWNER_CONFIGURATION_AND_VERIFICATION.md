# Cloudflare DDoS, WAF and bot verification — owner action

Date: 25 November 2026. No authenticated Cloudflare access was available in
this task. Every item below is `Unverified` unless labelled otherwise. No live
setting was changed.

## 1. What is verified

`Verified in code` / `Verified in config`:

- Cloudflare Turnstile is present on protected login/recovery submissions and
  fails closed; it is a bot challenge on those forms, not a zone-wide WAF.
- `render.yaml` enables `TRUSTED_PROXY_HEADERS=true`; the application now
  requires an edge HMAC proof before trusting `CF-Connecting-IP`
  (`docs/security/RENDER_ORIGIN_AND_TRUSTED_PROXY_REMEDIATION.md`).
- `robots.txt` is a crawler preference, not access control. Protected routes
  rely on server-side authentication and authorisation. Search-engine access
  to approved public pages is preserved.

Cloudflare response headers were observed in earlier audits, but that proves
only that DNS is proxied. It does not prove WAF, bot or rate-limit rules are
active.

## 2. Owner verification checklist

For each item, collect a dated screenshot or API response and record it in the
security profile. Do not mark an item closed from a workflow file or a document.

| Item | Where to check | Expected evidence | Plan dependency |
| --- | --- | --- | --- |
| Automatic DDoS mitigation | Cloudflare dashboard → Security → DDoS | Plan tier and "Automatic" status; L3/4 and L7 coverage | All plans include network-layer mitigation; exact L7 controls vary |
| WAF managed rules | Security → WAF → Managed rules | Ruleset name, version, action mode (`Block`/`Managed challenge`) | Free plan managed rules are limited; verify actual entitlement |
| Custom WAF rules | Security → WAF → Custom rules | Rule IDs, expressions, action and log mode | Start in Log/Simulate |
| Edge rate-limit rules | Security → WAF → Rate limiting | Scope, threshold, action, `Retry-After` behaviour | Some plans have a small allowance; do not purchase without approval |
| Bot management / bot fight | Security → Bots | Mode and plan availability | Bot Fight Mode may be free; managed bots require paid plan |
| Security events and alerts | Security → Events / Notifications | Alert destination and sample event | Verify owner receives alerts |
| Origin exposure | DNS + Render service | Default `onrender.com` host reachability; custom domain `200` | Render owner action |
| Edge proof header | Transform Rule / Worker | `x-bloomcore-edge-auth` present on custom-domain requests only | Coordinate with `EDGE_PROXY_SECRET` |

## 3. Safe rollout rules

1. New custom rules start in Log/Simulate. Review false positives for at
   least one business cycle before enabling Block/Challenge.
2. Do not challenge authenticated sessions, APIs, webhooks, payment callbacks,
   health/readiness routes or Ghanaian field-device traffic.
3. Keep narrowly scoped exceptions for provider callbacks and health checks.
4. Test onboarding, login, account recovery, MoMo/Susu journeys, customer
   portal, exports and callbacks in staging or safe preview first.
5. If a feature is unavailable on the current plan, record the no-cost
   alternative (application rate limits, Turnstile, provider logging). Do not
   purchase an upgrade without owner approval.

## 4. Status

Automatic DDoS: `Unverified`. WAF managed rules: `Unverified`. Custom rules:
`Unverified`. Edge rate limits: `Unverified`. Bot features: `Unverified`.
Alerts: `Unverified`. Origin exposure: `Unverified`. Owner actions remain open.
