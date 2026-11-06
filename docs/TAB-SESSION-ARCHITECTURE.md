# Independent Tab Sessions

## Root cause

MaaCash authenticated every request from a browser-wide cookie
(`bik-admin-session`, `bik-worker-session`, `bik-collector-session`,
`bik-customer-session`, `bik-platform-session`). Cookies are scoped to an
origin and a path, not to a tab. Every tab in the same browser profile
therefore presented the same credential; logging out deleted that one cookie
and signed every tab out. The previous `TabSessionGuard` only hid content in a
new tab until the shared cookie was checked, so copying a URL or calling an API
still used the shared identity. That was a presentation change, not an
authentication boundary.

## New transport — proof of possession

```
login action
  -> server validates credentials (+ MFA)
  -> server creates SessionRecord(jti, subject, module, expiry)
  -> server returns the one-time login token to the page that logged in
  -> page posts the token to its service worker
  -> worker generates a non-extractable ECDSA P-256 key pair
  -> worker exchanges the public JWK at POST /api/auth/tab/enroll
  -> server creates TabCredential(sessionId, public JWK, payload)
  -> worker discards the login token
  -> every same-origin request carries
       x-bloomcore-tab-proof: <signed method/timestamp/nonce/credential>
       x-bloomcore-tab-assertion: <120-second route-gating JWT>
  -> every server data guard verifies the signature, nonce and SessionRecord
```

No authentication cookie is written or trusted in production. The cookie names
remain only to delete pre-migration cookies and for an explicit test-only
compatibility bridge (`ALLOW_LEGACY_COOKIE_SESSIONS=1`, set only by the Vitest
configs, and itself gated on `NODE_ENV=test`).

### Why a service worker

Server Components render before page JavaScript runs. A credential kept only in
`sessionStorage` cannot authenticate the first document request, and a cookie
cannot identify a tab. A same-origin service worker is the only browser
mechanism that can attach a per-tab proof to:

- top-level navigations (including refresh),
- RSC/server-action requests,
- route-handler fetches,
- file downloads and streamed responses.

The worker uses `FetchEvent.clientId` and `FetchEvent.resultingClientId` to bind
the credential to the tab's current document and the document produced by its
next navigation. It removes any client-supplied proof/assertion headers before
adding its own.

## What each browser action does

| Action | Result |
|---|---|
| Log in, Tab A | New `SessionRecord` + `TabCredential`; key mapped to Tab A only |
| Open a new tab, any URL | No key mapping; server rejects and asks for sign-in |
| Copy an authenticated URL | URL contains no credential; new client has no key |
| `window.open` from an authenticated tab | New client id; no proof is inherited |
| Refresh Tab A | Worker maps the resulting document to Tab A's key |
| Log out Tab A | Only Tab A's `jti` is revoked; its key mapping is deleted |
| Revoke/expire Tab A | Tab A fails closed; Tab B's record is untouched |
| Different accounts | Different `jti`, credential and role per request |
| Close Tab A | Mapping becomes unreachable; a new client id gets nothing |

## MFA

The MFA challenge is a five-minute signed token returned only to the tab that
submitted the password. It is held in that tab's `sessionStorage`, never in a
browser-wide cookie, and is explicitly rejected as a data session. Completion
returns the new login token only to that tab, which enrolls a fresh proof key.

## Security properties

- Server remains authoritative: proof signature, credential/session binding,
  single-use nonce, module capability, MFA policy, session timing and the
  `SessionRecord` registry are all checked per request.
- The 120-second assertion only gates routes; it is not accepted as a data
  credential.
- A credential minted for one module cannot open another. A platform credential
  cannot open tenant routes and vice versa.
- Logout revokes exactly one server-side session. Guards never delete another
  tab's session.
- Tenant and role are resolved from the database, never from browser input.
- No bearer token is stored in URL, query string, fragment, `localStorage`,
  `sessionStorage`, IndexedDB, Cache Storage or a cookie.
- Short absolute lifetime, inactivity lifetime, and immediate server-side
  revocation remain in force.

### Threat assessment: non-extractable keys

IndexedDB stores the ECDSA `CryptoKey` (generated with `extractable: false`),
`credentialId`, `sessionId` and module. It does **not** store the login token,
the JWT, raw key bytes or the signing secret. A same-origin XSS can still:

- read the CryptoKey handle from IndexedDB and call `crypto.subtle.sign` in real
  time, so it can make authenticated requests as that tab;
- invoke the service worker with arbitrary same-origin fetches.

It cannot:

- export the private key for use against another origin in the normal WebCrypto
  API;
- recover a reusable bearer token from storage, because none exists there;
- replay a captured proof after its nonce is consumed or after 90 seconds;
- use a credential for a different module or after the `SessionRecord` is
  revoked.

Non-extractable is therefore a real reduction in credential exfiltration, not
an XSS immunity claim. CSP, output encoding and server-side revocation remain
essential.

## Migration

1. Deploy the worker v2, `/api/auth/tab/enroll`, `/api/auth/tab/assertion`,
   `TabCredential` and `TabProofNonce`. The service-worker DB upgrade from v1
   deletes the old raw-token store.
2. Existing cookie sessions stop authenticating; users sign in once per tab.
3. Legacy cookies are deleted at next logout / session cleanup. They are never
   read by production code.
4. The Vitest configs enable `ALLOW_LEGACY_COOKIE_SESSIONS=1` so pre-existing
   cookie-seeded unit tests keep testing their original concern. Production and
   Playwright do not set it; the browser acceptance suite proves strict mode.

## Browser limits

Per-tab identity depends on service-worker client ids and WebCrypto. Standard
new-tab, copied-URL, `window.open`, refresh and normal worker lifecycle are
covered by `e2e/tab-sessions.spec.ts`. A forced worker termination before a
navigation fails closed to sign-in; it never adopts another tab's identity. A
hypothetical browser that cloned a live service-worker client id into another
window would need an additional per-document nonce; no standard browser exposes
that today. Browsers without service workers, IndexedDB or WebCrypto cannot use
this feature and are refused sign-in.

## Content Security Policy

The login and authenticated pages use a per-request nonce with
`script-src 'self' 'nonce-…' 'strict-dynamic'`, no `unsafe-inline` and no
`unsafe-eval` in production. `style-src` retains `unsafe-inline` because
Tailwind/React emit style attributes. The policy is emitted by middleware on
every dynamically rendered page; static configuration does not set it.
