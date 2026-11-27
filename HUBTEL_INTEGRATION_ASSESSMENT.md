# Hubtel Integration Assessment — MaaCash Susu (Phases 1–7)

Status: **assessment only**. No Hubtel account, credential, sandbox call, webhook or
production setting was created, read or changed. No code was written or executed against
Hubtel. This document maps a future Hubtel integration onto the integrated Phase 1–7
surface so that the work can be scoped safely; it is not an implementation.

Branch: `feat/susu-enterprise-phases-1-7-integration`  
Baseline: `7073548` (Phases 1–3 integration) + Phase 4 `e03d250`, Phase 5 `c911104`,
Phase 7 `f7ea45f`, Phase 6 `515f7bb`.

## 1. Verified starting facts

- The repository contains **no Hubtel code, configuration, secret, URL or test**.
  `rg -i hubtel` over the integration worktree returns zero matches, so nothing in
  Phases 1–7 is entangled with Hubtel and nothing needs unwinding before an integration.
- Susu money movement today is deliberately **manual and evidence-backed**:
  - cash in: `recordContribution` (`src/lib/actions/susu-contribution.actions.ts`) with
    `channel = "collector" | "direct_office"`, a required unique `referenceId`
    (idempotency key) and `Contribution.amount` as a **Decimal in GHS**;
  - cash out: Phase 4 `payWithdrawalRequest` records `paymentMethod`,
    `paymentReference` and evidence fields after a policy + step-up gate;
  - cash settlement: Phase 3 remittance (`declare` → `acknowledge` → independent
    `verify`) and Phase 5 daily closing / reconciliation sessions.
- The only live payment-provider integration is **Paystack for platform billing**
  (`src/lib/payments/paystack.ts`, `src/app/api/payments/paystack/webhook/route.ts`).
  It is scoped to Zeli subscription checkout, not to tenant Susu cash, and it is the
  pattern an approved provider adapter should copy rather than invent:
  - `initializeTransaction` / `verifyTransaction` / `lookupTransaction`;
  - raw-body HMAC verification (`verifyWebhookSignature`, `verifyWebhookRequest`) with the
    legacy `x-paystack-signature` header still accepted but never rescuing a failing
    timestamped signature;
  - charge attempts with idempotency and a live-readiness gate (`live-readiness.ts`).
- Outbound customer messaging has a provider **seam** but no provider:
  `MessageProvider` in `src/lib/messaging/provider.ts` exposes
  `send({ channel, to, body, purpose, reference })` and the only adapter is a mock that
  reports `simulated`. Hubtel SMS would be an adapter behind this interface, not a change
  to callers or templates.

## 2. Where Hubtel would touch MaaCash

| Capability | Direction | MaaCash surface | Present state |
| --- | --- | --- | --- |
| Collections (customer pays into the Susu account) | inbound | `Contribution` + `SusuCycle` + branch attribution | manual `recordContribution` only |
| Payouts (Susu withdrawal paid to customer) | outbound | Phase 4 `CustomerWithdrawalRequest` → `Withdrawal` | manual `payWithdrawalRequest` with evidence |
| Collector settlement | inbound | Phase 3 `CollectorRemittance` / `RemittanceContribution` | manual declare/receive/verify |
| Bank/mobile-money statement lines | inbound | Phase 5 `ReconciliationSession` + `ReconciliationExceptionCase` | manual sessions, no statement feed |
| SMS receipts / OTP / notices | outbound | `src/lib/messaging` (`MessageProvider`) | mock adapter only |
| Provider fees | inbound | none | no provider-fee field exists |

## 3. Field-level mapping (proposed)

