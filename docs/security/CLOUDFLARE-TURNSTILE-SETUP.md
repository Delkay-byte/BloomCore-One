# Cloudflare Turnstile Setup

## 1. What is implemented

- Client widget: `src/components/security/TurnstileWidget.tsx`
  (explicit render, loading/success/error/expiry states, reset after a failed
  submission, hidden `cf-turnstile-response` field, accessible status text).
- Server verification: `src/lib/security/turnstile.ts`.
- Protected actions:

| Page | Turnstile action |
|---|---|
| `/login` (shared portal) | `login` |
| `/admin/login` | `admin_login` |
| `/platform/login` | `platform_login` |
| `/forgot-password` | `password_reset` |

- Customer login uses the shared `/login` page, so it is covered by the same
  `login` action.

## 2. Server verification rules

When `TURNSTILE_ENABLED=true`, every protected submission must:

1. Present a token (`cf-turnstile-response`).
2. Pass Cloudflare Siteverify at
   `https://challenges.cloudflare.com/turnstile/v0/siteverify`.
3. Report `success === true`.
4. Report a hostname present in `TURNSTILE_ALLOWED_HOSTNAMES`.
5. Report the exact action expected by the form.
6. Report a `challenge_ts` no older than 10 minutes.
7. Not have been used before (`TurnstileTokenUse` unique ledger).

Missing token, missing keys, network failure, timeout or unexpected response all
reject the request. The browser widget rendering is irrelevant to the decision.

## 3. Environment variables

| Variable | Where | Value |
|---|---|---|
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Render build env | Site key from Cloudflare |
| `TURNSTILE_SECRET_KEY` | Render runtime env | Secret key from Cloudflare |
| `TURNSTILE_ENABLED` | Render runtime env | `false` until rollout step 4 |
| `TURNSTILE_ALLOWED_HOSTNAMES` | Render runtime env | `bloomcore-one.onrender.com` |

The site key is public by design. The secret key must never be placed in a
`NEXT_PUBLIC_*` variable, committed, pasted into chat, or logged.

## 4. Cloudflare dashboard steps (owner)

1. Sign in to <https://dash.cloudflare.com/>.
2. Go to **Turnstile → Add widget**.
3. Widget name: `MaaCash`.
4. Hostnames: add `bloomcore-one.onrender.com` (and any custom domain you will
   use later).
5. Widget mode: **Managed**.
6. Copy the **Site Key** and **Secret Key**.
7. In Render → `bloomcore-one` → Environment, add:
   - `NEXT_PUBLIC_TURNSTILE_SITE_KEY` = site key
   - `TURNSTILE_SECRET_KEY` = secret key
   - `TURNSTILE_ALLOWED_HOSTNAMES` = `bloomcore-one.onrender.com`
   - keep `TURNSTILE_ENABLED=false` for this deploy.
8. Save and let Render redeploy (the public site key is embedded at build time).
9. Verify a normal login still works with Turnstile disabled.
10. Change `TURNSTILE_ENABLED=true`, redeploy, then verify:
    - login with a completed challenge succeeds;
    - submitting the form without a token fails;
    - a token issued for `admin_login` cannot be used on `/login`.
11. If login breaks, immediately set `TURNSTILE_ENABLED=false` and redeploy.

## 5. Test keys for local development

Cloudflare publishes always-pass and always-fail test keys at
<https://developers.cloudflare.com/turnstile/troubleshooting/testing/>.
Use them in `.env.local`; they are not for production. Automated tests mock the
Siteverify HTTP call instead of using real credentials.

## 6. Rollout safety

Order matters: **keys first, flag second**. Deploying with
`TURNSTILE_ENABLED=true` and no keys rejects every login by design. The flag is
declared as `false` in `render.yaml` so a missing dashboard value cannot enable
verification by accident.

## 7. Actions reference

Cloudflare returns the action recorded at widget render time. If a new form is
added, pass the same action string to `<TurnstileWidget action="...">` and to
`verifyTurnstile({ action: "..." })`; otherwise verification fails with
`reason: "action"`.
