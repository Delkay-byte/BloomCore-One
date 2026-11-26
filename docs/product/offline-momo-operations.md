# Offline MoMo operations

**Status:** implemented. A MoMo day can be captured with no connection, and it is never
posted, submitted or counted as money until the agent completes the real daily account
online.

Files:

- `src/lib/offline/momo-draft.ts` — payload rules, integer pesewa, staleness.
- `src/app/api/offline/momo-draft/route.ts` — the sync endpoint.
- `src/lib/actions/momo-offline-draft.actions.ts` — listing, applying, rejecting, clearing.
- `src/components/OfflineMomoCapture.tsx` — the device capture panel.
- `prisma/migrations/20261220_offline_momo_drafts/` — the schema change.
- `tests/offline-momo-drafts.test.ts` — 15 tests.

---

## 1. Why not just queue a "daily account draft"?

An earlier build had a `daily_account_draft` queue type that never had a producer, a
payload validator or a server route, so nothing could actually be captured offline. It was
removed rather than wired up, because a "draft account" is the wrong shape: it implies that
a queued account could become the account, which would let a device with a stale or
tampered payload set an opening float.

The shape that shipped is a **capture**: a record of what the agent observed, which must
still be applied into a real account that the same worker saved online.

## 2. The lifecycle

```
device capture ──► /api/offline/momo-draft ──► MomoOfflineDraft (pending)
      │                                             │
      │ (no connection, stays in the queue)         ├─► needs_review (conflict)
      └────────────────────────────────────────────►│
                                                    ├─► applied  (worker saved the real account)
                                                    └─► rejected (reviewer, with reason)
```

Nothing in that diagram creates a ledger row, a transaction, a balance or a daily account.

## 3. Validation, in the order it runs

**On the device** (`momo-draft.ts`):

- Network must be `mtn`, `telecel` or `at_money`.
- Amounts convert to integer pesewa; a fractional pesewa is refused rather than rounded.
- Business date normalises to a UTC day; an age beyond `MOMO_OFFLINE_MAX_AGE_DAYS` (14) is
  stale and cannot be applied without review.
- The payload is canonicalised and hashed, so a retry that changed the figures is detected.

**On the server** (`route.ts`):

1. Same-origin only.
2. Session tenant resolved; rate limited (`RATE_LIMITS.offlineSync`).
3. The device must be enrolled, active, and authorised within the last 24 hours.
4. The location must belong to the tenant *and* be the caller's own assignment.
5. Idempotency: one key = one capture. The same key with a different payload body is
   `409 payload_mismatch`, never an overwrite.
6. Conflicts: an existing daily account for that branch and day, or a stale business date,
   marks the draft `needs_review` with a reason instead of silently overwriting anything.
7. Audit on receive and on reject.

## 4. Applying a draft

`applyMomoDraft` is deliberately strict:

- Only the worker who captured it may apply it to their own account.
- The account must be for the same branch and the same business day.
- The account must have been saved *after* the capture, so the figures the worker typed
  online always win over the capture.
- The draft is marked `applied` and the application is audited.

A reviewer can `rejectMomoDraft` with a reason, or `clearMomoDraftConflict` once the
underlying cause is resolved. Neither deletes the capture.

## 5. What the agent sees

The panel says, before anything else, that nothing is posted:

> Write the day down here when the network is down. It is stored on this device and sent to
> MaaCash when you reconnect, so you can finish the real daily account online. Nothing is
> posted, submitted or counted as money until you do.

Captured totals are shown with the label "for reading only, not a posting", and a
reference or photo is described as evidence the agent kept, not proof that a network
completed a transaction.

## 6. Limits, stated honestly

- **No offline PIN capture, ever.** There is no field for one.
- **No offline approval.** Applying requires a live session and a server round trip.
- **14-day staleness ceiling.** Beyond that the capture is kept for audit but cannot be
  applied without a reviewer's decision.
- **One device, one capture, one key.** Re-sending the same capture from a second device
  creates a second draft that a reviewer must resolve, which is the honest outcome: two
  devices captured the same day.
