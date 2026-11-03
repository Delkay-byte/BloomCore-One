# BloomCore One — UX, Offline Reliability and Security Improvements

**Goal:** Improve loading, autofill, feedback, drafts and error handling across the app; stop offline financial records being lost on sign-out; close the remaining code-addressable security gaps.

**Branch:** `feat/bloomcore-ux-offline-reliability` (from `main` @ `0a5ba96`)

**Constraints:** No architecture/brand/business-rule changes. No Zeli/pricing/billing changes. No destructive production action. Preserve tenant isolation, ledger rules, MFA, Turnstile and rate limiting.

## Work items

1. **Skeletons** — shared skeleton primitives; replace page-level spinners; add route-level `loading.tsx` files.
2. **Autofill / prefill** — HTML `autocomplete` on identity, contact and credential fields; keep financial amounts blank; prefer authenticated context for safe defaults.
3. **Feedback / optimistic UI** — toast usage for safe mutations; optimistic toggle with rollback; financial actions keep explicit pending/confirmed states; no duplicate submits.
4. **Drafts** — scoped, versioned IndexedDB drafts (tenant + user), debounced save, restore, discard, clear on success; never persist secrets.
5. **Errors** — friendly error mapping, retry helpers, route error boundaries and not-found handling; no internal detail leakage.
6. **Offline protection** — sync before sign-out, never delete pending records on logout, explicit destructive discard only, ownership metadata, quota handling, stale-sync recovery, multi-tab claim, pending status UI.
7. **Security** — API 429 with `Retry-After` on offline sync; production CSP without `unsafe-eval` (nonce assessment documented); `.env.pilot` → `.env.pilot.example`; dependency audit; remittance/daily-account correction assessment; refreshed findings register.
8. **Tests and release** — unit/integration tests, PostgreSQL offline/idempotency tests, typecheck/lint/build/audit, docs and delivery report.

## Verification

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm audit --audit-level=critical`
- `npm audit --omit=dev`
- PostgreSQL suite against a rehearsal database.
