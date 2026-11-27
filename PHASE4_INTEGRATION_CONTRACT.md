# Phase 4 integration contract — enterprise withdrawal controls

## New models and fields
- `WithdrawalPolicy`: tenant-level configuration (`active`, `minAmountPesewa`, `maxAmountPesewa`, `highValueThresholdPesewa`, `highValueRequiresApproval`, `requiredApprovals`, `separationOfDuties`, `requireStepUp`, `requirePaymentEvidence`, `requiredEvidenceFields`, `note`, `updatedById`). One row per tenant; absence means the safe legacy policy.
- `WithdrawalPolicyHistory`: JSON snapshot, `changedById`, `changeNote`, `createdAt`.
- `WithdrawalApproval`: `tenantId`, `requestId`, `approverId`, `status`, `note`, `decidedAt`; unique `(tenantId, requestId, approverId)`.
- `CustomerWithdrawalRequest` additions: `highValue`, `requiredApprovals`, `policyVersion`, `approvedById/At`, `paymentInitiatedById/At`, `paymentMethod`, `paymentReference`, `paidAt`, `evidenceRef`, `reasonCode`, `acknowledgedById/At`, `approvals`.
- `Withdrawal` additions: `requestId`, `paymentMethod`, `paymentReference`, `paidById/At`, `evidenceRef`, `acknowledgedById/At`, `reasonCode`.

## Withdrawal state transitions
`requested` → (approval(s)) → `awaiting_payment` → `paid`. Rejection/cancellation may occur before payment. `disputed` and `reversed` are terminal follow-up states recorded by audit/correction actions. Legacy tenants with no policy keep the existing single-action `requested → paid` path.

## Actions (`src/lib/actions/withdrawal-control.actions.ts`)
- `getWithdrawalPolicy(): Promise<{success, data?: WithdrawalPolicyValues}>`
- `saveWithdrawalPolicy(input: WithdrawalPolicyValues & {changeNote?: string}): Promise<{success, error?, data?}>`
- `approveWithdrawalRequest(input: {id, stepUpToken, note?}): Promise<WithdrawalRequestResponse>` — records a distinct approval, never pays when approvals are required.
- `payWithdrawalRequest(input: {id, stepUpToken, paymentMethod, paymentReference, evidenceRef?, acknowledgedById?, reasonCode?}): Promise<WithdrawalRequestResponse>`
- `recordWithdrawalAcknowledgement(input: {id, acknowledgedById, note?}): Promise<WithdrawalRequestResponse>`
- `getHighValueWithdrawalQueue(): Promise<WithdrawalRequestResponse>`

Legacy `withdrawal-request.actions.ts#approveWithdrawalRequest` delegates to the control action so existing callers keep working.

## Policy semantics
- Defaults preserve current behaviour: no limits, no extra approvals, step-up retained, evidence optional.
- High-value flag comes from `evaluateWithdrawalPolicy`; thresholds are stored, never from the browser.
- `separationOfDuties` forbids payment by any approver or the requester when approvals are configured.
- Evidence fields are validated against `EVIDENCE_FIELDS`.

## Authorization
- Reuse `resolveBranchScope`, `assertBranchAccess`, `requireTenantAdminSusu`, `requireTenantCustomer`.
- Company-wide admins retain cross-branch authority; branch managers/finance only held branches; collectors cannot approve or pay.
- Deny cross-tenant ids in every action.

## Audit events
`withdrawal.policy_saved`, `withdrawal.policy_evaluated`, `withdrawal.approval_recorded`, `withdrawal.payment_recorded`, `withdrawal.acknowledgement_recorded`, `withdrawal.payment_denied`.

## Interfaces for Phase 5/6
- Read-only withdrawal lifecycle fields on `CustomerWithdrawalRequest` and `Withdrawal` for reconciliation exception linkage.
- `getHighValueWithdrawalQueue()` can feed a management view without new queries.
- No reconciliation case management or reporting exports are implemented here.
