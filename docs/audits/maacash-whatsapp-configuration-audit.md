# MaaCash WhatsApp configuration audit

Scope: the WhatsApp path actually present in this repository at audit time
(HEAD on `feat/maacash-momag-readiness`, after A1–A10, C0–C4 and B1). Every row below
was read from source; nothing is inferred from documentation alone. No Render service
was contacted and no environment value was read, printed or changed.

Sources read:

- `src/lib/messaging/whatsapp.ts` — config reader, adapter, signature verification.
- `src/lib/messaging/consent.ts` — consent-code template selection.
- `src/lib/messaging/outbox.ts` — receipt template selection and status recording.
- `src/lib/messaging/config.ts` — per-business channel and template resolution.
- `src/lib/messaging/dispatch.ts` — the delivery pass.
- `src/app/api/webhooks/whatsapp/route.ts` — subscription challenge and status webhook.
- `src/app/api/internal/messaging/dispatch/route.ts` — scheduler trigger.
- `src/app/api/webhooks/sms/route.ts` — SMS status webhook (adjacent, shares the secret pattern).
- `render.yaml`, `scripts/e2e-env.cjs`.

---

## 1. Environment variables

`R` = required for the named behaviour, `O` = optional (default applies).

| Variable | Req. | Secret | Format / example | Read by | Purpose | Render vs tenant config | Restart needed | How to validate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | R | **yes** | Meta system-user token, `EAAG…`, long — placeholder `<WHATSAPP_ACCESS_TOKEN>` | `whatsapp.ts:30` (`getWhatsAppConfig`) | Bearer token for `POST /{graphVersion}/{phoneNumberId}/messages` | Render env (dashboard only; not in `render.yaml`) | Yes — read at request time from `process.env`, but a running instance keeps the old value until it restarts or redeploys | `GET /admin/integrations` → WhatsApp card reports "configured and switched on" only when token + phone id + WABA id are all present |
| `WHATSAPP_PHONE_NUMBER_ID` | R | no | Numeric id, ~15–17 digits — placeholder `<WHATSAPP_PHONE_NUMBER_ID>` | `whatsapp.ts:31` | Sending phone number (not the display number) | Render env | Yes | Same card; a send to an allowlisted number returns an outbox row with a provider message id instead of `simulated` |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | R | no | Numeric WABA id — placeholder `<WHATSAPP_BUSINESS_ACCOUNT_ID>` | `whatsapp.ts:32` | Identifies the WABA; part of the `configured` test | Render env | Yes | Same card (`configured` requires all three) |
| `WHATSAPP_GRAPH_VERSION` | O | no | `v23.0` (default), `v<major>.<minor>` — placeholder `<WHATSAPP_GRAPH_VERSION>` | `whatsapp.ts:41` | Graph API version in the send URL | Render env | Yes | Log/response of a failed send shows the URL version; invalid version returns a 4xx `http_error` |
| `WHATSAPP_RECEIPT_TEMPLATE` | O | no | Template name, `[a-z0-9_]{1,512}` — default `maacash_receipt` — placeholder `<WHATSAPP_RECEIPT_TEMPLATE>` | `whatsapp.ts:42`, `outbox.ts:169` | Last-resort receipt template when the business has none approved | Render env (deployment default), overridden per business | Yes | `/admin/messaging` template table shows the approved template actually used; an unapproved name yields `template_not_approved` and no send |
| `WHATSAPP_TEMPLATE_LANGUAGE` | O | no | Locale code, `en_US` (default), `en_GB`, `fr` — placeholder `<WHATSAPP_TEMPLATE_LANGUAGE>` | `whatsapp.ts:43`, `consent.ts:82`, `outbox.ts:170` | Language code sent with the template | Render env (default), overridden per business (`MessagingTemplate.language`) | Yes | Send payload's `language.code` in the outbox error/detail; a wrong code returns a Meta 4xx |
| `WHATSAPP_OTP_TEMPLATE` | O | no | Template name — default `maacash_consent_code` — placeholder `<WHATSAPP_OTP_TEMPLATE>` | `consent.ts:81` | Authentication/consent-code template for the customer proof-of-ownership step | Render env | Yes | Request a consent code in `/customer/settings`; the outbox row records the template used |
| `WHATSAPP_APP_SECRET` | R for the status webhook | **yes** | Meta app secret, hex — placeholder `<WHATSAPP_APP_SECRET>` | `whatsapp.ts:44`, `webhooks/whatsapp/route.ts` | Verifies `X-Hub-Signature-256` on every status callback | Render env | Yes | `POST /api/webhooks/whatsapp` with no header → **503 Not configured**; with a wrong signature → **403**; a correct signature for a real body → 200 |
| `WHATSAPP_VERIFY_TOKEN` | R for the subscription challenge | **yes** (shared secret with Meta) | Opaque string you invent, 16+ chars — placeholder `<WHATSAPP_VERIFY_TOKEN>` | `whatsapp.ts:45`, `webhooks/whatsapp/route.ts:32,36` | Compared with `hub.verify_token` on the GET challenge | Render env | Yes | `GET /api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<value>&hub.challenge=123` → body `123`; unset → 503; wrong token → 403 |
| `WHATSAPP_DELIVERY_ENABLED` | R to deliver | no | Exactly `true` (case-insensitive); anything else means off | `whatsapp.ts:47` | Master switch: without it every message is `simulated` | Render env. **Per-business switches live in the database** (`TenantMessagingConfig.whatsappEnabled`) and are the business's own decision | Yes | Unset/`false` → outbox status `simulated`, never `delivered` |
| `WHATSAPP_DELIVERY_ALLOWLIST` | R to deliver in a pilot | no | Comma-separated E.164: `+233201234567,+233551234567` | `whatsapp.ts:33-37` | Restricts real sends to named recipients during a pilot | Render env | Yes | A number not on the list stays `simulated`; the `/admin/integrations` capability text states allowlist-only delivery |
| `MESSAGING_DISPATCH_TOKEN` | R for scheduled delivery | **yes** | 32+ random chars — placeholder `<MESSAGING_DISPATCH_TOKEN>` | `api/internal/messaging/dispatch/route.ts:23` | Shared secret for the scheduler that drives the outbox | Render env **and** the caller's scheduler config (same value) | Yes | `POST /api/internal/messaging/dispatch` → **503** when unset, **403** when the token is wrong, `200 {ok:true,…}` when correct |
| `SMS_STATUS_WEBHOOK_SECRET` | O (SMS only) | **yes** | 32+ random chars — placeholder `<SMS_STATUS_WEBHOOK_SECRET>` | `api/webhooks/sms/route.ts:65` | HMAC for the SMS provider's delivery receipts | Render env | Yes | `POST /api/webhooks/sms` unset → 503; wrong signature → 403 |
| `SMS_PROVIDER` | O (SMS only) | no | Provider slug — placeholder `<SMS_PROVIDER>` | `lib/messaging/sms.ts` via `integrations/readiness.ts` | Selects an SMS adapter; no reviewed adapter exists, so the mock never sends | Render env | Yes | `/admin/integrations` SMS card names the provider and still reports `unavailable` |