| Hubtel concept | MaaCash target | Notes |
| --- | --- | --- |
| Transaction / receipt id | `Contribution.referenceId` | Globally `@unique`; must be the idempotency key, not a random UUID per retry. |
| Amount (pesewas) | `Contribution.amount` (Decimal GHS) | Divide by 100 exactly once, at the boundary; never use floats. Phase 4 policy thresholds are stored as integer **pesewa**, so this boundary is the highest-risk conversion in the integration. |
| Customer MSISDN | `Customer.phone` (E.164) | Must resolve through the existing phone normaliser and tenant scope; never create a second customer record on a formatting difference. |
| Branch / merchant account | `SusuAccount.branchId`, `Contribution.branchId` | Branch of record comes from the account, not from the payload. A provider-supplied branch must be validated against `BranchMembership`. |
| Collection time | `Contribution.collectionDate` | Server posting time; a provider timestamp is evidence only (the offline model already separates `capturedAt` from `collectionDate`). |
| Payout reference | `Withdrawal.paymentReference` (via Phase 4 payment evidence) | Must be written only after the Phase 4 approval/step-up gate closes. |
| Provider fee | *no field* | Requires a new, explicit field; must **not** be posted as `Commission`, which is the business commission on the Susu cycle. |
| SMS delivery status | `MessageDeliveryResult.providerId` / `providerMessageId` | Fits the existing interface without schema change. |

## 4. Gaps that block a production integration (ranked)

1. **No provider-agnostic collection adapter.** `recordContribution` is an authenticated
   staff/customer action, not a webhook handler. A Hubtel collection webhook needs a new
   route that verifies the provider signature on the raw body, resolves the tenant and
   account, and then calls the existing action (or a narrow sibling) so that cycle,
   branch and idempotency rules stay in one place.
2. **Payout execution does not exist.** Phase 4 records that a payout happened; it does
   not call a provider. A Hubtel payout needs a separate, explicitly approved step, plus
   a "payout requested" state so a crash between the ledger write and the provider call
   is recoverable (the current status machine has no `paying` state).
3. **No statement ingestion.** Phase 5 sessions are opened and reconciled by hand. Hubtel
   settlement files would map naturally onto session lines, but line ingestion,
   matching rules and duplicate detection are not implemented.
4. **No provider-fee accounting.** Fees would have to be posted somewhere that does not
   corrupt gross/net contribution figures or business commission.
5. **No secrets or live-readiness gate for Susu money.** The Paystack gate is explicitly
   platform-billing scoped; a Susu provider needs its own key-mode and kill switch.

## 5. Security requirements for any future implementation

- Webhook authentication is the only proof of a provider call: HMAC over the **raw** body,
  constant-time compare, timestamp tolerance, replay cache. A failing signature must never
  fall back to a "legacy" header (the Paystack verifier already refuses exactly this).
- Idempotency: provider transaction id → `referenceId`; duplicate deliveries must be
  no-ops with an audit row, not a second contribution.
- Tenant resolution by provider account id → tenant, never by a payload-supplied tenant id.
- No secrets in the repository; the existing secret-store/readiness pattern applies.
- Every ingestion writes an audit event and is rate limited, like the existing
  `export_zeli_analytics` / finance-mutation controls.
- Sandbox only until an owner-approved go-live; no live customer money in tests.

## 6. Verdict

**NOT INTEGRATED — mapping viable, implementation deliberately deferred.**

The integrated Phase 1–7 model is a good host for Hubtel: every financial fact already
has a tenant, a branch, an idempotency key, a reversal path, an independent verification
stage and an audit trail, and the Paystack module proves the repository can host a
verified webhook safely. What is missing is connective tissue (adapter, payout state,
statement ingestion, fee accounting), not model change. None of it belongs inside a
Phase 1–7 integration pass, and none of it was built here.

## 7. Reproduce the verification

```powershell
# No Hubtel references anywhere in the integrated tree
rg -i hubtel .
# Existing provider pattern (platform billing only)
rg -n "verifyWebhookSignature|verifyWebhookRequest" src/lib/payments/paystack.ts
# Messaging seam
rg -n "interface MessageProvider" src/lib/messaging/provider.ts
```