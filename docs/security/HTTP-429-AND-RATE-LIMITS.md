# HTTP 429 and Rate Limiting — Current Semantics

**Date:** 2 November 2026

## Summary

| Surface | Rate limit | Literal HTTP 429 | Retry-After |
|---|---|---|---|
| Offline sync API (`POST /api/offline/sync-contribution`) | 120 records/minute per user | **Yes** | **Yes** |
| Login server actions | 20 attempts/15 min per IP + progressive 1/5/15-minute lockout | No (server action) | Structured wait in the refusal |
| Password recovery / reset actions | 5 requests and 10 submissions/15 min per IP | No (server action) | Structured wait |
| MFA verification | 10/IP and 5/subject per 10 min | No (server action) | Structured wait |
| Administrative mutations | 30/operator/10 min | No (server action) | Structured wait |
| Financial mutations | 60/subject/10 min | No (server action) | Structured wait |

## What changed

The offline synchronization endpoint now consumes a persistent per-user budget
before touching financial data. Exhaustion returns:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
Content-Type: application/json

{ "success": false, "error": "Too many synchronization attempts. Please wait and try again.", "retryAfterSeconds": 42 }
```

The sync manager reads `Retry-After`, keeps the record queued and does not
increment toward permanent failure. A normal route batch (well under 120
records) drains without hitting the limit; a runaway retry loop receives a real
429 instead of hammering the ledger.

## Why login remains a server action

Login is implemented as Next.js server actions. A server action returns a
serialized result to the React client; it does not expose a controllable HTTP
status for business refusals. Changing that means migrating the login forms to
route handlers and rewriting the session/cookie/MFA flow. That is a separate,
higher-risk change and is not required to keep the current protection: the
attempt is refused, no session is issued, and the message includes the
remaining wait.

Literal 429 compliance is therefore **partial** and is stated as such. It is not
claimed for server actions.

## Remaining work

1. Migrate login, recovery and MFA submissions to route handlers that return
   `401/403/429` with `Retry-After`.
2. Keep the same persistent counters and progressive lockout rules.
3. Preserve account-enumeration protection (constant work for unknown accounts).
4. Add UI countdowns driven by `retryAfterSeconds`.
5. Verify with the rate-limit tests in `tests/pg-offline-idempotency.test.ts` and
   `tests/security-hardening.test.ts`.

## Verification

- `tests/pg-offline-idempotency.test.ts` asserts 429 + a positive `Retry-After`
  from the offline sync route on PostgreSQL.
- `tests/offline-queue.test.ts` asserts the client keeps the record queued and
  respects the cooldown.
