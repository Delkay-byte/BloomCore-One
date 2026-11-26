# RSC session transport — final remediation

Date: 26 November 2026. Release remains **HELD** pending owner review.

## Root cause (`Verified in code` + browser trace)

Instrumenting the policy-write POST showed the redirect is raised inside the
Server Action request itself, not on a later navigation:

```
TENANT_REDIRECT_DIAG admin {
  prefetch: false, rsc: null, nextAction: '40d30f…',
  proof: 'yes', ver: '2', path: '/admin/policy'
}
```

The action succeeds, calls `revalidatePath`, and Next re-renders the route
inside the same browser request. `verifyTabProof()` had already consumed the
single-use nonce at the database key. The short-lived in-memory cache is a
React `cache()` scoped to one render; the re-render gets a fresh scope, so the
second verification saw a duplicate nonce, returned `null`,
`requireTenantContext()` failed closed and the router navigated to
`/admin/login?reason=tenant_unavailable`.

Earlier header shims were real improvements but did not address this cause.
They are retained: worker-signed proof broker, narrow RSC fetch shim,
method/path binding, and data-free 404 for proof-less speculative prefetches.

## Fix (`Verified in code`)

`src/lib/security/tab-proof.ts`: on a unique-key collision for a proof nonce,
re-verify instead of rejecting. Accept only when an existing `TabProofNonce`
row has the **same worker-issued `requestId`** and is unexpired. A different
request id is a replay and still fails. Cross-request replay, expired sessions,
revoked sessions and wrong-module proofs are unchanged.

This is idempotent within one browser request, not a weakening: the request id
comes from the service worker, not client-supplied identity.

## Browser evidence (`Verified live` local E2E)

`e2e/rsc-session-refresh.spec.ts` — 4/4 passed:

1. Policy write: no login request, no redirect, protected page stays visible,
   client navigation keeps the session, reload reads persisted value.
2. Worker, collector, customer and platform roles survive post-login RSC
   navigation.
3. Cleared session redirects to login; forged proof is refused; unauthenticated
   prefetch returns no protected data.
4. **Five consecutive policy writes in clean browser contexts** — zero bounces.

The diagnostic spec was removed only after the fix was proven; the permanent
regression spec above replaced it. No assertion was weakened.

Status: **Fixed and verified** locally. Production behaviour remains
`Unverified`; release still HELD.
