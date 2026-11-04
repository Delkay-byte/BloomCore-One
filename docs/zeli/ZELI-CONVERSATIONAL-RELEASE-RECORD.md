# Zeli — Conversational Release Record

**Date:** 4 November 2026.
**Base:** `e176307` (production at the start of this work).
**Branch:** `feat/zeli-conversational-2026-11`.
**Status:** implementation complete and locally verified; production deployment
pending merge and Auto-Deploy.

## Scope

1. Code-level audit of the conversational implementation.
2. Local conversational layer: social acts, follow-up context, clarification,
   instruction refusal, income/expenses intent.
3. Separate, gated DeepSeek conversational adapter for non-financial messages.
4. Mode distinction in API headers and the workspace UI.
5. Tests and documentation, including the privacy decision pack.
6. Operational verification notes and the legacy-service assessment.

## Verification performed locally

| Check | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | pass |
| Lint (`eslint`) | 0 errors (pre-existing warnings only) |
| Unit and integration (`vitest run`) | see final count below |
| Production build (`next build --webpack`) | pass |
| Browser E2E (`e2e/zeli.spec.ts`, Chromium) | 7/7 pass |
| PostgreSQL suites | not run: the workspace Prisma client is generated from the SQLite schema and no PostgreSQL client was generated in this environment. CI must run `vitest --config vitest.pg.config.ts` with `PG_DATABASE_URL`. |
| Live external AI call | none: not approved; tests intercept `fetch` |
| Render/Neon dashboard checks | not performed: no credentials |

The E2E run used the locally built production server on port 3200 with the
dedicated E2E database. It exercised the local-mode banner, a supported business
answer, an unsupported general question, greeting plus follow-up context,
financial-instruction refusal, conversation rename/delete and tenant isolation.

## What did not change

- `PRODUCTION_PROVIDER_APPROVED` remains `false`.
- `PRODUCTION_CONVERSATION_APPROVED` is new and `false`.
- Emergency stop remains the default and overrides every mode.
- Global Zeli availability is untouched.
- No database migration was added.
- No production credential was read, printed or transmitted.
- Paystack configuration and webhook were untouched.

## Privacy position

Production external conversational processing is **not approved**. The decision
pack is a draft. The local assistant is fully functional without a provider key.
The workspace reports "Local mode" truthfully.

## Remaining owner actions

1. Review and sign the conversational privacy decision pack.
2. Decide the external-processing scope (non-financial only, as implemented).
3. Execute the production acceptance checklist.
4. Confirm Render logs for the expiry sweep and Neon recovery state.
5. Decide the legacy service transition.

## Deployment

Production SHA after merge and Auto-Deploy: _to be recorded_.

## Final test count

- Vitest: **538 passed** across **52 files** (0 failed).
- Playwright `e2e/zeli.spec.ts`: **7 passed**.
- Typecheck, lint and production build: pass.
