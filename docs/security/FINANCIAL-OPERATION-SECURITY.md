# Financial Operation Security

## 1. Scope reviewed

- `src/lib/actions/susu-contribution.actions.ts`
- `src/lib/actions/susu-withdrawal.actions.ts`
- `src/lib/actions/susu-collector.actions.ts` (remittances)
- `src/lib/actions/daily-account.actions.ts` (MoMo daily operations)
- `src/lib/actions/momo-history.actions.ts`
- `src/app/api/offline/sync-contribution/route.ts`
- Prisma models for Contribution, Withdrawal, Commission, CardFee,
  CollectorRemittance, DailyAccount

## 2. Implemented controls

### Contributions

- Integer whole-day validation: `amount / dailyContribution` must be a whole
  number between 1 and 31. Partial amounts that previously credited more than
  the allocated days are rejected.
- Allocations are computed inside the same transaction as the contribution and
  the remaining unpaid days are re-checked there.
- `referenceId` is unique. A caller-supplied `idempotencyKey` becomes
  `CON-<key>`; reusing it fails on the unique constraint and returns
  "already recorded" instead of double-crediting.
- Tenant, collector assignment, recorder and receiver IDs are all re-verified
  against the authenticated tenant.
- Rate limited per user (`RATE_LIMITS.financeMutation`).

### Withdrawals

- `requestedAmount` must be a finite number, greater than zero, at most two
  decimal places, and no more than 999,999.99.
- Balance, commission and cycle state are read and written in one transaction.
- The first-withdrawal commission is claimed with a conditional
  `updateMany({ where: { commissionCharged: false } })`, so concurrent
  withdrawals cannot both charge it.
- Optional idempotency key; the unique `referenceId` rejects replay.
- Audit row records actor, account, amounts, balance and reference.
- Rate limited per user.

### Offline sync

- Same-origin check on the API route.
- Device must be active, owned by the same user and tenant, and within its
  24-hour offline authorization window.
- The idempotency key is reserved before money moves. A key owned by another
  tenant, user or device returns 409.
- `channel` must be `collector` or `direct_office`; non-collector channels
  require an administrator session; collector channels require an active
  assignment.
- Amount must be a whole number of days; the account must be active and have an
  active cycle.
- Contribution and allocations are written in one transaction.

### Daily MoMo accounts

- Invalid numeric input is no longer coerced to zero; it fails schema
  validation.
- Draft edits write a `daily_account.updated` audit event.
- Amounts are bounded by `dailyAccountSchema` (max 999,999.99).

## 3. Money arithmetic

Prisma `Decimal` columns are used for storage. Business calculations still use
JavaScript numbers converted from `Decimal`; values are rounded to two decimal
places at validation and allocation boundaries. This is adequate for the
current cedi amounts but is **not** arbitrary-precision accounting. A future
change should use a decimal library or integer pesewas throughout.

## 4. Audit trail

- Financial actions write `AuditLog` rows with actor, tenant, entity, action and
  a JSON details object.
- There is no tenant-facing delete or update endpoint for audit rows.
- Append-only is enforced by application code and database permissions only;
  it is not cryptographic tamper-proof storage.
- Platform actions write a separate `PlatformAuditLog`.

## 5. Residual risks and owner decisions

1. **Concurrent withdrawal balance.** The commission race is fixed, but two
   withdrawals can still read the same balance under PostgreSQL read-committed
   isolation. A per-account advisory lock, `SERIALIZABLE` transaction or a
   balance ledger with a conditional debit is required for strict guarantees.
2. **No reversal/void workflow.** Mistakes can only be corrected by a new
   compensating entry or direct database work. A proper reversal action with
   reason, authorization and audit is recommended before scale.
3. **Approval thresholds.** No business-specific limits (maximum withdrawal,
   dual approval, daily caps) exist. These are owner policy decisions and were
   intentionally not invented.
4. **`receivedByName` is free text.** The identity anchor is server-derived, but
   the displayed receiver name can be typed by office staff.
5. **Offline device compromise.** A valid enrolled device can file collections
   for assigned customers until revoked. Device revocation is available at
   `/api/admin/devices`.

## 6. Verification

`tests/financial-security.test.ts` (real actions, two tenants):

- cross-tenant withdrawal → denied, no row created;
- `NaN`, `Infinity`, sub-cent and negative amounts → denied;
- replay of an idempotency key → denied;
- second withdrawal does not charge a second commission;
- audit rows written once per successful withdrawal.
