# Post-write RSC session transport — final investigation

Date: 25 November 2026. Release remains **HELD**. This finding is **NOT fixed**.

## Root cause (`Verified in code` + browser instrumentation)

A successful Server Action calling `revalidatePath` makes Next.js 16 re-render
the route. The RSC traffic has three distinct sources:

1. Router RSC refreshes issued through `window.fetch`. These can be intercepted
   by the service worker but were observed without tab headers in some cases.
2. Browser-initiated speculative router prefetches
   (`next-router-prefetch: 1`, `next-router-segment-prefetch: /_tree`). These
   bypass both page JavaScript and the service worker.
3. Redirect-followed RSC requests, which the service worker never sees.

A missing proof makes `verifyTabProof()` return null, `requireTenantContext()`
fail closed and the router navigate to `/admin/login?reason=tenant_unavailable`,
then forward to the dashboard. No authentication is bypassed and no data is
exposed, but the user loses workflow position.

## Safe changes implemented and verified

- `public/tab-session-sw.js`: `tab-proof-request` message signs a single-use
  proof for an exact method/path using the tab's non-extractable key.
- `src/lib/security/tab-session-client.ts`: narrow `installRscProofShim()`
  attaches a worker-signed proof only to same-origin RSC fetches that lack one.
  Other fetches pass untouched; no proof is invented without worker mapping.
- `src/lib/security/tab-proof.ts`: proof method/path bound to the real request
  using the signed path and Next's `next-url` (pathname comparison).
- `src/middleware.ts`: proof-less speculative prefetches get a data-free 404;
  real requests still fail closed through the normal guards.
- `src/lib/tenant.ts`: `requireTenantContext()` answers prefetches with
  `notFound()` instead of a login redirect.

`npx vitest run tests/rsc-proof-shim.test.ts` → **3/3 passed**.

## Evidence that the fix is incomplete

A dedicated browser regression reproduced the bounce after a policy write.
Instrumentation confirmed the shim attaches proofs to most RSC requests, but
the login bounce still occurs. The failing diagnostic spec was removed rather
than left failing or softened; no assertion was weakened. The defect remains
open and is documented, not claimed fixed.

## Status

**Still failing / Unverified fix.** Release remains HELD.