Deliberately **not** configurable per business: the access token, phone number id,
WABA id, app secret, verify token, delivery switch and allowlist. Those are
platform-level. A business controls only its channel switches, its templates and the
language of those templates.

### `POST /api/internal/messaging/dispatch` — the shared secret

This is the scheduler trigger for the durable outbox. It accepts the secret either as
`x-dispatch-token: <value>` or `Authorization: Bearer <value>`, compares it with
`timingSafeEqual` on equal-length buffers, refuses everything when
`MESSAGING_DISPATCH_TOKEN` is empty (503, so an unconfigured deployment is visibly
off rather than open), and does bounded work per call. The route is `runtime =
"nodejs"`, `dynamic = "force-dynamic"`, and it is **not** behind tenant auth — the
shared secret is the only control, which is why it must be long, random, and distinct
from every other secret.

### Webhook URL and verify-token relation

- Callback URL to register with Meta: `https://maacash.bloomcoretech.com/api/webhooks/whatsapp`
  (placeholder origin `<PUBLIC_ORIGIN>`). It must be **https**; Meta will not verify an
  http URL.
- The GET challenge compares `hub.verify_token` with `WHATSAPP_VERIFY_TOKEN`. The
  string entered in the Meta console must equal that env value exactly.
- The POST callback verifies `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256 of the
  **raw body** keyed with `WHATSAPP_APP_SECRET`. Rotating the app secret breaks
  signature verification immediately, and the route then returns 403 while still
  recording nothing.

---

## 2. Templates and language are per business — confirmed

`src/lib/messaging/config.ts` resolves each message from the database first:

1. A `MessagingTemplate` row with `channel = whatsapp`, the matching `purpose`, and
   `status = "approved"` supplies `templateName` and `languageCode`.
2. A business that has configured `TenantMessagingConfig.whatsappTemplateName` but has
   not had it approved is refused with `template_not_approved` — it does not silently
   fall back to a deployment default.
3. Only a receipt with no business template at all may use
   `WHATSAPP_RECEIPT_TEMPLATE` / `WHATSAPP_TEMPLATE_LANGUAGE`.
4. The business's own channel switch (`whatsappEnabled` / `smsEnabled`) is checked
   first; a message for a switched-off channel is refused with
   `channel_disabled_by_business` and never queued.

So template name and language are **per-business data**, with the env vars acting as a
deployment default for the receipt purpose only. The consent-code template is
deployment-level (`WHATSAPP_OTP_TEMPLATE`), because it is part of the platform's own
proof-of-ownership step rather than a business's branding.

---

## 3. Delivery truthfulness

A provider that cannot deliver reports `simulated`, never `delivered`. The adapter
requires all of: configured credentials, `WHATSAPP_DELIVERY_ENABLED=true`, and a
recipient on the allowlist. A successful HTTP 202 from Meta is recorded as `accepted`,
and only a webhook status event moves a message to `sent`, `delivered`, `read` or
`failed`. Errors are sanitised before storage so a token cannot leak into a log or a
notification.

---

## 4. Render checklist (placeholders only — nothing here was executed)

1. Render dashboard → service `maacash` → **Environment**.
2. Add, as **secret** values (never in `render.yaml`, never in Git):

   | Key | Placeholder value to paste |
   | --- | --- |
   | `WHATSAPP_ACCESS_TOKEN` | `<WHATSAPP_ACCESS_TOKEN>` |
   | `WHATSAPP_PHONE_NUMBER_ID` | `<WHATSAPP_PHONE_NUMBER_ID>` |
   | `WHATSAPP_BUSINESS_ACCOUNT_ID` | `<WHATSAPP_BUSINESS_ACCOUNT_ID>` |
   | `WHATSAPP_APP_SECRET` | `<WHATSAPP_APP_SECRET>` |
   | `WHATSAPP_VERIFY_TOKEN` | `<WHATSAPP_VERIFY_TOKEN>` (invent it; do not reuse another secret) |
   | `MESSAGING_DISPATCH_TOKEN` | `<MESSAGING_DISPATCH_TOKEN>` |

3. Add, as plain values:

   | Key | Value |
   | --- | --- |
   | `WHATSAPP_GRAPH_VERSION` | `<WHATSAPP_GRAPH_VERSION>` (e.g. `v23.0`) |
   | `WHATSAPP_DELIVERY_ENABLED` | `false` until a pilot is agreed, then `true` |
   | `WHATSAPP_DELIVERY_ALLOWLIST` | `<+233…,+233…>` (pilot recipients only) |
   | `WHATSAPP_RECEIPT_TEMPLATE` | `<WHATSAPP_RECEIPT_TEMPLATE>` (e.g. `maacash_receipt`) |
   | `WHATSAPP_TEMPLATE_LANGUAGE` | `<WHATSAPP_TEMPLATE_LANGUAGE>` (e.g. `en_US`) |
   | `WHATSAPP_OTP_TEMPLATE` | `<WHATSAPP_OTP_TEMPLATE>` (e.g. `maacash_consent_code`) |

4. **Save** the environment. Render restarts the service; a redeploy is not required
   for env-only changes but the service does restart.
5. Meta console → WhatsApp → Configuration → Webhook:
   - Callback URL `https://<PUBLIC_ORIGIN>/api/webhooks/whatsapp`
   - Verify token: the exact `WHATSAPP_VERIFY_TOKEN` value
   - Subscribe to the `messages` field.
6. Verify, in this order:
   - `GET https://<PUBLIC_ORIGIN>/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=123` returns `123`.
   - Same GET with a wrong token returns 403.
   - `POST /api/webhooks/whatsapp` with no signature returns 403 (503 only while the app secret is unset).
   - `POST /api/internal/messaging/dispatch` without the header returns 403.
   - Sign in as a tenant administrator → `/admin/integrations` shows the WhatsApp card as configured; `/admin/messaging` shows the SMS row still marked *Coming soon* while the WhatsApp rows are not.
7. Keep `WHATSAPP_DELIVERY_ENABLED=false` until a named pilot recipient list and
   consent wording exist. With it off, every receipt is recorded `simulated` — which
   is the correct, non-misleading state.

Nothing in this checklist was executed. No Render environment was read or modified, no
Meta console was contacted and no message was sent.
