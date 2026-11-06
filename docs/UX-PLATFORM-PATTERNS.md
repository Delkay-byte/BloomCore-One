# Platform UX Patterns — MaaCash

This document defines the five platform-wide behaviours and the shared
components that implement them. New screens should use these patterns rather
than inventing local variants.

## 1. Skeletons instead of page spinners

**Component:** `src/components/ui/Skeletons.tsx`

| Export | Use |
|---|---|
| `SkeletonPage variant="dashboard"` | Dashboards, overview screens |
| `SkeletonPage variant="table"` | Lists with summary cards and a table |
| `SkeletonPage variant="detail"` | Record detail pages |
| `SkeletonPage variant="form"` | Forms that load an existing record |
| `SkeletonPage variant="list"` | Stacked card lists |
| `SkeletonTable rows columns` | A table region inside a loaded page |
| `SkeletonForm fields` | A form region inside a loaded page |
| `SkeletonChart` | Chart cards |
| `SkeletonCardList` | Recent activity / device lists |
| `SkeletonStatCards` | Summary cards |

Rules:

- Skeletons mirror the final layout so the page does not jump.
- `SkeletonPage` owns the single `role="status"`, `aria-busy` and screen-reader
  announcement; nested shapes are `aria-hidden`.
- Skeletons are for **initial content**. Background revalidation keeps the
  existing content on screen. A single action uses a local button spinner.
- Redirect checks and genuinely long operations keep their progress indicator.
- `prefers-reduced-motion` disables the pulse globally.

Route-level `loading.tsx` shells are **not** used around statically prerendered
pages: in a production build they hid the real page payload behind a static
skeleton (PT-01). Initial client data loads use the in-page skeletons above.
Only the dynamic Susu customer-detail route keeps a route-level skeleton.

## 2. Autofill and prefill

- Identity/contact/credential fields use HTML `autocomplete`:
  `name`, `email`, `tel`, `street-address`, `organization`, `username`,
  `current-password`, `new-password`, `one-time-code`.
- Browser password managers are never blocked.
- Authenticated context is used for safe defaults (for example,
  "Recorded By" is preselected to the signed-in staff member and remains
  changeable).
- Financial amounts are **not** prefilled from history and use
  `autocomplete="off"`. The user always types the amount.
- Prefilled values are normal inputs: the user can change them, and the server
  revalidates every financial rule.

## 3. Immediate feedback and optimistic UI

**Toast:** `src/components/ui/Toast.tsx` (`useToast().push(type, message)`)
**Optimistic helper:** `src/hooks/useOptimisticAction.ts`

Safe, reversible changes (status toggles, preferences, ordinary drafts):

1. Apply the expected state immediately.
2. Send the request.
3. Keep the state when the server accepts it.
4. On rejection/error: restore the previous state, show a message and offer
   retry through the normal control.
5. A second call while one is in flight is ignored.

Financial actions are never optimistic successes. They follow:

`submitting → confirmed by server` or `saved locally, awaiting synchronization`
or `failed / needs attention`.

The UI can say "Saved on this device. Waiting to synchronize; not yet in the
ledger." It must not say "Completed" until the server acknowledges the posting.

Destructive actions keep their confirmation and authorization. Reversals are
never shown as posted before the server confirms.

## 4. Drafts

**Storage:** `src/lib/offline/drafts.ts`
**Hooks:** `src/hooks/useFormDraft.ts` (uncontrolled forms),
`src/hooks/useObjectDraft.ts` (controlled forms)
**Indicator:** `src/components/DraftIndicator.tsx`

- Debounced save after ~700 ms, scoped to tenant + user.
- Restored on return with a visible "Draft restored" message.
- "Discard draft" is always available.
- Cleared after a confirmed successful submission.
- Versioned (`DRAFT_SCHEMA_VERSION`) and expired after seven days.
- Passwords, MFA secrets, recovery codes and tokens are stripped before write.
- A server record newer than the draft wins; the draft is kept but not applied,
  and the indicator explains the conflict.
- Multi-step forms store the current step and completed values (worker daily
  account).
- A draft is never auto-submitted. Financial drafts require explicit review and
  submission.

Wired forms: Susu customer creation, staff/worker/collector creation, location
creation, office contributions, withdrawals, worker daily account.

## 5. Error handling and retry

**Mapping:** `src/lib/errors/friendly.ts`
**Boundaries:** `src/app/error.tsx` plus per-area `error.tsx`
**Not found:** `src/app/not-found.tsx`
**Panel:** `src/components/ui/ErrorView.tsx`

- HTTP status and thrown values map to short, actionable messages.
- Raw SQL, stack traces, Prisma codes, paths and internal exception text are
  discarded by `safeServerMessage()`.
- Server actions may return a curated message; it is shown only if it is short
  and free of internal detail.
- Retry controls preserve form input. `retry()` (Next.js 16) re-fetches the
  segment.
- 401 directs the user to sign in; 403 explains permission; 429 shows a wait.
- Financial retries reuse the same idempotency key.
- Every boundary logs to the console/monitoring and shows a branded panel.
- A genuine unmatched URL still uses the not-found page and correct semantics.

## Testing

`tests/ux-behaviours.test.ts` covers skeleton structure, reduced motion,
autocomplete presence, financial amount protection, error mapping, secret
stripping and sign-out safety. `tests/drafts.test.ts` covers draft scoping,
expiry, conflict metadata and secret removal. `tests/offline-queue.test.ts`
covers optimistic-adjacent queue behaviour, retries and rollback of unconfirmed
records.
