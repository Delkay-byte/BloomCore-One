# Independent Tab Sessions

## Root cause

BloomCore One authenticated every request from a browser-wide cookie
(`bik-admin-session`, `bik-worker-session`, `bik-collector-session`,
`bik-customer-session`, `bik-platform-session`). Cookies are scoped to an
origin and a path, not to a tab. Every tab in the same browser profile
therefore presented the same credential; logging out deleted that one cookie
and signed every tab out. The previous `TabSessionGuard` only hid content in a
new tab until the shared cookie was checked, so copying the URL or calling an
API still used the shared identity. That was a presentation change, not an
authentication boundary.

## New transport

```
login action
  -> server validates credentials (+ MFA)
  -> server creates SessionRecord(jti, subject, module, expiry)
  -> server returns the signed token to the page that logged in
  -> page hands the token to its service worker
  -> worker stores it against this tab's client id (memory + IndexedDB)
  -> every same-origin request from this tab carries
       x-bloomcore-tab-session: <token>
  -> middleware and every server guard validate the header, then the
     SessionRecord registry
```

No authentication cookie is written or trusted in production. The cookie names
remain only to delete pre-migration cookies and for an explicit test-only
compatibility bridge (`ALLOW_LEGACY_COOKIE_SESSIONS=1`, set only by the Vitest
configs).

### Why a service worker

Server Components render on the server before page JavaScript runs. A token
kept only in `sessionStorage` therefore cannot authenticate the first document
request, and a cookie cannot identify a tab. A same-origin service worker is
the only browser mechanism that can attach a per-tab credential to:

- top-level navigations (including refresh),
- RSC/server-action requests,
- route-handler fetches,
- file downloads and streamed responses.

The worker uses `FetchEvent.clientId` and `FetchEvent.resultingClientId` to bind
the token to the tab's current document and to the document produced by its next
navigation. It removes any client-supplied copy of the header before adding its
own, so page script cannot choose another tab's identity.

## What each browser action does

| Action | Result |
|---|---|
| Log in, Tab A | New `SessionRecord`; token mapped to Tab A only |
| Open a new tab, any URL | No mapping for the new client id; middleware asks for sign-in |
| Copy an authenticated URL into a new tab | The URL contains no credential; new client has no mapping |
| `window.open` from an authenticated tab | New client id; no token is inherited |
| Refresh Tab A | Worker maps the resulting document to Tab A's token |
| Log out Tab A | Only Tab A's `jti` is revoked; its mapping is deleted |
| Revoke/expire Tab A's record | Tab A fails closed; Tab B's record is untouched |
| Different accounts in A and B | Different `jti`, subject and role resolved per request |
| Close Tab A | Mapping becomes unreachable; a new client id gets nothing |

## MFA

The MFA challenge is a five-minute signed token returned only to the tab that
submitted the password. It is held in that tab's `sessionStorage`, never in a
browser-wide cookie, and is explicitly rejected as a session. Completing MFA in
one tab returns the new session handle only to that tab.

## Security properties

- Server remains authoritative: header signature/audience, module capability,
  MFA policy, session timing and the `SessionRecord` registry are all checked
  per request.
- A token minted for one module cannot open another module. A platform token
  cannot open tenant routes and vice versa.
- Logout revokes exactly one server-side session. Guards never delete another
  tab's session.
- Tenant and role are resolved from the database, never from a browser-supplied
  user, role, tenant or branch id.
- No token in a URL, query string, fragment, `localStorage`, or cookie.
- Short absolute lifetime, inactivity lifetime, and immediate server-side
  revocation remain in force. Existing MFA, rate limiting, CSRF/origin checks,
  audit logging and tenant isolation are unchanged.

### Threat assessment: service-worker storage

The handle is stored in the worker's memory and in IndexedDB so a worker
restart does not sign the tab out. Same-origin JavaScript can read IndexedDB,
so an XSS on this origin could steal the handle, exactly as it could read a
non-HttpOnly tab credential. This is inherent to per-tab authentication, which
cannot use a browser-wide HttpOnly cookie. The worker also accepts a
registration message from any same-origin client; a script that can already
read the token can use it directly as a bearer header, so this does not widen
the XSS blast radius, but it is why strict CSP and output encoding matter.
Compensating controls:

- strict CSP and output encoding,
- short (8 hour) absolute session lifetime,
- server-side `jti` revocation on logout and password change,
- no handle in URLs, logs, DOM, `localStorage`, `sessionStorage`, or cookies,
- the worker overwrites the transport header on every request,
- persisted worker mappings are pruned after eight hours.

The alternative (a cookie) cannot satisfy tab isolation at all.

## Migration

1. Deploy the worker, header validation and login responses. Existing cookie
   sessions stop authenticating; users sign in once per tab.
2. Legacy cookies are deleted at next logout / session cleanup. They are never
   read by production code.
3. The Vitest configs enable `ALLOW_LEGACY_COOKIE_SESSIONS=1` so pre-existing
   cookie-seeded unit tests keep testing their original concern. Production and
   Playwright do not set it; the browser acceptance suite proves strict mode.

## Known browser boundary

Per-tab identity depends on service-worker client ids. Standard new-tab,
copied-URL, `window.open`, refresh and back/forward behaviour is covered by
`e2e/tab-sessions.spec.ts`. A hypothetical browser feature that cloned a live
service-worker client id into another window would need an additional
per-document nonce; no standard browser exposes that today. Private browsing
and browsers with service workers disabled cannot use this feature and must
sign in conventionally; they fail closed rather than sharing a cookie.
