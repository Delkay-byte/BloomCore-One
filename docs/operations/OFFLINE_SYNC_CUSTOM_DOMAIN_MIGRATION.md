# Offline sync — custom-domain migration

Date: 26 November 2026. Release HELD. Owner confirms the former Render
hostname is retired and `https://maacash.bloomcoretech.com` is official.

## Active destination (`Verified in code`)

`src/lib/offline/sync.ts` posts to same-origin relative paths
(`/api/offline/sync-contribution`, `/api/offline/momo-draft`,
`/api/offline/sync-request`) and probes `/api/health`. The service worker
operates on same-origin requests. No active component uses a hardcoded Render
API host. `src/lib/site.ts` centralises the canonical origin. No new host was
introduced; no Render setting was changed or reactivated.

## Changes made

- `src/components/LegacyMigrationClient.tsx`: removed the active link to the
  retired host. The canonical-origin branch now states plainly that old-origin
  IndexedDB cannot be read from this origin, that the former host is retired,
  and that stranded queues require a controlled owner recovery. It does not
  clear site data, delete queues, regenerate idempotency keys or mark records
  complete.
- `src/app/migrate/page.tsx`: updated wording to reflect retirement while
  preserving the migration entry point.

## Queue preservation

Offline records remain origin-scoped in IndexedDB. Changing the API base URL
does **not** migrate them, and this change never claims it does. The sync path
retains original record IDs, idempotency keys, tenant/user scoping and
server-acknowledgement-before-removal semantics. Existing offline queue tests
and idempotency tests remain in the suite.

## Existing installations

Three cases remain outside local control:

1. Client already on the custom domain — no legacy queue.
2. Queue already synchronised before retirement — no stranded records.
3. Queue still held on the retired origin — cannot be read from the new origin.
   Recovery requires user-assisted access to that origin. Since the owner
   retired it, recovery needs an explicit owner decision on a temporary,
   authenticated migration bridge. No such reactivation was performed.

Status: future traffic is custom-domain only; stranded legacy queues are an
**Owner action** if any device is affected.
