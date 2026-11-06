# Zeli — Security and Privacy

**Last updated:** 3 November 2026.
**Status:** External AI processing disabled. No DeepSeek request is made.

## 1. Security boundaries

### Tenant analytics

- Tenant is resolved from the authenticated module session. A browser-supplied
  tenant id is never an input.
- Only `role = admin` can use `/admin/zeli-analytics`.
- A live `zeli_analytics` entitlement is required. Active means: status
  `active`, `startsAt <= now`, no expiry or expiry in the future.
- Workers, collectors and customers are denied by default.
- Direct URL access, server actions, exports and refresh actions all re-check.
- Unentitled requests receive no analytics rows; they are redirected to the
  denial screen (pages) or receive `403` (API).

### Platform control centre

- Requires the separate platform session (`bik-platform-session`) and a
  `PlatformSuperAdmin` row.
- Tenant cookies cannot authenticate `/platform/*`.
- Platform pages expose entitlement lifecycle and aggregate usage only, not
  customer or transaction records.
- Manual entitlement changes require a reason of at least 10 characters and are
  written to `ZeliEntitlementEvent` and `PlatformAuditLog`.

### Conversation ownership

Every conversation read, rename, delete, message send and feedback write is
scoped by both `tenantId` and `userId`. A different user or tenant receives
"Conversation not found".

### Read-only tools

The tool registry remains read-only. No tool accepts a tenant id from the
browser or model. No Zeli path posts, reverses, approves or changes permissions.

## 2. Entitlement bypass attack surface

Reviewed paths:

- menu item hidden but URL guessed → server guard denies.
- API export called directly → entitlement guard returns 403.
- server action invoked with another tenant's location → location resolved
  inside the tenant, otherwise rejected.
- expired/suspended/revoked entitlement → denied.
- tenant admin calling platform actions → no platform session, rejected.
- platform operator reading tenant financials → page exposes aggregates only.
- cached navigation value → informational only; every action re-checks.

## 3. Privacy-by-design

- Analytics are computed inside BloomCore One.
- No external AI provider receives prompts, conversations, chart metrics,
  financial summaries, customer records or tenant identifiers.
- The gateway constructs payloads from typed allow-listed schemas. It does not
  serialise a database row and then delete fields.
- Unknown fields, nested unknowns, identifier-like strings, exact timestamps,
  free text and cross-tenant fields are rejected.
- Minimum cohort size defaults to 5 and cannot be configured below 5.
- Pseudonymisation is not treated as anonymisation.
- Gateway audit stores decision, reason, allow-list category names and counts;
  never payload values.

## 4. External AI status

`EXTERNAL_AI_PHASE = "disabled"` is a reviewed code constant. Environment flags
such as `ZELI_PROVIDER=deepseek`, `ZELI_DEEPSEEK_APPROVED=true` and
`DEEPSEEK_API_KEY` cannot enable external processing. The DeepSeek adapter's
`available()` fails and `generate()` throws before any request is constructed.

Owner-facing message:

> External AI processing is currently disabled. Zeli's private analytics and
> local intelligence features remain available.

## 5. Data handled by Zeli

| Data | Used by analytics | Used by chat | Sent externally |
|---|---|---|---|
| Contributions | Yes, aggregated | Yes, authorized summary | No |
| Withdrawals | Yes, aggregated | Yes, authorized summary | No |
| Remittances | Yes, aggregated | Yes, authorized summary | No |
| Expenses | Yes, aggregated | Yes, authorized summary | No |
| Customer/account records | Counts and authorized lookup | Authorized lookup only | No |
| Conversation text | No | Yes, stored | No |
| Staff activity | Collector aggregates where authorized | Role-scoped summary | No |

## 6. Retention and access

- Conversations are user/tenant scoped and deletable by their owner.
- Audit and entitlement history are append-only.
- Platform decisions retain reason and actor, not secrets.
- No credential, token, password or MFA value is displayed or logged.
- The platform provider panel shows whether a credential is present as a
  boolean, never the value.

## 7. Remaining legal/privacy decisions

- Whether an external provider will ever be approved.
- Lawful basis and DPIA sign-off if approved.
- Retention period for conversation text and analytics decisions.
- Whether tenant administrators may export aggregate figures containing branch
  names (currently yes for their own tenant).
- Cross-border transfer assessment for any future provider or local inference
  host.

## Commerce and provider addendum (4 November 2026)

- Checkout uses the server catalogue price; browser amounts are ignored.
- Webhooks require HMAC SHA-512 over the raw body; event ids are unique.
- Entitlement activation happens only from a verified payment event.
- Refund suspends access; cancellation ends renewal but preserves the paid period.
- Platform commerce changes require a platform session, reason and audit.
- External AI is controlled by one server policy with a global emergency stop.
- Production mode is locked by a reviewed code constant plus privacy/approval
  gates; it is not a UI toggle.
- Three tenants are used in browser tests to keep entitlement state independent.
- No production resource, secret or customer record was changed.
